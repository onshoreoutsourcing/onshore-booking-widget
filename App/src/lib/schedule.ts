/**
 * Bookings General Availability schedule parsing and slot filtering.
 *
 * Microsoft Graph's getStaffAvailability endpoint reports staff Outlook
 * free/busy intersected with the legacy `bookingBusiness.businessHours`
 * field. It does NOT honor the modern Bookings UI's "General availability"
 * schedule (which lives at `bookingBusiness.schedulingPolicy.generalAvailability`).
 *
 * To honor the schedule a user actually configures in the Bookings UI, we
 * fetch the bookingBusiness object separately and apply its General
 * Availability windows as a slot-level filter inside slot generation.
 *
 * Algorithmic port of the WordPress plugin's `class-graph-client.php`
 * (v1.0.12+). Same logic, TypeScript-native types, Intl-based timezone
 * conversion in place of PHP's DateTimeImmutable.
 */

import { windowsToIana } from './windows-tz.js';
import { parseIsoDurationSeconds } from './iso-duration.js';

/**
 * One contiguous bookable window expressed in business-local time.
 * Times are "HH:MM:SS" strings; Bookings does not return fractional seconds
 * but the parser tolerates and strips them.
 */
export interface TimeWindow {
  start: string;
  end: string;
}

/**
 * Parsed Bookings business schedule. The shape returned by
 * `parseBusinessSchedule` for downstream consumption.
 */
export interface BusinessSchedule {
  /** IANA timezone (e.g. "America/New_York"). */
  timezone: string;
  /** Minimum lead time before now that bookings are accepted, in seconds. */
  leadTimeSeconds: number;
  /** Maximum advance window from now, in seconds. */
  maxAdvanceSeconds: number;
  /** Slot interval (typically 1800 = 30 minutes), in seconds. */
  slotIntervalSeconds: number;
  /**
   * Per-weekday allowed windows. Keys are lowercase weekday names
   * ("monday", "tuesday", …); values are arrays of allowed windows.
   * A weekday with an empty array (or absent key) is closed.
   */
  generalAvailability: Record<string, TimeWindow[]>;
  /**
   * Per-date overrides. Reserved for future support; currently always [].
   * Bookings stores these but the booking flow does not yet consume them.
   */
  customAvailabilities: readonly unknown[];
}

/**
 * Subset of the Microsoft Graph bookingBusiness response that this module
 * reads. Other fields are present on the wire but are not used here.
 */
export interface BookingBusinessResponse {
  schedulingPolicy?: {
    generalAvailability?: {
      businessHours?: Array<{
        day?: string;
        timeSlots?: Array<{ startTime?: string; endTime?: string }>;
      }>;
    };
    customAvailabilities?: unknown[];
    minimumLeadTime?: string;
    maximumAdvance?: string;
    timeSlotInterval?: string;
  };
  bookingPageSettings?: {
    businessTimeZone?: string;
  };
}

/**
 * Parses a raw bookingBusiness JSON response from Microsoft Graph into the
 * internal `BusinessSchedule` shape. Returns `null` when the business has
 * no usable General Availability — callers should treat that as "no
 * schedule filter" and fall back to legacy behavior.
 *
 * Returning `null` (rather than throwing) is intentional: a missing or
 * unmapped schedule is not an error, and over-rejecting bookings would be
 * worse than under-filtering them.
 */
export function parseBusinessSchedule(business: BookingBusinessResponse): BusinessSchedule | null {
  const policy = business.schedulingPolicy ?? {};
  const generalHoursRaw = policy.generalAvailability?.businessHours ?? [];

  if (generalHoursRaw.length === 0) {
    return null;
  }

  // Resolve and validate the timezone. Bookings returns Windows TZ names
  // like "Eastern Standard Time"; we need IANA names. Unmapped values
  // disable the filter rather than misapply the wrong offset.
  const windowsTz = business.bookingPageSettings?.businessTimeZone ?? 'UTC';
  const ianaTz = windowsToIana(windowsTz);
  if (ianaTz === null) {
    console.warn(
      `[schedule] Unmapped Windows timezone "${windowsTz}"; schedule filter disabled.`
    );
    return null;
  }

  // Normalize the per-weekday windows.
  const generalAvailability: Record<string, TimeWindow[]> = {};
  for (const entry of generalHoursRaw) {
    const day = entry.day?.toLowerCase();
    if (!day) {
      continue;
    }
    const windows: TimeWindow[] = [];
    for (const slot of entry.timeSlots ?? []) {
      const start = normalizeTimeString(slot.startTime ?? '');
      const end = normalizeTimeString(slot.endTime ?? '');
      if (!start || !end) {
        continue;
      }
      windows.push({ start, end });
    }
    generalAvailability[day] = windows;
  }

  return {
    timezone: ianaTz,
    leadTimeSeconds: parseIsoDurationSeconds(policy.minimumLeadTime ?? ''),
    maxAdvanceSeconds: parseIsoDurationSeconds(policy.maximumAdvance ?? ''),
    slotIntervalSeconds: parseIsoDurationSeconds(policy.timeSlotInterval ?? ''),
    generalAvailability,
    customAvailabilities: [],
  };
}

