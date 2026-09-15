export const FREEBUCKS_TIMEZONE_HEADER = 'x-fb-timezone'

/** A timezone is a scheduling preference, never proof of country or access. */
export function normalizeFreebucksTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100 || !value.trim())
    return null
  try {
    return new Intl.DateTimeFormat('en', {
      timeZone: value.trim(),
    }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

/** Evaluate on every request so travelling does not require an app restart. */
export function freebucksTimeZoneHeaders(): Record<string, string> {
  try {
    return {
      [FREEBUCKS_TIMEZONE_HEADER]:
        Intl.DateTimeFormat().resolvedOptions().timeZone,
    }
  } catch {
    return {}
  }
}
