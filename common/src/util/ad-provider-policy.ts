/** Gravity exclusivity: credentials and routing overrides cannot enable other networks. */
export function isAdProviderEnabled(provider: string): boolean {
  return (
    provider === 'gravity' || provider === 'first_party' || provider === 'house'
  )
}

/**
 * Gravity sees every ad request first, and its answer says what may fill the
 * slot when it declines (agreement of 2026-10-02):
 * - A release: Gravity gave the request back, at random, for about 25% of
 *   traffic. Any first-party ad may fill it, paid or house. In production
 *   this is HTTP 202 with `{ ad: null, release: true, release_reason }`
 *   (`isGravityReleaseEnvelope`, first seen 2026-10-03); a bodyless 205 is
 *   also read as a release.
 * - 204, an empty list, or any other no-fill: only in-house ads (house
 *   campaigns, the subscription ad) may fill it.
 */
export const GRAVITY_RELEASED_NO_FILL_STATUS = 205

/** Gravity's release body; see `GRAVITY_RELEASED_NO_FILL_STATUS`. An envelope
 *  that carries an ad is not a release. */
export function isGravityReleaseEnvelope(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
    return false
  const envelope = payload as Record<string, unknown>
  return (
    envelope.release === true &&
    (envelope.ad === null || envelope.ad === undefined)
  )
}
