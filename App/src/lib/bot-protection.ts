/**
 * Bot and spam protection for the booking endpoints.
 *
 * Defense-in-depth, ordered cheapest-to-most-expensive:
 *   1. Origin validation against the per-tenant allowlist
 *   2. Honeypot field (hidden "website" input — must be empty)
 *   3. Time-to-submit guard (3 seconds minimum)
 *   4. Per-IP rate limiting via Azure Tables (5 bookings/min, 30 lookups/min)
 *
 * The honeypot and time-to-submit checks return a "silent success" sentinel
 * (`BotProtectionResult.SilentDrop`) so the detection method is not revealed
 * to the attacker. The handlers translate this into a 200 OK with an
 * apparently-successful body.
 *
 * Rate limiting uses a sliding-fixed-window approach (60-second window per
 * IP per action). Concurrent updates can cause a small over-count, which is
 * acceptable for this use case — perfect rate-limit accuracy is not the
 * goal; abuse prevention is.
 */

import { TableClient, TableServiceClient, odata } from '@azure/data-tables';
import { createHash } from 'node:crypto';
import type { HttpRequest } from '@azure/functions';
import { isOriginAllowed, type TenantConfig } from './tenant-config.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RateLimitAction = 'slots' | 'bookings';

/**
 * The configured rate limits per action, in requests per minute per IP.
 * Matches the WordPress plugin's defaults (v1.0.13).
 */
const RATE_LIMITS: Record<RateLimitAction, number> = {
  slots: 30,
  bookings: 5,
};

const RATE_LIMIT_WINDOW_MS = 60 * 1000;

/**
 * Minimum elapsed time between widget load and form submission.
 * Bots typically fire in milliseconds; humans need longer just to choose a
 * date/time and fill in contact details.
 */
const MIN_FORM_TIME_MS = 3000;

/** Name of the Azure Tables table used for rate-limit counters. */
const RATE_LIMIT_TABLE = 'rateLimits';

// ---------------------------------------------------------------------------
// Origin validation
// ---------------------------------------------------------------------------

/**
 * Returns true if the request's `Origin` header matches one of the tenant's
 * allowed origins (or the tenant has `"*"` in its allowlist).
 *
 * The handler should reject the request with 403 if this returns false.
 * Browser-enforced CORS provides a second layer of defense, but server-side
 * validation here ensures non-browser clients can't bypass it.
 */
export function validateOrigin(tenant: TenantConfig, request: HttpRequest): boolean {
  const origin = request.headers.get('origin');
  return isOriginAllowed(tenant, origin);
}

// ---------------------------------------------------------------------------
// Honeypot
// ---------------------------------------------------------------------------

/**
 * Returns true if the honeypot field is empty (legitimate request) or false
 * if it has any value (almost certainly a bot).
 *
 * The hidden input is named `website` in the form. Real users never see it
 * and never fill it in. Bots that auto-fill every form field they see do.
 *
 * Handlers should respond to a `false` return with a "silent success"
 * (200 OK + `{ success: true }`) rather than an error so the detection
 * method is not revealed.
 */
export function checkHoneypot(body: Record<string, unknown>): boolean {
  const website = body.website;
  if (typeof website !== 'string') {
    // The field is optional in the schema; an absent or non-string value
    // means no bot tampering. Allow.
    return true;
  }
  return website.trim() === '';
}

// ---------------------------------------------------------------------------
// Time-to-submit
// ---------------------------------------------------------------------------

/**
 * Returns true if at least `MIN_FORM_TIME_MS` elapsed between widget load
 * and form submission. Returns false (suspicious) only when the widget
 * sent a positive `formLoadedMs` value that is too small.
 *
 * If `formLoadedMs` is missing, zero, or otherwise unparseable, the check
 * passes — this preserves backward compatibility and avoids false-positives
 * from legitimate clients that don't include the field for any reason.
 *
 * Handlers should respond to a `false` return with a silent success, same
 * as the honeypot.
 */
export function checkTimeToSubmit(body: Record<string, unknown>): boolean {
  const raw = body.formLoadedMs;
  const elapsed = typeof raw === 'number' ? raw : parseInt(String(raw ?? '0'), 10);
  if (!Number.isFinite(elapsed) || elapsed <= 0) {
    return true;
  }
  return elapsed >= MIN_FORM_TIME_MS;
}

// ---------------------------------------------------------------------------
// Rate limiting (Azure Tables)
// ---------------------------------------------------------------------------

interface RateLimitEntity {
  partitionKey: string;
  rowKey: string;
  count: number;
  windowStartTimestamp: number;
}

let cachedTableClient: TableClient | null = null;
let tableEnsured = false;

/**
 * Returns the TableClient for the rate-limit table, creating the table on
 * first use. Idempotent — repeated calls reuse the cached client.
 */
