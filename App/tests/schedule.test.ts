import { describe, it, expect } from 'vitest';
import {
  parseBusinessSchedule,
  slotWithinSchedule,
  formatDateInZone,
  type BookingBusinessResponse,
  type BusinessSchedule,
} from '../src/lib/schedule.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Realistic bookingBusiness response shape. Mirrors the actual JSON observed
 * during the v1.0.11 diagnostic spike of the WordPress plugin: Mon 10–12 +
 * 3–5, Tue–Fri 10–12, Sat/Sun closed; Eastern timezone; 30-minute slots.
 */
function makeBusinessResponse(
  overrides: Partial<BookingBusinessResponse> = {}
): BookingBusinessResponse {
  return {
    schedulingPolicy: {
      timeSlotInterval: 'PT30M',
      minimumLeadTime: 'P1D',
      maximumAdvance: 'P60D',
      generalAvailability: {
        businessHours: [
          {
            day: 'monday',
            timeSlots: [
              { startTime: '10:00:00.0000000', endTime: '12:00:00.0000000' },
              { startTime: '15:00:00.0000000', endTime: '17:00:00.0000000' },
            ],
          },
          {
            day: 'tuesday',
            timeSlots: [{ startTime: '10:00:00.0000000', endTime: '12:00:00.0000000' }],
          },
          {
            day: 'wednesday',
            timeSlots: [{ startTime: '10:00:00.0000000', endTime: '12:00:00.0000000' }],
          },
          {
            day: 'thursday',
            timeSlots: [{ startTime: '10:00:00.0000000', endTime: '12:00:00.0000000' }],
          },
          {
            day: 'friday',
            timeSlots: [{ startTime: '10:00:00.0000000', endTime: '12:00:00.0000000' }],
          },
          { day: 'saturday', timeSlots: [] },
          { day: 'sunday', timeSlots: [] },
        ],
      },
      customAvailabilities: [],
    },
    bookingPageSettings: {
      businessTimeZone: 'Eastern Standard Time',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseBusinessSchedule
// ---------------------------------------------------------------------------

describe('parseBusinessSchedule', () => {
  it('parses a realistic response into the expected shape', () => {
    const result = parseBusinessSchedule(makeBusinessResponse());
    expect(result).not.toBeNull();
    const schedule = result as BusinessSchedule;

    expect(schedule.timezone).toBe('America/New_York');
    expect(schedule.leadTimeSeconds).toBe(86400);
    expect(schedule.maxAdvanceSeconds).toBe(60 * 86400);
    expect(schedule.slotIntervalSeconds).toBe(1800);

    expect(schedule.generalAvailability.monday).toEqual([
      { start: '10:00:00', end: '12:00:00' },
      { start: '15:00:00', end: '17:00:00' },
    ]);
    expect(schedule.generalAvailability.friday).toEqual([
      { start: '10:00:00', end: '12:00:00' },
    ]);
    expect(schedule.generalAvailability.saturday).toEqual([]);
  });

  it('strips fractional seconds from time strings', () => {
    const result = parseBusinessSchedule(makeBusinessResponse());
    expect(result?.generalAvailability.monday[0].start).toBe('10:00:00');
    // Not "10:00:00.0000000".
  });

  it('returns null when generalAvailability is missing', () => {
    const response: BookingBusinessResponse = {
      schedulingPolicy: { timeSlotInterval: 'PT30M' },
      bookingPageSettings: { businessTimeZone: 'Eastern Standard Time' },
    };
    expect(parseBusinessSchedule(response)).toBeNull();
  });

  it('returns null when generalAvailability is empty', () => {
    const response = makeBusinessResponse({
      schedulingPolicy: {
        generalAvailability: { businessHours: [] },
      },
    });
    expect(parseBusinessSchedule(response)).toBeNull();
  });

  it('returns null when the timezone is not in the Windows-to-IANA map', () => {
    const response = makeBusinessResponse({
      bookingPageSettings: { businessTimeZone: 'Made-Up Standard Time' },
    });
    expect(parseBusinessSchedule(response)).toBeNull();
  });

  it('falls back to UTC when bookingPageSettings is missing entirely', () => {
    const response = makeBusinessResponse({
      bookingPageSettings: undefined,
    });
    const result = parseBusinessSchedule(response);
    expect(result?.timezone).toBe('UTC');
  });

  it('skips malformed timeSlots without crashing', () => {
    const response = makeBusinessResponse({
      schedulingPolicy: {
        generalAvailability: {
          businessHours: [
            {
              day: 'monday',
              timeSlots: [
                { startTime: 'bogus', endTime: 'bogus' },
                { startTime: '10:00:00', endTime: '12:00:00' },
              ],
            },
          ],
        },
      },
    });
    const result = parseBusinessSchedule(response);
    expect(result?.generalAvailability.monday).toEqual([
      { start: '10:00:00', end: '12:00:00' },
    ]);
  });

  it('lowercases weekday keys', () => {
    const response = makeBusinessResponse({
      schedulingPolicy: {
        generalAvailability: {
          businessHours: [
            {
              day: 'MONDAY',
              timeSlots: [{ startTime: '10:00:00', endTime: '12:00:00' }],
            },
          ],
        },
      },
    });
    const result = parseBusinessSchedule(response);
    expect(result?.generalAvailability.monday).toBeDefined();
    expect(result?.generalAvailability.MONDAY).toBeUndefined();
  });

  it('returns lead time of 0 when minimumLeadTime is not in the response', () => {
    const response = makeBusinessResponse({
      schedulingPolicy: {
        generalAvailability: {
          businessHours: [
            {
              day: 'monday',
              timeSlots: [{ startTime: '10:00:00', endTime: '12:00:00' }],
            },
          ],
        },
        // minimumLeadTime omitted
      },
    });
    const result = parseBusinessSchedule(response);
    expect(result?.leadTimeSeconds).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// slotWithinSchedule
// ---------------------------------------------------------------------------

describe('slotWithinSchedule', () => {
  // The schedule we test against: same as the realistic Onshore one.
  // Friday 2026-05-22 10:00-12:00 Eastern is the canonical test window.
  const schedule = parseBusinessSchedule(makeBusinessResponse()) as BusinessSchedule;

  it('returns true for null schedule (legacy fallback)', () => {
    const start = new Date('2026-05-22T13:00:00Z');
    const end = new Date('2026-05-22T13:30:00Z');
    expect(slotWithinSchedule(start, end, null)).toBe(true);
  });

  it('returns true for empty generalAvailability (legacy fallback)', () => {
    const emptySchedule: BusinessSchedule = {
      timezone: 'America/New_York',
      leadTimeSeconds: 0,
      maxAdvanceSeconds: 0,
      slotIntervalSeconds: 1800,
      generalAvailability: {},
      customAvailabilities: [],
    };
    const start = new Date('2026-05-22T13:00:00Z');
    const end = new Date('2026-05-22T13:30:00Z');
    expect(slotWithinSchedule(start, end, emptySchedule)).toBe(true);
  });

  describe('Friday 10–12 EDT window (= 14:00–16:00 UTC in May)', () => {
    it('accepts a 10:00 AM EDT slot (= 14:00 UTC)', () => {
      const start = new Date('2026-05-22T14:00:00Z');
      const end = new Date('2026-05-22T14:30:00Z');
      expect(slotWithinSchedule(start, end, schedule)).toBe(true);
    });

    it('accepts an 11:30 AM EDT slot ending at 12:00 EDT', () => {
      const start = new Date('2026-05-22T15:30:00Z');
      const end = new Date('2026-05-22T16:00:00Z');
      expect(slotWithinSchedule(start, end, schedule)).toBe(true);
    });

    it('rejects a 9:30 AM EDT slot (before window)', () => {
      const start = new Date('2026-05-22T13:30:00Z');
      const end = new Date('2026-05-22T14:00:00Z');
      expect(slotWithinSchedule(start, end, schedule)).toBe(false);
    });

    it('rejects a 12:00 PM EDT slot (at window end, slot would extend past)', () => {
      const start = new Date('2026-05-22T16:00:00Z');
      const end = new Date('2026-05-22T16:30:00Z');
      expect(slotWithinSchedule(start, end, schedule)).toBe(false);
    });

    it('rejects a 2:30 PM EDT slot (afternoon, outside window)', () => {
      const start = new Date('2026-05-22T18:30:00Z');
      const end = new Date('2026-05-22T19:00:00Z');
      expect(slotWithinSchedule(start, end, schedule)).toBe(false);
    });
  });

  describe('Monday split window (10–12 + 15–17 EDT)', () => {
    it('accepts a 3:00 PM EDT slot in the second window', () => {
      const start = new Date('2026-05-18T19:00:00Z'); // 15:00 EDT Monday
      const end = new Date('2026-05-18T19:30:00Z');
      expect(slotWithinSchedule(start, end, schedule)).toBe(true);
    });

    it('rejects a 1:00 PM EDT slot in the gap between windows', () => {
      const start = new Date('2026-05-18T17:00:00Z'); // 13:00 EDT Monday
      const end = new Date('2026-05-18T17:30:00Z');
      expect(slotWithinSchedule(start, end, schedule)).toBe(false);
    });
  });

  describe('Closed days', () => {
    it('rejects all slots on Saturday', () => {
      // 2026-05-23 is a Saturday.
      const start = new Date('2026-05-23T14:00:00Z');
      const end = new Date('2026-05-23T14:30:00Z');
      expect(slotWithinSchedule(start, end, schedule)).toBe(false);
    });

    it('rejects all slots on Sunday', () => {
      // 2026-05-24 is a Sunday.
      const start = new Date('2026-05-24T14:00:00Z');
      const end = new Date('2026-05-24T14:30:00Z');
      expect(slotWithinSchedule(start, end, schedule)).toBe(false);
    });
  });

  describe('Cross-midnight rejection', () => {
    it('rejects a slot whose end falls on the next business-local date', () => {
      // Construct a slot that spans 11:55 PM → 12:25 AM in business-local time.
      // In May 2026 that's 2026-05-22T03:55:00Z → 2026-05-22T04:25:00Z.
      // Friday → Saturday is closed anyway, but this also tests the
      // cross-midnight rejection rule.
      const start = new Date('2026-05-22T03:55:00Z');
      const end = new Date('2026-05-22T04:25:00Z');
      expect(slotWithinSchedule(start, end, schedule)).toBe(false);
    });
  });

  describe('DST behavior (America/New_York)', () => {
    // DST in 2026: starts second Sunday in March (March 8), ends first
    // Sunday in November (November 1). We test a slot in EDT (May, UTC-4)
    // and a slot in EST (December, UTC-5) and verify the schedule applies
    // correctly in both cases.

    it('Friday 10 AM in May (EDT, UTC-4) is 14:00 UTC', () => {
      const start = new Date('2026-05-22T14:00:00Z');
      const end = new Date('2026-05-22T14:30:00Z');
      expect(slotWithinSchedule(start, end, schedule)).toBe(true);
    });

    it('Friday 10 AM in December (EST, UTC-5) is 15:00 UTC', () => {
      const start = new Date('2026-12-04T15:00:00Z');
      const end = new Date('2026-12-04T15:30:00Z');
      expect(slotWithinSchedule(start, end, schedule)).toBe(true);
    });

    it('the same UTC slot is in/out depending on the season', () => {
      // 14:00 UTC is 10 AM EDT (in window) but 9 AM EST (out of window).
      const startMay = new Date('2026-05-22T14:00:00Z'); // Friday in EDT
      expect(slotWithinSchedule(startMay, new Date(startMay.getTime() + 1800_000), schedule)).toBe(true);

      const startDec = new Date('2026-12-04T14:00:00Z'); // Friday in EST
      expect(slotWithinSchedule(startDec, new Date(startDec.getTime() + 1800_000), schedule)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// formatDateInZone
// ---------------------------------------------------------------------------

describe('formatDateInZone', () => {
  it('returns "YYYY-MM-DD" in the given zone', () => {
    // 2026-05-22T03:00:00Z is still 2026-05-21 in America/New_York
    // (which is UTC-4 during DST).
    const utc = new Date('2026-05-22T03:00:00Z');
    expect(formatDateInZone(utc, 'America/New_York')).toBe('2026-05-21');
  });

  it('matches the UTC date when the zone is UTC', () => {
    const utc = new Date('2026-05-22T03:00:00Z');
    expect(formatDateInZone(utc, 'UTC')).toBe('2026-05-22');
  });

  it('uses zero-padded month and day', () => {
    const utc = new Date('2026-01-05T12:00:00Z');
    expect(formatDateInZone(utc, 'UTC')).toBe('2026-01-05');
  });
});
