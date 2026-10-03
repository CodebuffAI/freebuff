/** Gravity exclusivity: credentials and routing overrides cannot enable other networks. */
export function isAdProviderEnabled(provider: string): boolean {
  return (
    provider === 'gravity' || provider === 'first_party' || provider === 'house'
  )
}

/**
 * Gravity sees every ad request first, and its no-fill status says what may
 * fill the slot instead (agreement of 2026-10-02):
 * - 205: Gravity released the request, at random, for about 25% of traffic.
 *   Any first-party ad may fill it, paid or house.
 * - 204, or any other no-fill: only in-house ads (house campaigns, the
 *   subscription ad) may fill it.
 */
export const GRAVITY_RELEASED_NO_FILL_STATUS = 205
