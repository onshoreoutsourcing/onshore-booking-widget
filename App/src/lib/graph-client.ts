/**
 * Microsoft Graph client for the Bookings API.
 *
 * Authenticates via the Functions App's system-assigned Managed Identity
 * (no client secret, no Key Vault). Token acquisition and refresh are
 * handled by `@azure/identity` transparently.
 *
 * Algorithmic port of the WordPress plugin's `class-graph-client.php`
 * (v1.0.13). Key differences:
 *   - Managed Identity instead of client-credentials with secret
 *   - In-process per-tenant caching instead of WordPress transients
 *   - Per-tenant configuration (multi-tenant) instead of a single hardcoded
 *     business ID
 *
 * The slot-generation algorithm is the same as the source plugin:
 *   1. Fetch staff IDs (cached) — required by getStaffAvailability
 *   2. Fetch the bookingBusiness object (cached) for the General
 *      Availability schedule, lead time, slot interval, and max advance
 *   3. Call getStaffAvailability to retrieve per-staff free/busy windows
 *   4. Subdivide each `available` window into slots aligned to the
 *      configured slot interval
 *   5. Reject slots inside the lead-time window, outside the look-ahead
 *      window, conflicting with `busy` intervals, or outside the General
 *      Availability schedule
 *   6. Group remaining slots by date in the business timezone
 */

import { DefaultAzureCredential, type AccessToken } from '@azure/identity';
import type { TenantConfig } from './tenant-config.js';
import {
  parseBusinessSchedule,
  slotWithinSchedule,
  formatDateInZone,
  type BookingBusinessResponse,
  type BusinessSchedule,
} from './schedule.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

/** In-memory cache TTL for staff IDs and business schedule, in milliseconds. */
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Default slot duration when the business doesn't expose timeSlotInterval. */
const DEFAULT_SLOT_MINUTES = 30;

/**
 * Default look-ahead window for slot fetches, in days.
 *
 * The actual window shown to visitors is the smaller of this value and the
 * tenant's Bookings `maximumAdvance` setting (typically P60D / 60 days).
 * 90 here means we don't artificially cap below what Bookings allows; the
 * Bookings setting is the real ceiling.
 */
const DEFAULT_DAYS_AHEAD = 90;

/**
 * Maximum window passed to a single getStaffAvailability call, in days.
 *
 * Microsoft Graph's getStaffAvailability endpoint has an undocumented cap on
 * how wide a single (startDateTime, endDateTime) range can be. Empirically
 * this has been in the 30-42 day range; values above that produce 5xx
 * errors. We stay at 30 with a safety margin and fan out into multiple
 * parallel calls when the requested window exceeds this.
 */
const STAFF_AVAILABILITY_CHUNK_DAYS = 30;

/**
 * Single shared credential instance. `DefaultAzureCredential` falls through
 * a chain of authentication strategies: in production on a Functions App,
 * it picks up the system-assigned Managed Identity; in local development
 * it falls back to `az login` credentials or the AZURE_* environment
 * variables.
 */
const credential = new DefaultAzureCredential();

/** Cached access token. `@azure/identity` handles refresh internally. */
let cachedToken: AccessToken | null = null;

interface TenantCache {
  staffIds?: { value: string[]; expiresAt: number };
  schedule?: { value: BusinessSchedule | null; expiresAt: number };
}

const tenantCaches: Map<string, TenantCache> = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Booking time slots for a tenant, grouped by date.
 *
 * Keys are "YYYY-MM-DD" in the business timezone. Values are arrays of
 * ISO 8601 UTC datetime strings representing slot starts. The widget
 * converts these to the visitor's local timezone for display.
 */
export type SlotMap = Record<string, string[]>;

/**
 * Returns available booking slots for the next `daysAhead` calendar days.
 *
 * The actual look-ahead window is the smaller of `daysAhead` and the
 * tenant's `maximumAdvance` setting. The earliest bookable moment is
 * `now + tenant.minimumLeadTime`.
 *
 * Slots are aligned to the tenant's configured `timeSlotInterval` (typically
 * 30 minutes). A slot is bookable when at least one staff member is
 * `available` for the entire slot AND not `busy` AND the slot falls inside
 * the tenant's General Availability window for the day.
 */
