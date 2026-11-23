import { describe, expect, test } from 'bun:test'

import { freebucksFixture } from '../../testing/freebuff'
import type {
  FreebuffFreebucksInfo,
  FreebuffFreebucksWindow,
} from '../../types/freebuff-session'
import { formatHoursClock } from '../freebuff-hours'
import {
  freebucksDailyShown,
  freebucksDrainEndsAt,
} from '../freebucks-open-hours'
import { getFreebuffModelMeter } from '../freebuff-session-pools'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const T0 = Date.parse('2026-11-11T15:00:00.000Z')
const at = (ms: number) => new Date(ms).toISOString()

/** A limited account's 25 Freebucks (5:00) day, after the given hours were
 *  bought at the given instants, as the server reports it: every price
 *  already in `spent`, and each running hour in `openHours`. */
function pool(
  bought: { amount: number; at: number }[],
  overrides: Partial<FreebuffFreebucksWindow> = {},
): FreebuffFreebucksWindow {
  const spent = bought.reduce((sum, hour) => sum + hour.amount, 0)
  return {
    limit: 25,
    spent,
    remaining: Math.max(0, 25 - spent),
    resetAt: at(T0 + 12 * HOUR),
    openHours: bought.map((hour) => ({
      amount: hour.amount,
      startsAt: at(hour.at),
      endsAt: at(hour.at + HOUR),
    })),
    ...overrides,
  }
}

const shownLeft = (daily: FreebuffFreebucksWindow, nowMs: number) =>
  formatHoursClock(freebucksDailyShown(daily, nowMs).remaining)