/**
 * Returns true if the given UTC slot falls inside the business's configured
 * General Availability window for that day-of-week, evaluated in the
 * business timezone.
 *
 * When `schedule` is null (no schedule configured, fetch failed, or the
 * timezone is unmapped) this returns `true` unconditionally so legacy
 * behavior is preserved — better to show too many slots than to silently
 * hide everything.
 *
 * Slots that cross midnight in the business timezone are rejected. Bookings
 * does not represent overnight windows in a single entry, so a slot whose
 * end falls on a different local date by definition is not inside any
 * single day's configured time window. A slot ending exactly at 00:00:00
 * is allowed (the end is non-inclusive mathematically).
 */
export function slotWithinSchedule(
  slotStartUtc: Date,
  slotEndUtc: Date,
  schedule: BusinessSchedule | null
): boolean {
  if (!schedule || Object.keys(schedule.generalAvailability).length === 0) {
    return true;
  }

  // Convert both endpoints to business-local representation.
  const startLocal = toLocalParts(slotStartUtc, schedule.timezone);
  const endLocal = toLocalParts(slotEndUtc, schedule.timezone);

  // Reject slots straddling midnight in the business timezone, except for
  // those ending exactly at 00:00:00 (mathematically the start of the next
  // day, but representable as a same-day slot).
  if (startLocal.dateKey !== endLocal.dateKey) {
    if (endLocal.timeKey !== '00:00:00') {
      return false;
    }
  }

  const timeSlots = schedule.generalAvailability[startLocal.weekday] ?? [];
  if (timeSlots.length === 0) {
    return false;
  }

  const slotStartSeconds = timeStringToSeconds(startLocal.timeKey);
  // Compute end-seconds as start + elapsed-seconds rather than re-parsing
  // endLocal.timeKey, so a slot ending at 00:00:00 next day evaluates to
  // 86400 — which can never match a window whose end is at most 86400.
  const elapsedSeconds = Math.round((slotEndUtc.getTime() - slotStartUtc.getTime()) / 1000);
  const slotEndSeconds = slotStartSeconds + elapsedSeconds;

  for (const window of timeSlots) {
    const windowStart = timeStringToSeconds(window.start);
    const windowEnd = timeStringToSeconds(window.end);
    if (slotStartSeconds >= windowStart && slotEndSeconds <= windowEnd) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Strips fractional seconds from a Bookings time string ("10:00:00.0000000"
 * → "10:00:00") and validates the HH:MM:SS shape. Returns "" if invalid.
 */
function normalizeTimeString(time: string): string {
  const dotIdx = time.indexOf('.');
  const cleaned = dotIdx === -1 ? time : time.substring(0, dotIdx);
  if (!/^\d{2}:\d{2}:\d{2}$/.test(cleaned)) {
    return '';
  }
  return cleaned;
}

/**
 * Converts an "HH:MM:SS" string to seconds since midnight.
 */
function timeStringToSeconds(time: string): number {
  const parts = time.split(':');
  const h = parseInt(parts[0] ?? '0', 10);
  const m = parseInt(parts[1] ?? '0', 10);
  const s = parseInt(parts[2] ?? '0', 10);
  return h * 3600 + m * 60 + s;
}

interface LocalParts {
  /** "YYYY-MM-DD" in the target zone. */
  dateKey: string;
  /** "HH:MM:SS" 24-hour in the target zone. */
  timeKey: string;
  /** Lowercase weekday name ("monday", …) in the target zone. */
  weekday: string;
}

/**
 * Renders a UTC `Date` into business-local date, time, and weekday parts
 * using the platform's Intl.DateTimeFormat. PHP's DateTimeImmutable in the
 * source plugin handled DST transitions transparently; Intl does the same.
 */
function toLocalParts(utc: Date, timeZone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(utc);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';

  return {
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    timeKey: `${get('hour')}:${get('minute')}:${get('second')}`,
    weekday: get('weekday').toLowerCase(),
  };
}

/**
 * Renders a UTC `Date` as a "YYYY-MM-DD" string in the given IANA zone.
 * Used by the slot grouper in graph-client to bucket slots by local date.
 */
export function formatDateInZone(utc: Date, timeZone: string): string {
  return toLocalParts(utc, timeZone).dateKey;
}
