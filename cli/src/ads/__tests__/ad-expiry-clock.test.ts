import { afterEach, describe, expect, test } from 'bun:test'

import {
  adAway,
  adExpiryLimitsFromPolicy,
  currentAdExpiryLimits,
  isAdExpired,
  noteAdDrawn,
  resetAdExpiryClock,
  setAdExpiryPolicy,
} from '../ad-expiry-clock'

const MIN = 60_000

afterEach(() => resetAdExpiryClock())

describe('the CLI ad expiry clock', () => {
  test('away and shown 3 min: expired', () => {
    noteAdDrawn('a', 0)
    expect(isAdExpired('a', { now: 3 * MIN - 1, away: true })).toBe(false)
    expect(isAdExpired('a', { now: 3 * MIN, away: true })).toBe(true)
  })

  test('active: expired only at the 6 min cap', () => {
    noteAdDrawn('a', 0)
    expect(isAdExpired('a', { now: 6 * MIN - 1, away: false })).toBe(false)
    expect(isAdExpired('a', { now: 6 * MIN, away: false })).toBe(true)
  })

  test('a redraw keeps the first draw time, and an expired ad stays expired', () => {
    noteAdDrawn('a', 0)
    noteAdDrawn('a', 5 * MIN)
    expect(isAdExpired('a', { now: 6 * MIN, away: false })).toBe(true)
    expect(isAdExpired('a', { now: 6 * MIN, away: false })).toBe(true)
    expect(isAdExpired('a', { now: 0, away: false })).toBe(true)
  })

  test('an ad never drawn never expires', () => {
    expect(isAdExpired('never', { now: 60 * MIN, away: true })).toBe(false)
    expect(isAdExpired(undefined)).toBe(false)
  })

  test('away is an unfocused terminal or idle; unknown focus is focused', () => {
    expect(adAway(false, true)).toBe(true)
    expect(adAway(true, false)).toBe(true)
    expect(adAway(undefined, false)).toBe(true)
    expect(adAway(undefined, true)).toBe(false)
    expect(adAway(true, true)).toBe(false)
  })

  test('the policy limits are used, each falling back to the default', () => {
    expect(adExpiryLimitsFromPolicy({})).toEqual({
      maxShownMs: 6 * MIN,
      awayExpiryMs: 3 * MIN,
    })
    expect(
      adExpiryLimitsFromPolicy({ adMaxShownMs: 2 * MIN, adAwayExpiryMs: 'x' }),
    ).toEqual({ maxShownMs: 2 * MIN, awayExpiryMs: 3 * MIN })

    setAdExpiryPolicy({ adMaxShownMs: 2 * MIN, adAwayExpiryMs: MIN })
    noteAdDrawn('a', 0)
    expect(isAdExpired('a', { now: 2 * MIN, away: false })).toBe(true)
    setAdExpiryPolicy(null)
    expect(currentAdExpiryLimits().maxShownMs).toBe(6 * MIN)
  })
})
