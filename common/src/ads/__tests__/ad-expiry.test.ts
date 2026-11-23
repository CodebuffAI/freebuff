import { describe, expect, test } from 'bun:test'

import {
  AD_EXPIRY_DEFAULT_ROTATION_MS,
  adExpired,
  adExpiresInMs,
  adExpiryLimits,
} from '../ad-expiry'

const MIN = 60_000

describe('adExpired', () => {
  const reduced = adExpiryLimits(3 * MIN)

  test.each([
    // [shown for, away, expired]
    [2 * MIN, false, false],
    [2 * MIN, true, false],
    [3 * MIN, false, false],
    [3 * MIN, true, true],
    [6 * MIN - 1, false, false],
    [6 * MIN, false, true],
    [6 * MIN, true, true],
  ] as const)('shown %p ms, away %p -> %p', (shownFor, away, expired) => {
    expect(adExpired({ shownAt: 0, now: shownFor, away, limits: reduced })).toBe(expired)
  })

  test('limits follow the arm: control rotates every minute, so 2 min cap, 1 min away', () => {
    const control = adExpiryLimits(MIN)
    expect(control).toEqual({ maxShownMs: 2 * MIN, awayExpiryMs: MIN })
    expect(adExpired({ shownAt: 0, now: MIN, away: true, limits: control })).toBe(true)
    expect(adExpired({ shownAt: 0, now: 2 * MIN, away: false, limits: control })).toBe(true)
  })

  test('no policy or a bad rotation falls back to the reduced cadence', () => {
    const fallback = {
      maxShownMs: 2 * AD_EXPIRY_DEFAULT_ROTATION_MS,
      awayExpiryMs: AD_EXPIRY_DEFAULT_ROTATION_MS,
    }
    expect(adExpiryLimits()).toEqual(fallback)
    expect(adExpiryLimits(0)).toEqual(fallback)
    expect(adExpiryLimits(Number.NaN)).toEqual(fallback)
  })

  test('an ad not drawn yet never expires', () => {
    expect(adExpired({ shownAt: null, now: 10 * MIN, away: true })).toBe(false)
    expect(adExpiresInMs({ shownAt: undefined, now: 0, away: true })).toBeNull()
  })

  test('adExpiresInMs counts down to the limit that applies now', () => {
    expect(adExpiresInMs({ shownAt: 0, now: MIN, away: false, limits: reduced })).toBe(5 * MIN)
    expect(adExpiresInMs({ shownAt: 0, now: MIN, away: true, limits: reduced })).toBe(2 * MIN)
    expect(adExpiresInMs({ shownAt: 0, now: 7 * MIN, away: false, limits: reduced })).toBe(0)
  })
})
