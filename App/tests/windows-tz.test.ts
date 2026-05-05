import { describe, it, expect } from 'vitest';
import { windowsToIana, getWindowsTzMap } from '../src/lib/windows-tz.js';

describe('windowsToIana', () => {
  it('maps US Eastern to America/New_York', () => {
    expect(windowsToIana('Eastern Standard Time')).toBe('America/New_York');
  });

  it('maps the major US zones', () => {
    expect(windowsToIana('Central Standard Time')).toBe('America/Chicago');
    expect(windowsToIana('Mountain Standard Time')).toBe('America/Denver');
    expect(windowsToIana('Pacific Standard Time')).toBe('America/Los_Angeles');
  });

  it('maps Arizona separately from Mountain (no DST)', () => {
    expect(windowsToIana('US Mountain Standard Time')).toBe('America/Phoenix');
  });

  it('maps Hawaii and Alaska', () => {
    expect(windowsToIana('Hawaiian Standard Time')).toBe('Pacific/Honolulu');
    expect(windowsToIana('Alaskan Standard Time')).toBe('America/Anchorage');
  });

  it('maps common European zones', () => {
    expect(windowsToIana('GMT Standard Time')).toBe('Europe/London');
    expect(windowsToIana('W. Europe Standard Time')).toBe('Europe/Berlin');
    expect(windowsToIana('Romance Standard Time')).toBe('Europe/Paris');
  });

  it('maps common APAC zones', () => {
    expect(windowsToIana('India Standard Time')).toBe('Asia/Kolkata');
    expect(windowsToIana('Tokyo Standard Time')).toBe('Asia/Tokyo');
    expect(windowsToIana('AUS Eastern Standard Time')).toBe('Australia/Sydney');
  });

  it('maps the literal "UTC" through unchanged', () => {
    expect(windowsToIana('UTC')).toBe('UTC');
  });

  it('returns null for unmapped zones', () => {
    // Hypothetical Windows zone names that are not in our supported set.
    expect(windowsToIana('Pago Pago Standard Time')).toBeNull();
    expect(windowsToIana('Lord Howe Standard Time')).toBeNull();
    expect(windowsToIana('Iran Standard Time')).toBeNull();
  });

  it('returns null for the empty string', () => {
    expect(windowsToIana('')).toBeNull();
  });

  it('is case-sensitive', () => {
    // Windows TZ names from Bookings are always exact-case.
    expect(windowsToIana('eastern standard time')).toBeNull();
    expect(windowsToIana('EASTERN STANDARD TIME')).toBeNull();
  });

  it('does not partial-match', () => {
    expect(windowsToIana('Eastern Time')).toBeNull();
    expect(windowsToIana('Eastern Standard Time (US & Canada)')).toBeNull();
  });
});

describe('getWindowsTzMap', () => {
  it('returns a frozen object', () => {
    const map = getWindowsTzMap();
    expect(Object.isFrozen(map)).toBe(true);
  });

  it('contains at least the major regions', () => {
    const map = getWindowsTzMap();
    expect(Object.keys(map).length).toBeGreaterThan(10);
    expect(map['Eastern Standard Time']).toBe('America/New_York');
  });

  it('every IANA value is parseable by Intl.DateTimeFormat', () => {
    const map = getWindowsTzMap();
    for (const iana of Object.values(map)) {
      // Throws if the zone is invalid.
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: iana })).not.toThrow();
    }
  });
});