export async function getAvailableSlots(
  tenant: TenantConfig,
  daysAhead: number = DEFAULT_DAYS_AHEAD
): Promise<SlotMap> {
  const staffIds = await getStaffIds(tenant);
  if (staffIds.length === 0) {
    // No staff configured for this Bookings business — return an empty
    // map rather than erroring. The widget shows "no times available".
    return {};
  }

  let schedule: BusinessSchedule | null = null;
  try {
    schedule = await getBusinessSchedule(tenant);
  } catch (err) {
    // Soft-fail: better to show too many slots than to hard-error a
    // visitor at the moment they want to book. Logged for operators.
    console.error(
      `[graph-client] getBusinessSchedule failed for tenant "${tenant.slug}":`,
      err
    );
    schedule = null;
  }

  const leadTimeSeconds = schedule?.leadTimeSeconds ?? 0;
  const slotIntervalSeconds = schedule?.slotIntervalSeconds && schedule.slotIntervalSeconds > 0
    ? schedule.slotIntervalSeconds
    : DEFAULT_SLOT_MINUTES * 60;
  const slotDurationMs = slotIntervalSeconds * 1000;

  const now = new Date();
  const earliest = new Date(now.getTime() + leadTimeSeconds * 1000);

  // Look-ahead window: capped by maxAdvance if shorter than daysAhead.
  let windowEnd = new Date(now);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + daysAhead);
  windowEnd.setUTCHours(23, 59, 59, 999);
  if (schedule?.maxAdvanceSeconds && schedule.maxAdvanceSeconds > 0) {
    const graphMaxEnd = new Date(now.getTime() + schedule.maxAdvanceSeconds * 1000);
    if (graphMaxEnd < windowEnd) {
      windowEnd = graphMaxEnd;
    }
  }

  const availability = await fetchStaffAvailabilityChunked(
    tenant,
    staffIds,
    now,
    windowEnd
  );

  return buildSlots(availability, earliest, windowEnd, slotDurationMs, schedule);
}

export interface CreateAppointmentInput {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  company?: string;
  notes?: string;
  /** ISO 8601 UTC string. */
  startTime: string;
  /** IANA timezone for the customer (e.g. "America/Chicago"). */
  customerTimezone: string;
}

export interface CreateAppointmentResult {
  /** Microsoft Graph appointment ID. */
  id: string;
  /** Echo of the input start time. */
  start: string;
  /** Microsoft Teams join URL, or "" if not produced. */
  joinUrl: string;
}

/**
 * Creates a Microsoft Bookings appointment for the given tenant.
 *
 * The customer's timezone is captured from the browser and passed through
 * so Bookings formats confirmation emails and calendar invites in the
 * visitor's local zone.
 *
 * Company, when provided, is prepended to the notes field — Bookings
 * customQuestions are not used, to avoid coupling the plugin to a
 * specific custom-question OID configuration on the Bookings business.
 *
 * All configured staff members are assigned to the appointment via
 * staffMemberIds so the meeting appears on every staff calendar. If staff
 * ID retrieval fails at create time, the assignment is omitted and
 * Bookings falls back to its service-level assignment policy.
 */
export async function createAppointment(
  tenant: TenantConfig,
  input: CreateAppointmentInput
): Promise<CreateAppointmentResult> {
  const startDt = new Date(input.startTime);
  if (isNaN(startDt.getTime())) {
    throw new Error('Invalid startTime; must be an ISO 8601 UTC datetime string.');
  }

  // Determine slot duration from the tenant's schedule if available;
  // fall back to 30 minutes (matches the existing plugin's behavior).
  let slotMinutes = DEFAULT_SLOT_MINUTES;
  try {
    const schedule = await getBusinessSchedule(tenant);
    if (schedule?.slotIntervalSeconds && schedule.slotIntervalSeconds > 0) {
      slotMinutes = Math.round(schedule.slotIntervalSeconds / 60);
    }
  } catch {
    // schedule fetch already logged in getAvailableSlots; here it's non-fatal
  }

  const endDt = new Date(startDt.getTime() + slotMinutes * 60 * 1000);
  const customerTz = input.customerTimezone || 'UTC';

  // Best-effort staff assignment — non-fatal if it fails.
  let staffIds: string[] = [];
  try {
    staffIds = await getStaffIds(tenant);
  } catch (err) {
    console.warn(
      `[graph-client] getStaffIds failed for tenant "${tenant.slug}"; ` +
        'creating appointment without staffMemberIds:',
      err
    );
  }

  // Notes: prepend company if present.
  let notes = (input.notes ?? '').trim();
  if (input.company && input.company.trim() !== '') {
    const companyLine = `Company: ${input.company.trim()}`;
    notes = notes ? `${companyLine}\n\n${notes}` : companyLine;
  }

  const body: Record<string, unknown> = {
    serviceId: tenant.serviceId,
    isLocationOnline: true,
    customerTimeZone: customerTz,
    startDateTime: { dateTime: formatGraphDateTime(startDt), timeZone: 'UTC' },
    endDateTime: { dateTime: formatGraphDateTime(endDt), timeZone: 'UTC' },
    customers: [
      {
        '@odata.type': '#microsoft.graph.bookingCustomerInformation',
        name: `${input.firstName} ${input.lastName}`.trim(),
        emailAddress: input.email,
        phone: input.phone ?? '',
        notes,
        timeZone: customerTz,
      },
    ],
  };

  if (staffIds.length > 0) {
    body.staffMemberIds = staffIds;
  }

  const result = await graphRequest<{ id?: string; onlineMeetingUrl?: string }>(
    'POST',
    `/solutions/bookingBusinesses/${encodeURIComponent(tenant.businessId)}/appointments`,
    body
  );

  return {
    id: result.id ?? '',
    start: input.startTime,
    joinUrl: result.onlineMeetingUrl ?? '',
  };
}