async function getRateLimitTable(): Promise<TableClient> {
  if (cachedTableClient && tableEnsured) {
    return cachedTableClient;
  }

  const connectionString = process.env.AzureWebJobsStorage;
  if (!connectionString) {
    throw new Error(
      'AzureWebJobsStorage is not set. ' +
        'Rate limiting requires the Functions runtime storage connection.'
    );
  }

  if (!cachedTableClient) {
    cachedTableClient = TableClient.fromConnectionString(
      connectionString,
      RATE_LIMIT_TABLE,
      { allowInsecureConnection: connectionString.startsWith('UseDevelopmentStorage') }
    );
  }

  if (!tableEnsured) {
    // Idempotent: if the table exists, this resolves silently.
    try {
      const serviceClient = TableServiceClient.fromConnectionString(connectionString, {
        allowInsecureConnection: connectionString.startsWith('UseDevelopmentStorage'),
      });
      await serviceClient.createTable(RATE_LIMIT_TABLE);
    } catch (err: unknown) {
      // 409 Conflict = table already exists; that's fine.
      const status = (err as { statusCode?: number })?.statusCode;
      if (status !== 409) {
        throw err;
      }
    }
    tableEnsured = true;
  }

  return cachedTableClient;
}

/**
 * Hashes a client IP for use as a row key. SHA-256 truncated to 32 hex
 * chars (sufficient to avoid table-key collisions; not for cryptographic
 * authentication). Hashing avoids storing raw IPs in case the table is
 * ever exported for support purposes.
 */
function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').substring(0, 32);
}

/**
 * Checks and increments the rate-limit counter for an `(action, ip)` pair.
 * Returns true if the request is allowed, false if it should be blocked.
 *
 * Implementation: read the counter, check whether its window is still
 * active, and write back. If the window has expired (or the entity does
 * not exist yet), reset to count=1 and start a new window. Concurrent
 * updates can cause a small over-count under burst load; that's
 * acceptable for the use case.
 *
 * On any unexpected storage error, this function logs the error and
 * returns true (allow). Failing closed (block all requests) when the
 * storage backend is unhealthy would be worse than the brief loss of
 * rate-limit enforcement.
 */
export async function checkRateLimit(
  action: RateLimitAction,
  ip: string
): Promise<boolean> {
  if (!ip || ip === 'unknown') {
    // Without a usable IP we can't enforce per-IP limits. Allow rather
    // than blocking everyone behind an unknown-IP proxy.
    return true;
  }

  const partitionKey = action;
  const rowKey = hashIp(ip);
  const now = Date.now();
  const limit = RATE_LIMITS[action];

  let table: TableClient;
  try {
    table = await getRateLimitTable();
  } catch (err) {
    console.error('[bot-protection] failed to acquire rate-limit table:', err);
    return true; // fail-open
  }

  let entity: RateLimitEntity | null = null;
  try {
    entity = await table.getEntity<RateLimitEntity>(partitionKey, rowKey);
  } catch (err: unknown) {
    const status = (err as { statusCode?: number })?.statusCode;
    if (status !== 404) {
      console.error('[bot-protection] rate-limit read failed:', err);
      return true; // fail-open
    }
    // 404 = no entity yet, which is fine — first request in this window.
  }

  const windowExpired = !entity || now - entity.windowStartTimestamp > RATE_LIMIT_WINDOW_MS;

  if (windowExpired) {
    // First request in a new window.
    try {
      await table.upsertEntity(
        {
          partitionKey,
          rowKey,
          count: 1,
          windowStartTimestamp: now,
        },
        'Replace'
      );
    } catch (err) {
      console.error('[bot-protection] rate-limit write failed:', err);
    }
    return true;
  }

  // Window still active.
  if (entity!.count >= limit) {
    return false;
  }

  try {
    await table.upsertEntity(
      {
        partitionKey,
        rowKey,
        count: entity!.count + 1,
        windowStartTimestamp: entity!.windowStartTimestamp,
      },
      'Replace'
    );
  } catch (err) {
    console.error('[bot-protection] rate-limit increment failed:', err);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Client IP extraction
// ---------------------------------------------------------------------------

/**
 * Returns the originating client IP, accounting for Azure App Service's
 * X-Forwarded-For proxy header. If the header is missing or unparseable,
 * returns the literal string "unknown" — callers should treat that as a
 * non-rate-limitable request.
 *
 * The X-Forwarded-For header on Azure App Service is a comma-separated
 * list with the original client IP first. Each entry can include a port
 * (`1.2.3.4:5678`) which we strip. IPv6 addresses are supported.
 */
export function getClientIp(request: HttpRequest): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) {
      return stripPort(first);
    }
  }
  // Fallback: some proxies use a different header.
  const real = request.headers.get('x-real-ip');
  if (real) {
    return stripPort(real.trim());
  }
  return 'unknown';
}

function stripPort(addr: string): string {
  // IPv6 addresses are enclosed in brackets when port-bearing: [::1]:5678.
  if (addr.startsWith('[')) {
    const end = addr.indexOf(']');
    return end === -1 ? addr : addr.substring(1, end);
  }
  // IPv4: split on the last colon if there are exactly two segments.
  const parts = addr.split(':');
  if (parts.length === 2) {
    return parts[0];
  }
  // Bare IPv6 (multiple colons, no brackets, no port).
  return addr;
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

/** Test-only: clears the cached table client so tests can use a fresh one. */
export function _resetTableClientForTests(): void {
  cachedTableClient = null;
  tableEnsured = false;
}

/** Re-export for type-safe imports in handlers. */
export { odata };
