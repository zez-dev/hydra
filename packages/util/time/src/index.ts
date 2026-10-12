/**
 * Time vocabulary shared by boundaries that accept a caller's zone or bucket
 * instants into local calendar days. This library owns no failure vocabulary —
 * each boundary declares and throws its own refusal.
 * @module @deepseek-ai/dsh-util-time
 */

/** Strict browser-zone profile: UTC or an IANA Area/Location-style identifier. */
const IANA_TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/

/**
 * Validate and canonicalize one caller-supplied IANA zone at a wire boundary.
 *
 * The canonical name is what a later reader needs: a zone identity is stored on
 * durable records and resolved again by another process, so an alias accepted
 * here would not compare equal to the zone a reader derives.
 * @param value - the caller's reported zone name.
 * @returns the canonical zone, or `undefined` when the name is unusable.
 */
export function canonicalClientTimeZone(value: string): string | undefined {
  if (value.length === 0 || value.trim() !== value
    || (value !== 'UTC' && !IANA_TIME_ZONE.test(value))) return undefined
  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: value })
      .resolvedOptions().timeZone
    /* v8 ignore next -- Intl returns UTC or a canonical IANA Area/Location for accepted input. */
    if (canonical !== 'UTC' && !IANA_TIME_ZONE.test(canonical)) return undefined
    return canonical
  } catch {
    // Intl rejects unsupported zone names; the caller maps that parser rejection.
    return undefined
  }
}

/**
 * Local calendar date of an instant as `YYYY-MM-DD`.
 *
 * The key reads in the host's own zone, so a caller bucketing by day groups
 * the days its user lived through rather than UTC days. Keys compare and sort
 * lexicographically, which is what a range filter over stored keys relies on.
 * @param date - the instant to place.
 * @returns the local date key.
 */
export function localDateKey(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