/**
 * Clears the in-process caches for a single tenant. Used by an
 * admin-triggered cache-clear mechanism (or by tests).
 */
export function clearTenantCache(slug: string): boolean {
  return tenantCaches.delete(slug);
}

/**
 * Clears the in-process caches for ALL tenants. Equivalent to a Functions
 * App restart for cache purposes (but keeps the process running).
 */
export function clearAllTenantCaches(): void {
  tenantCaches.clear();
}

// ---------------------------------------------------------------------------
// Internal: token + HTTP
// ---------------------------------------------------------------------------

async function getAccessToken(): Promise<string> {
  // `@azure/identity` returns tokens with a 5-minute pre-expiration buffer
  // already applied; we still double-check to be safe.
  const fiveMinutesFromNow = Date.now() + 5 * 60 * 1000;
  if (cachedToken && cachedToken.expiresOnTimestamp > fiveMinutesFromNow) {
    return cachedToken.token;
  }

  const token = await credential.getToken(GRAPH_SCOPE);
  if (!token) {
    throw new Error(
      'Failed to acquire Microsoft Graph access token. ' +
        'Verify that the Functions App has a system-assigned Managed Identity ' +
        'and that BookingsAppointment.ReadWrite.All has been granted to it ' +
        '(see Infra/scripts/grant-graph-permissions.ps1).'
    );
  }
  cachedToken = token;
  return token.token;
}

interface GraphErrorResponse {
  error?: {
    code?: string;
    message?: string;
  };
}

/**
 * Custom error type for Microsoft Graph failures. Carries the HTTP status
 * and the Graph-side error code so handlers can map specific errors to
 * specific user-facing messages or log routing.
 */
export class GraphApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly graphCode?: string
  ) {
    super(message);
    this.name = 'GraphApiError';
  }
}

