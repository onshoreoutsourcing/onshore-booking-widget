/**
 * Windows time zone name → IANA time zone name conversion.
 *
 * Microsoft Bookings returns the business time zone in the
 * `bookingPageSettings.businessTimeZone` field using Windows zone names like
 * "Eastern Standard Time". Despite the literal name including "Standard",
 * Windows zones follow daylight saving time year-round — "Eastern Standard
 * Time" represents the US Eastern zone with the EDT shift, not literal EST.
 *
 * Node's `Intl.DateTimeFormat` and `Date` APIs require IANA names like
 * "America/New_York". This module converts between them.
 *
 * Only zones a deployed booking system is realistically configured against
 * are mapped here — primarily the major US, EU, and APAC regions. Any unmapped
 * value causes the calling code to fall back to the "no schedule filter" path,
 * which is safer than silently misapplying the wrong offset. Add new entries
 * to the map below when a deployment requires a region that is not listed.
 *
 * Ported from the WordPress plugin's `class-graph-client.php` constant
 * `WINDOWS_TZ_TO_IANA` (v1.0.12+).
 */

const WINDOWS_TZ_TO_IANA: Readonly<Record<string, string>> = Object.freeze({
  // Americas
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix', // Arizona, no DST
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time': 'America/Halifax',

  // Europe
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',

  // Asia / Pacific
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'AUS Eastern Standard Time': 'Australia/Sydney',

  // UTC
  'UTC': 'UTC',
});

/**
 * Returns the IANA time zone name for a Windows time zone name, or `null` if
 * the Windows name is not in the mapping.
 *
 * Callers that receive `null` should treat it as "no schedule filter
 * applicable" rather than guessing — applying the wrong offset is worse than
 * showing too many slots.
 *
 * @param windowsName Windows zone name as returned by Microsoft Bookings
 *                     (e.g. "Eastern Standard Time").
 * @returns IANA zone name (e.g. "America/New_York"), or null if unmapped.
 */
export function windowsToIana(windowsName: string): string | null {
  return WINDOWS_TZ_TO_IANA[windowsName] ?? null;
}

/**
 * Returns the full mapping as a frozen plain object. Exposed primarily for
 * testing and diagnostic logging — production code should use windowsToIana().
 */
export function getWindowsTzMap(): Readonly<Record<string, string>> {
  return WINDOWS_TZ_TO_IANA;
}
