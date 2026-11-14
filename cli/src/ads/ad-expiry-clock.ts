/**
 * AD EXPIRY in the CLI: how long each drawn ad has been on screen, and
 * whether it must come off now, under the shared rule
 * (`common/src/ads/ad-expiry.ts`): no ad stays longer than the cap, and one
 * shown for the away limit comes off as soon as the person is away.
 *
 * Away here is the terminal reporting itself unfocused, or no input for
 * {@link AD_AWAY_IDLE_MS}. A terminal that never reports focus (no DEC 1004)
 * counts as focused, so idle is then the only away signal.
 *
 * One clock for every placement (the dock above the input, the end-of-answer
 * card or link, the display units, the partner rows), keyed by `impUrl`: the
 * first draw starts it and a redraw of the same impression keeps that start,
 * so an ad re-shown from a cache or a 30-minute hold is as old as its first
 * draw. Once expired, an impression stays expired: it is never drawn again.
 */
import {
  AD_EXPIRY_CHECK_MS,
  adExpired,
  adExpiryLimits,
  type AdExpiryLimits,
} from '@codebuff/common/ads/ad-expiry'
import { useEffect, useState } from 'react'

import { getAdTerminalFocus } from './ad-signals'
import { adEngagementRegistry } from './use-ad-engagement'
import { isUserActive } from '../utils/activity-tracker'

/** No input for this long is away (the activity tracker's idle threshold). */
export const AD_AWAY_IDLE_MS = 30_000

/** First-draw times kept; the oldest is forgotten past this. */
const MAX_TRACKED = 500

let policyLimits: AdExpiryLimits | null = null
const shownAt = new Map<string, number>()
const expired = new Set<string>()

function positiveMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null
}

/**
 * The limits off the `/api/v1/ads/policy` body (`adMaxShownMs`,
 * `adAwayExpiryMs`), each falling back to the default rotation's value when
 * absent or not a positive number (an older server).
 */
export function adExpiryLimitsFromPolicy(body: unknown): AdExpiryLimits {
  const fallback = adExpiryLimits()
  const data = (typeof body === 'object' && body !== null ? body : {}) as {
    adMaxShownMs?: unknown
    adAwayExpiryMs?: unknown
  }
  return {
    maxShownMs: positiveMs(data.adMaxShownMs) ?? fallback.maxShownMs,
    awayExpiryMs: positiveMs(data.adAwayExpiryMs) ?? fallback.awayExpiryMs,
  }
}

/** Record the session's limits from the policy body; `null` = the defaults. */
export function setAdExpiryPolicy(body: unknown): void {
  policyLimits = body == null ? null : adExpiryLimitsFromPolicy(body)
}

export function currentAdExpiryLimits(): AdExpiryLimits {
  return policyLimits ?? adExpiryLimits()
}

/** Whether the person is away: the terminal unfocused, or idle. */
export function adAway(
  focused: boolean | undefined = getAdTerminalFocus(),
  active: boolean = isUserActive(AD_AWAY_IDLE_MS),
): boolean {
  return focused === false || !active
}

/** The impression is drawn: starts its clock on the first draw only. */
export function noteAdDrawn(impUrl: string | undefined, now = Date.now()): void {
  if (!impUrl || shownAt.has(impUrl)) return
  if (shownAt.size >= MAX_TRACKED) {
    const oldest = shownAt.keys().next().value
    if (oldest !== undefined) {
      shownAt.delete(oldest)
      expired.delete(oldest)
    }
  }
  shownAt.set(impUrl, now)
}

export function adShownAt(impUrl: string): number | undefined {
  return shownAt.get(impUrl)
}

/**
 * Whether the impression must come off (or stay off) now. Never drawn means
 * never expired; once expired, always expired.
 */
export function isAdExpired(
  impUrl: string | undefined,
  input: { now?: number; away?: boolean } = {},
): boolean {
  if (!impUrl) return false
  if (expired.has(impUrl)) return true
  const first = shownAt.get(impUrl)
  if (first === undefined) return false
  const gone = adExpired({
    shownAt: first,
    now: input.now ?? Date.now(),
    away: input.away ?? adAway(),
    limits: currentAdExpiryLimits(),
  })
  if (gone) expired.add(impUrl)
  return gone
}

/** Tell the engagement record why the ad is coming off (`endedBy: 'expired'`). */
export function noteAdExpiredEngagement(impUrl: string): void {
  try {
    adEngagementRegistry().noteExpired(impUrl)
  } catch {
    // engagement must never break the ad
  }
}

/** Test seam. */
export function resetAdExpiryClock(): void {
  policyLimits = null
  shownAt.clear()
  expired.clear()
}

/**
 * For a unit that draws one impression: true once it has expired, checked
 * every {@link AD_EXPIRY_CHECK_MS}. The flip notes the engagement record, so
 * the unit unmounting next ends it as an expiry.
 */
export function useAdExpired(impUrl: string | undefined | null): boolean {
  const key = impUrl ?? undefined
  const [expiredUrl, setExpiredUrl] = useState<string | null>(null)
  const isExpired = key !== undefined && expiredUrl === key
  useEffect(() => {
    if (!key || isExpired) return
    const check = () => {
      if (!isAdExpired(key)) return false
      noteAdExpiredEngagement(key)
      setExpiredUrl(key)
      return true
    }
    if (check()) return
    const id = setInterval(check, AD_EXPIRY_CHECK_MS)
    ;(id as { unref?: () => void }).unref?.()
    return () => clearInterval(id)
  }, [key, isExpired])
  return isExpired
}
