/**
 * When a drawn ad must come off the screen, on every client (web workspace and
 * Desktop, CLI, iOS, Android).
 *
 * Without this an ad stays up for as long as nothing replaces it: the web
 * banner asks for its next ad only while the person is active, and inline,
 * phone and partner ads never rotate at all. Two limits, both counted from
 * when this ad was first drawn (a restored ad keeps its first time):
 *
 * - the cap: no ad stays longer than 2 x the rotation interval, active or not;
 * - away: once it has been shown for one rotation interval, it comes off as
 *   soon as the person is away (idle, or the window or app hidden, unfocused
 *   or in the background).
 *
 * The rotation interval is the cadence arm's `rotationMs` from
 * `/api/v1/ads/policy` (3 min on `reduced`, 1 min on `control`); ads that do
 * not rotate, and clients without the policy, use the `reduced` value. The
 * policy route also sends both limits (`adMaxShownMs`, `adAwayExpiryMs`) so a
 * client can read them as they are.
 *
 * Swift (`ios_client/.../AdExpiry.swift`) and Kotlin
 * (`android_client/.../ads/AdExpiry.kt`) restate these numbers.
 */

/** The rotation interval used when a client has no policy, or the ad does not rotate. */
export const AD_EXPIRY_DEFAULT_ROTATION_MS = 180_000

/** How often a client checks whether a drawn ad has expired. */
export const AD_EXPIRY_CHECK_MS = 15_000

function rotation(rotationMs: number | null | undefined): number {
  return typeof rotationMs === 'number' && Number.isFinite(rotationMs) && rotationMs > 0
    ? rotationMs
    : AD_EXPIRY_DEFAULT_ROTATION_MS
}

/** The hard cap on one ad's time on screen. */
export function adMaxShownMs(rotationMs?: number | null): number {
  return 2 * rotation(rotationMs)
}

/** Shown at least this long, an ad comes off as soon as the person is away. */
export function adAwayExpiryMs(rotationMs?: number | null): number {
  return rotation(rotationMs)
}

export type AdExpiryLimits = { maxShownMs: number; awayExpiryMs: number }

/** Both limits for a rotation interval (the arm's `rotationMs`, or the default). */
export function adExpiryLimits(rotationMs?: number | null): AdExpiryLimits {
  return { maxShownMs: adMaxShownMs(rotationMs), awayExpiryMs: adAwayExpiryMs(rotationMs) }
}

/**
 * Whether an ad first drawn at `shownAt` must come off now. `away` is true
 * while the person is idle or the window or app is hidden, unfocused or in
 * the background. A missing `shownAt` (not drawn yet) never expires.
 */
export function adExpired(input: {
  shownAt: number | null | undefined
  now: number
  away: boolean
  limits?: AdExpiryLimits
}): boolean {
  const { shownAt, now, away } = input
  if (shownAt == null || !Number.isFinite(shownAt)) return false
  const limits = input.limits ?? adExpiryLimits()
  const shown = now - shownAt
  if (shown >= limits.maxShownMs) return true
  return away && shown >= limits.awayExpiryMs
}

/**
 * Milliseconds until the ad expires if the person stays as they are now,
 * for a client that would rather schedule one timer than poll. 0 = expired.
 */
export function adExpiresInMs(input: {
  shownAt: number | null | undefined
  now: number
  away: boolean
  limits?: AdExpiryLimits
}): number | null {
  const { shownAt, now, away } = input
  if (shownAt == null || !Number.isFinite(shownAt)) return null
  const limits = input.limits ?? adExpiryLimits()
  const until = (away ? limits.awayExpiryMs : limits.maxShownMs) - (now - shownAt)
  return Math.max(0, until)
}