describe('a running hour counts down instead of dropping at once', () => {
  test('a just-bought 3-hour session on a 5:00 pool: 5:00, 4:57 a minute later, 2:00 at the hour', () => {
    const daily = pool([{ amount: 15, at: T0 }])
    expect(shownLeft(daily, T0)).toBe('5:00')
    expect(shownLeft(daily, T0 + MINUTE)).toBe('4:57')
    expect(shownLeft(daily, T0 + 30 * MINUTE)).toBe('3:30')
    expect(shownLeft(daily, T0 + HOUR)).toBe('2:00')
  })

  test.each([
    [5, 1],
    [10, 2],
    [15, 3],
  ])(
    'a %p Freebuck (%p-hour) model takes that many minutes a minute',
    (amount, rate) => {
      const daily = pool([{ amount, at: T0 }])
      for (let minute = 0; minute <= 60; minute++) {
        const shown = freebucksDailyShown(daily, T0 + minute * MINUTE)
        expect(Math.round(shown.remaining * 12)).toBe(300 - rate * minute)
      }
    },
  )

  test('two running hours each count at their own rate', () => {
    // A 3-hour model at T0 and a 1-hour one half an hour later.
    const daily = pool([
      { amount: 15, at: T0 },
      { amount: 5, at: T0 + 30 * MINUTE },
    ])
    expect(daily.remaining).toBe(5)
    expect(shownLeft(daily, T0 + 30 * MINUTE)).toBe('3:30')
    // 3 + 1 minutes a minute while both run.
    expect(shownLeft(daily, T0 + 31 * MINUTE)).toBe('3:26')
    // The first has ended: only the second's minute a minute.
    expect(shownLeft(daily, T0 + 60 * MINUTE)).toBe('1:30')
    expect(shownLeft(daily, T0 + 61 * MINUTE)).toBe('1:29')
    expect(shownLeft(daily, T0 + 90 * MINUTE)).toBe('1:00')
  })

  test('at the hour end the shown figures are the real balance', () => {
    const daily = pool([{ amount: 15, at: T0 }])
    for (const nowMs of [T0 + HOUR, T0 + HOUR + 1, T0 + 3 * HOUR]) {
      expect(freebucksDailyShown(daily, nowMs)).toEqual({
        limit: 25,
        spent: 15,
        remaining: 10,
        draining: false,
      })
    }
    expect(freebucksDailyShown(daily, T0 + HOUR - 1).draining).toBe(true)
  })

  test('an hour from before the pool reset is not spread over the new day', () => {
    // Bought at 23:40 before a midnight reset. Until the reset this
    // snapshot's day spreads it; from the reset the hour belonged to the day
    // that ended, so the stale snapshot is shown as it is until a fresh one
    // (whose `openHours` omit it) arrives.
    const daily = pool([{ amount: 15, at: T0 }], {
      resetAt: at(T0 + 20 * MINUTE),
    })
    expect(freebucksDailyShown(daily, T0 + 10 * MINUTE).draining).toBe(true)
    expect(freebucksDailyShown(daily, T0 + 20 * MINUTE)).toEqual({
      limit: 25,
      spent: 15,
      remaining: 10,
      draining: false,
    })
    expect(freebucksDrainEndsAt(daily, T0 + 10 * MINUTE)).toBe(T0 + 20 * MINUTE)
    expect(freebucksDrainEndsAt(daily, T0 + 20 * MINUTE)).toBeUndefined()
  })

  test('an older server sends no running hours, and the figures are unchanged', () => {
    const { openHours: _, ...daily } = pool([{ amount: 15, at: T0 }])
    expect(freebucksDailyShown(daily, T0 + MINUTE)).toEqual({
      limit: 25,
      spent: 15,
      remaining: 10,
      draining: false,
    })
    expect(freebucksDrainEndsAt(daily, T0 + MINUTE)).toBeUndefined()
  })

  test('the reserve never gives back more than was spent, nor shows past a lowered pool', () => {
    // A device's accounts sharing one allowance lower the LIMIT (device-pool.ts).
    const lowered = pool([{ amount: 15, at: T0 }], { limit: 10, remaining: 0 })
    expect(freebucksDailyShown(lowered, T0 + 30 * MINUTE)).toMatchObject({
      spent: 7.5,
      remaining: 2.5,
    })
    const overstated = pool([{ amount: 15, at: T0 }], { spent: 5, remaining: 20 })
    expect(freebucksDailyShown(overstated, T0)).toMatchObject({
      spent: 0,
      remaining: 25,
    })
  })

  test('malformed hours are ignored', () => {
    const daily = pool([], {
      spent: 15,
      remaining: 10,
      openHours: [
        { amount: 15, startsAt: 'never', endsAt: at(T0 + HOUR) },
        { amount: 15, startsAt: at(T0 + HOUR), endsAt: at(T0) },
        { amount: -15, startsAt: at(T0), endsAt: at(T0 + HOUR) },
      ],
    })
    expect(freebucksDailyShown(daily, T0).draining).toBe(false)
    expect(freebucksDrainEndsAt(daily, T0)).toBeUndefined()
  })

  test('the drain ends with the last running hour', () => {
    const daily = pool([
      { amount: 15, at: T0 },
      { amount: 5, at: T0 + 30 * MINUTE },
    ])
    expect(freebucksDrainEndsAt(daily, T0 + MINUTE)).toBe(T0 + 90 * MINUTE)
    expect(freebucksDrainEndsAt(daily, T0 + 90 * MINUTE)).toBeUndefined()
  })
})

describe('the shown figure is never the affordability source', () => {
  test('a row the real balance cannot cover stays locked while the display shows room', () => {
    const daily = pool([{ amount: 15, at: T0 }])
    const fixture = freebucksFixture(10)
    const freebucks: FreebuffFreebucksInfo = {
      ...fixture,
      balance: daily.remaining,
      daily,
      wallet: { ...fixture.wallet, balance: 0 },
      prices: { 'mimo/mimo-v2.5': 15 },
    }
    const nowMs = T0 + MINUTE
    // The meter shows 4:57 left, more than another 3-hour hour costs...
    expect(freebucksDailyShown(daily, nowMs).remaining).toBeGreaterThan(15)
    // ...but the pickers and the server both judge the 10 actually left.
    expect(
      getFreebuffModelMeter({ model: 'mimo/mimo-v2.5', freebucks }).canStart,
    ).toBe(false)
    // And the snapshot itself is untouched.
    expect(freebucks.daily.remaining).toBe(10)
    expect(freebucks.balance).toBe(10)
  })
})
