import { describe, it, expect } from 'vitest';
import { parseIsoDurationSeconds } from '../src/lib/iso-duration.js';

describe('parseIsoDurationSeconds', () => {
  describe('values produced by Microsoft Bookings', () => {
    // These are the exact strings returned by the Bookings Graph API in
    // schedulingPolicy fields. If any of these change, the schedule loader
    // will silently miscompute lead times.
    it('PT30M = 30 minutes', () => {
      expect(parseIsoDurationSeconds('PT30M')).toBe(30 * 60);
    });

    it('P1D = 1 day', () => {
      expect(parseIsoDurationSeconds('P1D')).toBe(24 * 60 * 60);
    });

    it('P60D = 60 days', () => {
      expect(parseIsoDurationSeconds('P60D')).toBe(60 * 24 * 60 * 60);
    });

    it('PT0S = zero (used for buffers and disabled lead times)', () => {
      expect(parseIsoDurationSeconds('PT0S')).toBe(0);
    });
  });

  describe('combined components', () => {
    it('PT1H30M = 1 hour 30 minutes', () => {
      expect(parseIsoDurationSeconds('PT1H30M')).toBe(3600 + 1800);
    });

    it('P1DT12H = 1 day 12 hours', () => {
      expect(parseIsoDurationSeconds('P1DT12H')).toBe(86400 + 43200);
    });

    it('PT1H30M45S = full hour-minute-second mix', () => {
      expect(parseIsoDurationSeconds('PT1H30M45S')).toBe(3600 + 1800 + 45);
    });

    it('P1W = 1 week (7 days)', () => {
      expect(parseIsoDurationSeconds('P1W')).toBe(7 * 86400);
    });
  });

  describe('zero and empty inputs', () => {
    it('empty string returns 0', () => {
      expect(parseIsoDurationSeconds('')).toBe(0);
    });

    it('"P0D" returns 0', () => {
      expect(parseIsoDurationSeconds('P0D')).toBe(0);
    });

    it('"P" alone returns 0', () => {
      expect(parseIsoDurationSeconds('P')).toBe(0);
    });

    it('"PT" alone returns 0', () => {
      expect(parseIsoDurationSeconds('PT')).toBe(0);
    });
  });

  describe('unsupported and malformed inputs', () => {
    it('months are not supported (their second-count is undefined without a base date)', () => {
      // Note: my parser specifically does not match M before T (which would be months).
      // The string "P1M" matches the regex but with weeks/days/hours/minutes/seconds
      // all zero, returns 0. That's the safe behavior.
      expect(parseIsoDurationSeconds('P1M')).toBe(0);
    });

    it('years are not supported', () => {
      expect(parseIsoDurationSeconds('P1Y')).toBe(0);
    });

    it('fractional values are not supported', () => {
      expect(parseIsoDurationSeconds('PT1.5H')).toBe(0);
      expect(parseIsoDurationSeconds('PT0.5S')).toBe(0);
    });

    it('garbage strings return 0', () => {
      expect(parseIsoDurationSeconds('not a duration')).toBe(0);
      expect(parseIsoDurationSeconds('30 minutes')).toBe(0);
      expect(parseIsoDurationSeconds('PT')).toBe(0);
      expect(parseIsoDurationSeconds('30M')).toBe(0); // missing P prefix
    });

    it('case mismatch returns 0 (ISO durations are uppercase)', () => {
      expect(parseIsoDurationSeconds('pt30m')).toBe(0);
    });

    it('negative durations are not supported', () => {
      // "-PT30M" doesn't match the regex.
      expect(parseIsoDurationSeconds('-PT30M')).toBe(0);
    });
  });

  describe('precision at large values', () => {
    it('large day counts compute exactly', () => {
      // 365 days = 31,536,000 seconds. Within safe integer range.
      expect(parseIsoDurationSeconds('P365D')).toBe(365 * 86400);
    });
  });
});
