/**
 * POST /api/bookings
 *
 * Creates a Microsoft Bookings appointment for the specified tenant. The
 * widget submits the visitor's contact info, the chosen start time, and
 * the visitor's local timezone. Microsoft Bookings sends the confirmation
 * email and meeting invite.
 *
 * Request body (JSON):
 *   {
 *     "tenant":            "unified-support",            (required)
 *     "firstName":         "Ada",                         (required)
 *     "lastName":          "Lovelace",                    (required)
 *     "email":             "ada@example.com",             (required, valid email)
 *     "phone":             "+1 555 1212",                 (optional)
 *     "company":           "Analytical Engines Inc.",     (optional)
 *     "notes":             "Looking forward to it.",      (optional)
 *     "startTime":         "2026-05-22T14:00:00Z",        (required, ISO 8601 UTC, future, < 60 days)
 *     "customerTimezone":  "America/New_York",            (optional, IANA; defaults to UTC)
 *     "website":           "",                            (honeypot — must be empty/absent)
 *     "formLoadedMs":      37250                          (optional time-to-submit in ms)
 *   }
 *
 * Response (200):
 *   {
 *     "success": true,
 *     "start":   "2026-05-22T14:00:00Z",
 *     "joinUrl": "https://teams.microsoft.com/l/meetup-join/..."
 *   }
 *
 * Bot-protection failures (honeypot tripped, time-to-submit too fast)
 * return a "silent success" 200 with `{ "success": true }` to avoid
 * revealing the detection method.
 *
 * Errors:
 *   400 — invalid request body, missing required field, invalid email/time
 *   403 — origin not allowed for this tenant
 *   404 — tenant slug not configured
 *   429 — per-IP rate limit exceeded
 *   503 — Microsoft Graph unavailable
 */

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { findTenantBySlug } from '../lib/tenant-config.js';
import { createAppointment, GraphApiError } from '../lib/graph-client.js';
import {
  validateOrigin,
  checkHoneypot,
  checkTimeToSubmit,
  checkRateLimit,
  getClientIp,
} from '../lib/bot-protection.js';

app.http('CreateBooking', {
  methods: ['POST'],
  route: 'api/bookings',
  authLevel: 'anonymous',
  handler: createBookingHandler,
});

export async function createBookingHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  // 1. Parse and shallow-validate the body.
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse(400, {
      error: 'invalid_body',
      message: 'Request body must be valid JSON.',
    });
  }
  if (typeof body !== 'object' || body === null) {
    return jsonResponse(400, {
      error: 'invalid_body',
      message: 'Request body must be a JSON object.',
    });
  }

  // 2. Resolve tenant.
  const slug = typeof body.tenant === 'string' ? body.tenant : '';
  if (!slug) {
    return jsonResponse(400, {
      error: 'missing_tenant',
      message: 'The "tenant" field is required.',
    });
  }
  const tenant = findTenantBySlug(slug);
  if (!tenant) {
    return jsonResponse(404, {
      error: 'unknown_tenant',
      message: 'No booking configuration matches the requested tenant.',
    });
  }
  const corsOrigin = tenant.allowedOrigins.includes('*')
    ? '*'
    : request.headers.get('origin') ?? undefined;

  // 3. Origin allowlist.
  if (!validateOrigin(tenant, request)) {
    context.warn(
      `[CreateBooking] origin not allowed for tenant "${tenant.slug}":`,
      request.headers.get('origin') ?? '(none)'
    );
    return jsonResponse(403, {
      error: 'origin_not_allowed',
      message: 'This origin is not permitted to use the requested tenant.',
    });
  }

  // 4. Bot-protection layers (honeypot, time-to-submit). On either
  // failure, return a "silent success" so the detection method is not
  // revealed. Rate-limit follows because it's the most expensive check.
  if (!checkHoneypot(body)) {
    context.info(`[CreateBooking] honeypot triggered (tenant "${tenant.slug}"); silent success.`);
    return jsonResponse(200, { success: true }, corsOrigin);
  }
  if (!checkTimeToSubmit(body)) {
    context.info(
      `[CreateBooking] time-to-submit too fast (tenant "${tenant.slug}"); silent success.`
    );
    return jsonResponse(200, { success: true }, corsOrigin);
  }

  // 5. Per-IP rate limit.
  const ip = getClientIp(request);
  const allowed = await checkRateLimit('bookings', ip);
  if (!allowed) {
    return jsonResponse(
      429,
      {
        error: 'rate_limited',
        message: 'Too many requests. Please try again shortly.',
      },
      corsOrigin
    );
  }

  // 6. Validate booking payload.
  const validated = validateBookingInput(body);
  if (!validated.ok) {
    return jsonResponse(400, { error: validated.error, message: validated.message }, corsOrigin);
  }

  // 7. Create the appointment via Microsoft Graph.
  try {
    const result = await createAppointment(tenant, {
      firstName: validated.value.firstName,
      lastName: validated.value.lastName,
      email: validated.value.email,
      phone: validated.value.phone,
      company: validated.value.company,
      notes: validated.value.notes,
      startTime: validated.value.startTime,
      customerTimezone: validated.value.customerTimezone,
    });
    return jsonResponse(
      200,
      {
        success: true,
        start: result.start,
        joinUrl: result.joinUrl,
      },
      corsOrigin
    );
  } catch (err) {
    return handleGraphError(err, context, tenant.slug, corsOrigin);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ValidatedBookingInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company: string;
  notes: string;
  startTime: string;
  customerTimezone: string;
}

