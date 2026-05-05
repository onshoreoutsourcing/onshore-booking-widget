/**
 * ISO 8601 duration string parser.
 *
 * Microsoft Bookings returns scheduling-policy fields as ISO 8601 durations:
 *   - `timeSlotInterval`: "PT30M" (30 minutes)
 *   - `minimumLeadTime`:  "P1D"   (1 day)
 *   - `maximumAdvance`:   "P60D"  (60 days)
 *   - `preBuffer` / `postBuffer`: "PT0S" (0 seconds)
 *
 * This module converts those strings to integer seconds. Returns 0 for empty
 * strings, "PT0S", or any value that doesn't match the supported grammar.
 *
 * Ported from the WordPress plugin's `class-graph-client.php` method
 * `parse_iso_duration_seconds()` (v1.0.12+).
 *
 * Limitations:
 *   - Months ("M" inside the date portion) and years ("Y") are not supported
 *     because their second-count is undefined without a base date. Bookings
 *     does not use these forms in the scheduling-policy fields we consume.
 *   - Weeks ("W") are supported (1 week = 7 days × 86400 seconds).
 *   - Fractional values are not supported (e.g. "PT1.5H"). Bookings emits
 *     integer values only.
 */

/**
 * Regex matches:
 *   P[wW][dD]T[hH][mM][sS]
 * Each component is optional. The leading "P" is required. The "T" is required
 * if any time-component (H, M, S) follows; absent if only date-components
 * (W, D) are used.
 *
 * Capture groups (1..5):
 *   1: weeks
 *   2: days
 *   3: hours
 *   4: minutes
 *   5: seconds
 */
const ISO_DURATION_REGEX =
  /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/**
 * Converts an ISO 8601 duration string to an integer count of seconds.
 *
 * Returns 0 on:
 *   - Empty string
 *   - "PT0S" (an explicit zero)
 *   - Any value that doesn't match the supported grammar (months, years,
 *     fractional values, malformed strings, etc.)
 *
 * @example
 *   parseIsoDurationSeconds('PT30M')  // 1800
 *   parseIsoDurationSeconds('P1D')    // 86400
 *   parseIsoDurationSeconds('P60D')   // 5184000
 *   parseIsoDurationSeconds('PT0S')   // 0
 *   parseIsoDurationSeconds('')       // 0
 *   parseIsoDurationSeconds('P1Y')    // 0  (years not supported)
 *
 * @param duration ISO 8601 duration string.
 * @returns Number of seconds, or 0 if unparseable.
 */
export function parseIsoDurationSeconds(duration: string): number {
  if (!duration || duration === 'PT0S' || duration === 'P0D' || duration === 'P') {
    return 0;
  }

  const match = ISO_DURATION_REGEX.exec(duration);
  if (!match) {
    return 0;
  }

  const weeks = parseInt(match[1] ?? '0', 10);
  const days = parseInt(match[2] ?? '0', 10);
  const hours = parseInt(match[3] ?? '0', 10);
  const minutes = parseInt(match[4] ?? '0', 10);
  const seconds = parseInt(match[5] ?? '0', 10);

  // The regex matches an empty string after "P" (i.e. just "P" with no
  // following components). In that case all groups are 0; the early return
  // above handled "P" exactly, but a string like "PT" still reaches here and
  // sums to 0. Treat that as unparseable rather than zero — callers may want
  // to log the bad input separately.
  if (
    weeks === 0 &&
    days === 0 &&
    hours === 0 &&
    minutes === 0 &&
    seconds === 0
  ) {
    return 0;
  }

  return weeks * 7 * 86400 + days * 86400 + hours * 3600 + minutes * 60 + seconds;
}