async function graphRequest<T>(
  method: 'GET' | 'POST',
  endpoint: string,
  body?: unknown
): Promise<T> {
  const token = await getAccessToken();
  const response = await fetch(`${GRAPH_BASE}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // Non-JSON response. Leave as null; the error path handles it.
    }
  }

  if (!response.ok) {
    const errBody = data as GraphErrorResponse | null;
    const message = errBody?.error?.message ?? `Microsoft Graph API error (HTTP ${response.status}).`;
    throw new GraphApiError(message, response.status, errBody?.error?.code);
  }

  return (data ?? {}) as T;
}

// ---------------------------------------------------------------------------
// Internal: cached fetches
// ---------------------------------------------------------------------------

function getCacheBucket(slug: string): TenantCache {
  let bucket = tenantCaches.get(slug);
  if (!bucket) {
    bucket = {};
    tenantCaches.set(slug, bucket);
  }
  return bucket;
}

async function getStaffIds(tenant: TenantConfig): Promise<string[]> {
  const cache = getCacheBucket(tenant.slug);
  if (cache.staffIds && cache.staffIds.expiresAt > Date.now()) {
    return cache.staffIds.value;
  }

  const response = await graphRequest<{ value?: Array<{ id?: string }> }>(
    'GET',
    `/solutions/bookingBusinesses/${encodeURIComponent(tenant.businessId)}/staffMembers`
  );

  const ids = (response.value ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  cache.staffIds = { value: ids, expiresAt: Date.now() + CACHE_TTL_MS };
  return ids;
}

async function getBusinessSchedule(tenant: TenantConfig): Promise<BusinessSchedule | null> {
  const cache = getCacheBucket(tenant.slug);
  if (cache.schedule && cache.schedule.expiresAt > Date.now()) {
    return cache.schedule.value;
  }

  const business = await graphRequest<BookingBusinessResponse>(
    'GET',
    `/solutions/bookingBusinesses/${encodeURIComponent(tenant.businessId)}`
  );

  const schedule = parseBusinessSchedule(business);
  cache.schedule = { value: schedule, expiresAt: Date.now() + CACHE_TTL_MS };
  return schedule;
}

// ---------------------------------------------------------------------------
// Internal: slot generation
// ---------------------------------------------------------------------------

interface GetStaffAvailabilityResponse {
  value?: Array<{
    availabilityItems?: Array<{
      status: string; // "available" | "busy" | "tentative" | "outOfOffice" | "workingElsewhere"
      startDateTime: { dateTime: string; timeZone: string };
      endDateTime: { dateTime: string; timeZone: string };
    }>;
  }>;
}

interface DateRange {
  start: Date;
  end: Date;
}

/**
 * Fetches staff availability over a window that may exceed Microsoft Graph's
 * per-call limit by fanning out into parallel chunked calls and merging the
 * results.
 *
 * Each chunk covers at most STAFF_AVAILABILITY_CHUNK_DAYS days. Calls are
 * issued in parallel via Promise.all; the merged response concatenates each
 * staff member's availabilityItems across chunks. Staff order is consistent
 * across calls because the same staffIds array is sent in every request.
 *
 * If the requested window is already within the chunk size, this collapses
 * to a single Graph call (no overhead vs. the unchunked version).
 */
async function fetchStaffAvailabilityChunked(
  tenant: TenantConfig,
  staffIds: string[],
  start: Date,
  end: Date
): Promise<GetStaffAvailabilityResponse> {
  const chunkMs = STAFF_AVAILABILITY_CHUNK_DAYS * 24 * 60 * 60 * 1000;

  // Build the (chunkStart, chunkEnd) tuples covering [start, end].
  const chunks: DateRange[] = [];
  let cursor = start;
  while (cursor < end) {
    const chunkEnd = new Date(Math.min(cursor.getTime() + chunkMs, end.getTime()));
    chunks.push({ start: cursor, end: chunkEnd });
    cursor = chunkEnd;
  }

  // Fetch all chunks in parallel.
  const responses = await Promise.all(
    chunks.map((c) =>
      graphRequest<GetStaffAvailabilityResponse>(
        'POST',
        `/solutions/bookingBusinesses/${encodeURIComponent(tenant.businessId)}/getStaffAvailability`,
        {
          staffIds,
          startDateTime: { dateTime: formatGraphDateTime(c.start), timeZone: 'UTC' },
          endDateTime: { dateTime: formatGraphDateTime(c.end), timeZone: 'UTC' },
        }
      )
    )
  );

  // Single chunk: nothing to merge.
  if (responses.length <= 1) {
    return responses[0] ?? { value: [] };
  }

  // Merge: concatenate availabilityItems for each staff member across chunks.
  // Graph returns staff in the same order as the input staffIds, so index
  // alignment across responses is reliable.
  const numStaff = responses[0].value?.length ?? 0;
  const merged: GetStaffAvailabilityResponse = { value: [] };

  for (let i = 0; i < numStaff; i++) {
    type StaffEntry = NonNullable<GetStaffAvailabilityResponse['value']>[number];
    type AvailabilityItems = NonNullable<StaffEntry['availabilityItems']>;
    const allItems: AvailabilityItems = [];
    for (const response of responses) {
      const items = response.value?.[i]?.availabilityItems ?? [];
      allItems.push(...items);
    }
    merged.value!.push({ availabilityItems: allItems });
  }

  return merged;
}

function buildSlots(
  response: GetStaffAvailabilityResponse,
  earliest: Date,
  windowEnd: Date,
  slotDurationMs: number,
  schedule: BusinessSchedule | null
): SlotMap {
  if (!response.value || response.value.length === 0) {
    return {};
  }

  // Per-staff: separate available and busy windows. A slot is bookable only
  // when at least one staff is available AND that same staff is not busy.
  const perStaff: Array<{ available: DateRange[]; busy: DateRange[] }> = [];
  for (const staff of response.value) {
    const available: DateRange[] = [];
    const busy: DateRange[] = [];
    for (const item of staff.availabilityItems ?? []) {
      const start = parseGraphDateTime(item.startDateTime);
      const end = parseGraphDateTime(item.endDateTime);
      if (item.status === 'available') {
        available.push({ start, end });
      } else {
        busy.push({ start, end });
      }
    }
    perStaff.push({ available, busy });
  }

  // Collect unique slot starts across all staff. Multiple staff being
  // simultaneously available produces one slot, not duplicates.
  const unique = new Set<string>();

  for (const staff of perStaff) {
    for (const window of staff.available) {
      let cursor = roundUpToSlotBoundary(window.start, slotDurationMs);
      while (cursor < window.end) {
        const slotEnd = new Date(cursor.getTime() + slotDurationMs);
        if (slotEnd > window.end) {
          break;
        }
        if (
          cursor >= earliest &&
          cursor <= windowEnd &&
          !slotConflictsWithBusy(cursor, slotEnd, staff.busy) &&
          slotWithinSchedule(cursor, slotEnd, schedule)
        ) {
          unique.add(cursor.toISOString());
        }
        cursor = new Date(cursor.getTime() + slotDurationMs);
      }
    }
  }

  // Group by date in the business timezone (or UTC if no schedule),
  // matching the WordPress plugin's grouping rule.
  const tzForGrouping = schedule?.timezone ?? 'UTC';
  const grouped: Record<string, string[]> = {};
  for (const iso of unique) {
    const dt = new Date(iso);
    const dateKey = formatDateInZone(dt, tzForGrouping);
    if (!grouped[dateKey]) {
      grouped[dateKey] = [];
    }
    grouped[dateKey].push(iso);
  }

  // Sort slot times within each date, and the dates themselves, for
  // stable widget rendering.
  const sortedKeys = Object.keys(grouped).sort();
  const result: SlotMap = {};
  for (const key of sortedKeys) {
    result[key] = grouped[key].sort();
  }
  return result;
}

/**
 * Parses a Microsoft Graph datetime value. Graph returns
 * `{ dateTime: "2026-05-22T10:00:00.0000000", timeZone: "UTC" }`. We strip
 * the fractional seconds and append "Z" to produce a parseable ISO 8601
 * UTC string. Non-UTC timeZone values are not encountered in
 * getStaffAvailability responses (we always request UTC).
 */
function parseGraphDateTime(dt: { dateTime: string; timeZone: string }): Date {
  const dotIdx = dt.dateTime.indexOf('.');
  const cleaned = dotIdx === -1 ? dt.dateTime : dt.dateTime.substring(0, dotIdx);
  return new Date(`${cleaned}Z`);
}

/**
 * Formats a `Date` for Graph's expected `dateTime` field shape: ISO 8601
 * without the "Z" suffix and without milliseconds. Always paired with
 * `timeZone: "UTC"` in the Graph payload.
 */
function formatGraphDateTime(dt: Date): string {
  return dt.toISOString().replace(/\.\d+Z$/, '');
}

/**
 * Rounds a timestamp up to the next slot-duration boundary. Without this,
 * Microsoft Bookings sometimes returns availability windows starting at
 * odd minutes (e.g. 11:25) because an adjacent busy block ends there;
 * iterating from the raw window edge produces slot times like 11:25, 11:55,
 * etc. Aligning to the slot grid keeps times on the hour or half-hour as
 * users expect.
 */
function roundUpToSlotBoundary(dt: Date, slotDurationMs: number): Date {
  const ts = dt.getTime();
  const rounded = Math.ceil(ts / slotDurationMs) * slotDurationMs;
  return new Date(rounded);
}

function slotConflictsWithBusy(
  start: Date,
  end: Date,
  busyIntervals: DateRange[]
): boolean {
  for (const busy of busyIntervals) {
    if (start < busy.end && end > busy.start) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

/** Test-only: clears the access-token cache so tests can simulate token refresh. */
export function _resetTokenCacheForTests(): void {
  cachedToken = null;
}