type ValidationOutcome =
  | { ok: true; value: ValidatedBookingInput }
  | { ok: false; error: string; message: string };

function validateBookingInput(body: Record<string, unknown>): ValidationOutcome {
  const firstName = sanitizeString(body.firstName, 100);
  const lastName = sanitizeString(body.lastName, 100);
  const email = sanitizeString(body.email, 320);
  const phone = sanitizeString(body.phone, 50);
  const company = sanitizeString(body.company, 200);
  const notes = sanitizeMultilineString(body.notes, 4000);
  const startTime = sanitizeString(body.startTime, 64);
  const customerTimezone = sanitizeString(body.customerTimezone, 64) || 'UTC';

  if (!firstName) {
    return missing('firstName');
  }
  if (!lastName) {
    return missing('lastName');
  }
  if (!email || !isValidEmail(email)) {
    return { ok: false, error: 'invalid_email', message: 'A valid email address is required.' };
  }
  if (!startTime || !isValidFutureDateTime(startTime)) {
    return {
      ok: false,
      error: 'invalid_time',
      message: 'A valid appointment time is required.',
    };
  }
  if (!isValidIanaTimezone(customerTimezone)) {
    // Don't reject — fall back to UTC. The visitor's calendar invite will be in UTC,
    // but the booking will succeed.
    return {
      ok: true,
      value: {
        firstName,
        lastName,
        email,
        phone,
        company,
        notes,
        startTime,
        customerTimezone: 'UTC',
      },
    };
  }

  return {
    ok: true,
    value: { firstName, lastName, email, phone, company, notes, startTime, customerTimezone },
  };
}

function sanitizeString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim().substring(0, maxLength);
}

function sanitizeMultilineString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  // Allow newlines in notes; strip other control chars.
  return value
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .trim()
    .substring(0, maxLength);
}

function isValidEmail(email: string): boolean {
  // RFC 5321 maximum length; basic shape check. Not a full RFC parser —
  // Microsoft Bookings rejects malformed emails anyway.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320;
}

function isValidFutureDateTime(iso: string): boolean {
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return false;
  const now = Date.now();
  const max = now + 90 * 24 * 60 * 60 * 1000; // 90 days; tenant-level maxAdvance applies separately
  const ts = dt.getTime();
  return ts > now && ts < max;
}

function isValidIanaTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function missing(field: string): ValidationOutcome {
  return {
    ok: false,
    error: 'missing_field',
    message: `Required field "${field}" is missing.`,
  };
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function jsonResponse(
  status: number,
  body: unknown,
  allowOrigin?: string
): HttpResponseInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  if (allowOrigin) {
    headers['Access-Control-Allow-Origin'] = allowOrigin;
    headers['Vary'] = 'Origin';
  }
  return {
    status,
    headers,
    body: JSON.stringify(body),
  };
}

function handleGraphError(
  err: unknown,
  context: InvocationContext,
  slug: string,
  corsOrigin: string | undefined
): HttpResponseInit {
  if (err instanceof GraphApiError) {
    context.error(
      `[CreateBooking] Graph API error for tenant "${slug}" ` +
        `(status ${err.status}, code ${err.graphCode ?? 'unknown'}):`,
      err.message
    );
    return jsonResponse(
      503,
      {
        error: 'graph_unavailable',
        message: 'Unable to complete your booking. Please try again.',
      },
      corsOrigin
    );
  }

  context.error(`[CreateBooking] unexpected error for tenant "${slug}":`, err);
  return jsonResponse(
    500,
    {
      error: 'internal_error',
      message: 'An unexpected error occurred. Please try again.',
    },
    corsOrigin
  );
}
