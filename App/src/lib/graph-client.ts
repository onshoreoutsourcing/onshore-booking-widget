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

/**
 * In-memory cache TTL for staff list and business schedule, in milliseconds.
 *
 * Shortened from the original 1 hour to 30 minutes to reduce the staleness
 * window when the Bookings UI changes (schedule edits, staff add/remove,
 * etc.). Trade-off is a small uptick in Graph API calls — acceptable at
 * this volume.
 */
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

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

/**
 * One Microsoft Bookings staff member as we use it internally.
 * The `email` is normalized to lowercase for case-insensitive matching
 * against the tenant's `requiredStaffEmails` configuration.
 */
interface StaffMember {
  id: string;
  email: string;
}

interface TenantCache {
  staff?: { value: StaffMember[]; expiresAt: number };
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
  const staff = await getStaffMembers(tenant);
  if (staff.length === 0) {
    // No staff configured for this Bookings business — return an empty
    // map rather than erroring. The widget shows "no times available".
    return {};
  }
  const staffIds = staff.map((s) => s.id);

  // Resolve requiredStaffEmails (if configured) to indices in the staff
  // list. Two failure modes are handled per the operator-confirmed policy:
  //   - Field absent or empty → fall back to "any staff available"
  //     (legacy behavior; requiredStaffIndices stays null).
  //   - Field present but no email matches a current Bookings staff
  //     member → log a warning and fall back to "any staff available"
  //     (Option B: prefer showing too many slots over an empty calendar).
  let requiredStaffIndices: number[] | null = null;
  if (tenant.requiredStaffEmails && tenant.requiredStaffEmails.length > 0) {
    const resolved = resolveRequiredStaffIndices(staff, tenant.requiredStaffEmails);
    if (resolved.length > 0) {
      requiredStaffIndices = resolved;
    } else {
      console.warn(
        `[graph-client] tenant "${tenant.slug}" has requiredStaffEmails ` +
          'configured but none matched a current Bookings staff member ' +
          '(check for typos or staff turnover). Falling back to ' +
          '"any staff available" semantics.'
      );
    }
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

  return buildSlots(
    availability,
    earliest,
    windowEnd,
    slotDurationMs,
    schedule,
    requiredStaffIndices
  );
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

  // Re-check that the tenant's required staff (if any) is still available
  // for the requested window. Catches the race where the salesperson's
  // calendar changed between when the slot was listed and when this
  // booking was submitted.
  //
  // No-op when the tenant has no `requiredStaffEmails` configured.
  // Permissive on transient Graph errors — the booking creation itself
  // would surface real issues.
  const stillAvailable = await verifyRequiredStaffStillAvailable(tenant, startDt, endDt);
  if (!stillAvailable) {
    throw new SlotNoLongerAvailableError();
  }

  // Best-effort staff assignment — non-fatal if it fails.
  // All Bookings staff are added to staffMemberIds (regardless of the
  // tenant's requiredStaffEmails). Microsoft Bookings does not expose the
  // required-vs-optional attendee distinction via the Graph API, so all
  // staff appear as required attendees on the underlying calendar event.
  // Staff who aren't required can decline if their schedule conflicts.
  let staffIds: string[] = [];
  try {
    const staff = await getStaffMembers(tenant);
    staffIds = staff.map((s) => s.id);
  } catch (err) {
    console.warn(
      `[graph-client] getStaffMembers failed for tenant "${tenant.slug}"; ` +
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

/**
 * Thrown when a booking submission's required staff member became
 * unavailable between slot listing and booking creation. The handler
 * should translate this to a 409 Conflict response so the widget can
 * prompt the user to choose a different time.
 *
 * Only emitted when the tenant has `requiredStaffEmails` configured;
 * for other tenants, the system trusts the slot list.
 */
export class SlotNoLongerAvailableError extends Error {
  constructor() {
    super('The selected time is no longer available.');
    this.name = 'SlotNoLongerAvailableError';
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

async function getStaffMembers(tenant: TenantConfig): Promise<StaffMember[]> {
  const cache = getCacheBucket(tenant.slug);
  if (cache.staff && cache.staff.expiresAt > Date.now()) {
    return cache.staff.value;
  }

  const response = await graphRequest<{
    value?: Array<{ id?: string; emailAddress?: string }>;
  }>(
    'GET',
    `/solutions/bookingBusinesses/${encodeURIComponent(tenant.businessId)}/staffMembers`
  );

  const staff: StaffMember[] = (response.value ?? [])
    .filter((m): m is { id: string; emailAddress?: string } =>
      typeof m.id === 'string' && m.id.length > 0
    )
    .map((m) => ({
      id: m.id,
      // Normalize to lowercase so case-insensitive matching against the
      // tenant's requiredStaffEmails works without per-comparison toLowerCase.
      email: (m.emailAddress ?? '').trim().toLowerCase(),
    }));

  cache.staff = { value: staff, expiresAt: Date.now() + CACHE_TTL_MS };
  return staff;
}

/**
 * Resolves a tenant's `requiredStaffEmails` to indices in the current Bookings
 * staff list. The returned indices align with the order of staff members
 * passed to getStaffAvailability, so they map directly to entries in the
 * Graph response's `value` array.
 *
 * Returns an empty array if no emails match (caller should treat that as
 * "fall back to any-staff availability" — the user-confirmed fallback for
 * misconfiguration).
 *
 * Comparison is case-insensitive. Emails are trimmed before comparison.
 */
function resolveRequiredStaffIndices(
  staff: readonly StaffMember[],
  requiredEmails: readonly string[]
): number[] {
  const requiredSet = new Set(
    requiredEmails.map((e) => e.trim().toLowerCase()).filter((e) => e !== '')
  );
  const indices: number[] = [];
  for (let i = 0; i < staff.length; i++) {
    if (requiredSet.has(staff[i].email)) {
      indices.push(i);
    }
  }
  return indices;
}

/**
 * Re-checks whether at least one of the tenant's `requiredStaffEmails`
 * members is still free for the requested booking window. Used at create
 * time to catch the race where the staff member's calendar changed
 * between when the slot was listed and when the visitor submitted the
 * booking.
 *
 * Returns true when:
 *   - The tenant has no `requiredStaffEmails` configured (no constraint)
 *   - The configured emails don't match any current Bookings staff
 *     (typo / staff turnover — same fallback as slot listing)
 *   - At least one required staff member has an `available` window that
 *     fully covers [startTime, endTime] AND no overlapping `busy` window
 *
 * Returns false only when required staff are configured AND none of
 * them are free for the requested window. Caller throws
 * `SlotNoLongerAvailableError` and the handler returns 409.
 *
 * If the underlying Graph call fails (network error, throttling, etc.),
 * we return true to be permissive — the booking creation itself will
 * surface any real issue, and we'd rather not block legitimate bookings
 * because of a transient verify failure.
 */
async function verifyRequiredStaffStillAvailable(
  tenant: TenantConfig,
  startTime: Date,
  endTime: Date
): Promise<boolean> {
  if (!tenant.requiredStaffEmails || tenant.requiredStaffEmails.length === 0) {
    return true;
  }

  const staff = await getStaffMembers(tenant);
  const requiredIndices = resolveRequiredStaffIndices(staff, tenant.requiredStaffEmails);
  if (requiredIndices.length === 0) {
    // No emails matched current staff — be permissive (matches the
    // slot-listing fallback behavior). Caller's getAvailableSlots already
    // logs the warning; no need to log again here.
    return true;
  }

  const requiredStaffIds = requiredIndices.map((i) => staff[i].id);

  // Pad the query window slightly so we don't miss a busy entry that
  // starts a few seconds before or ends a few seconds after our slot.
  const bufferMs = 60 * 1000; // 60 seconds
  const queryStart = new Date(startTime.getTime() - bufferMs);
  const queryEnd = new Date(endTime.getTime() + bufferMs);

  let response: GetStaffAvailabilityResponse;
  try {
    response = await graphRequest<GetStaffAvailabilityResponse>(
      'POST',
      `/solutions/bookingBusinesses/${encodeURIComponent(tenant.businessId)}/getStaffAvailability`,
      {
        staffIds: requiredStaffIds,
        startDateTime: { dateTime: formatGraphDateTime(queryStart), timeZone: 'UTC' },
        endDateTime: { dateTime: formatGraphDateTime(queryEnd), timeZone: 'UTC' },
      }
    );
  } catch (err) {
    console.warn(
      `[graph-client] verifyRequiredStaffStillAvailable: re-check failed for tenant "${tenant.slug}", being permissive:`,
      err
    );
    return true;
  }

  // For each required staff, check if they have a covering `available`
  // window AND no overlapping `busy` window. OR semantics across staff:
  // any one of them being free is sufficient.
  for (const staffEntry of response.value ?? []) {
    let hasCoveringAvailableWindow = false;
    let hasOverlappingBusy = false;

    for (const item of staffEntry.availabilityItems ?? []) {
      const itemStart = parseGraphDateTime(item.startDateTime);
      const itemEnd = parseGraphDateTime(item.endDateTime);

      if (item.status === 'available') {
        // Available window must fully cover [startTime, endTime].
        if (itemStart <= startTime && itemEnd >= endTime) {
          hasCoveringAvailableWindow = true;
        }
      } else {
        // Any non-available status (busy, tentative, oof, workingElsewhere)
        // overlapping the slot disqualifies this staff.
        if (itemStart < endTime && itemEnd > startTime) {
          hasOverlappingBusy = true;
        }
      }
    }

    if (hasCoveringAvailableWindow && !hasOverlappingBusy) {
      return true;
    }
  }

  return false;
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
  schedule: BusinessSchedule | null,
  requiredStaffIndices: number[] | null
): SlotMap {
  if (!response.value || response.value.length === 0) {
    return {};
  }

  // Per-staff: separate available and busy windows. A slot is bookable only
  // when at least one (eligible) staff is available AND that same staff is
  // not busy.
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

  // Determine which staff drive slot eligibility:
  //   - If requiredStaffIndices is non-null and non-empty: only iterate
  //     those staff. OR semantics — a slot appears when any one of the
  //     required staff has it free.
  //   - Otherwise: iterate all staff (the legacy "any staff" behavior).
  // The caller is responsible for falling back to null when no required
  // emails resolved (e.g. typo), so this branch is purely a slot-filtering
  // decision.
  const eligibleStaff =
    requiredStaffIndices && requiredStaffIndices.length > 0
      ? requiredStaffIndices
          .map((i) => perStaff[i])
          .filter((s): s is { available: DateRange[]; busy: DateRange[] } => s !== undefined)
      : perStaff;

  // Collect unique slot starts across all eligible staff. Multiple staff
  // being simultaneously available produces one slot, not duplicates.
  const unique = new Set<string>();

  for (const staff of eligibleStaff) {
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
