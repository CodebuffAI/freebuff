/**
 * The scheduled delivery taper.
 *
 * What has to hold: it starts where it was told to start, it ENDS on the
 * target and stays there, it never wanders outside those two numbers, and the
 * randomization is randomization — different day to day, identical on two
 * reads of the same day. That last property is the one with teeth: a jitter
 * that moved within a day would let a caller reroll the day's ceiling by
 * retrying the request until it got a high one.
 */

import { describe, expect, test } from 'bun:test'

import {
  effectiveDailyBudgetCents,
  engagementsForDailyBudget,
  glidedDailyBudgetCents,
  deliverySpacingSeconds,
  deliveryWindowLimit,
  type BudgetGlide,
} from '../constants/freebuff-ads'

/** An example taper: $600/day down to $150/day over three weeks, ±10%. */
const GLIDE: BudgetGlide = {
  startCents: 60_000,
  targetCents: 15_000,
  days: 21,
  jitterBps: 1_000,
  startedOn: '2026-08-27',
  curve: 'linear',
}
const SEED = '4cf06ebe-f759-4a1c-8f62-78c6d5dd3a12'

function capOn(day: string, glide: BudgetGlide = GLIDE): number {
  return engagementsForDailyBudget(
    glidedDailyBudgetCents({ glide, seed: SEED, today: day }),
  )
}

describe('glidedDailyBudgetCents', () => {
  test('day zero is the starting cap, untouched by jitter', () => {
    expect(capOn('2026-08-27')).toBe(1_200)
  })

  test('the last day and every day after it sit exactly on the target', () => {
    expect(capOn('2026-09-17')).toBe(300)
    expect(capOn('2026-09-18')).toBe(300)
    expect(capOn('2026-12-25')).toBe(300)
  })

  test('a day before the start does not taper anything', () => {
    expect(capOn('2026-08-20')).toBe(1_200)
  })

  test('never leaves the corridor between start and target', () => {
    for (let day = 1; day <= 21; day++) {
      const date = new Date(Date.parse('2026-08-27T00:00:00Z') + day * 86_400_000)
      const cap = capOn(date.toISOString().slice(0, 10))
      expect(cap).toBeLessThanOrEqual(1_200)
      expect(cap).toBeGreaterThanOrEqual(300)
    }
  })

  test('trends down: the second week is below the first, the third below that', () => {
    const week = (from: number) => {
      let total = 0
      for (let day = from; day < from + 7; day++) {
        const date = new Date(
          Date.parse('2026-08-27T00:00:00Z') + day * 86_400_000,
        )
        total += capOn(date.toISOString().slice(0, 10))
      }
      return total / 7
    }
    expect(week(8)).toBeLessThan(week(1))
    expect(week(15)).toBeLessThan(week(8))
  })

  test('the same day always resolves to the same cap', () => {
    const first = capOn('2026-09-03')
    for (let i = 0; i < 25; i++) expect(capOn('2026-09-03')).toBe(first)
  })

  test('the cap actually moves between days rather than following the line', () => {
    const caps = new Set<number>()
    for (let day = 1; day < 21; day++) {
      const date = new Date(
        Date.parse('2026-08-27T00:00:00Z') + day * 86_400_000,
      )
      caps.add(capOn(date.toISOString().slice(0, 10)))
    }
    // A pure straight line over 20 days would give ~20 evenly-spaced values;
    // what matters is that the jitter produced a spread rather than nothing.
    expect(caps.size).toBeGreaterThan(10)
  })

  test('two campaigns on identical taper settings do not move in lockstep', () => {
    const other = 'a8effe69-0b26-4304-a3d1-98bf453424f4'
    let differed = 0
    for (let day = 1; day < 21; day++) {
      const today = new Date(
        Date.parse('2026-08-27T00:00:00Z') + day * 86_400_000,
      )
        .toISOString()
        .slice(0, 10)
      const mine = glidedDailyBudgetCents({ glide: GLIDE, seed: SEED, today })
      const theirs = glidedDailyBudgetCents({ glide: GLIDE, seed: other, today })
      if (mine !== theirs) differed++
    }
    expect(differed).toBeGreaterThan(10)
  })

  test('zero jitter is a plain straight line', () => {
    const straight: BudgetGlide = { ...GLIDE, jitterBps: 0 }
    // A third of the way through (day 7 of 21), a third of the way down:
    // 1200 - (900 / 3) = 900.
    expect(capOn('2026-09-03', straight)).toBe(900)
  })
})

describe('effectiveDailyBudgetCents', () => {
  test('a campaign with no taper is its own budget', () => {
    expect(
      effectiveDailyBudgetCents({
        dailyBudgetCents: 100_000,
        glide: null,
        billedBySubscription: false,
        seed: SEED,
        today: '2026-09-06',
      }),
    ).toBe(100_000)
  })

  test('a BILLED campaign ignores the taper entirely', () => {
    // The fence that matters: capping delivery under a price the advertiser
    // is charged in full is the pause bug in different clothes.
    expect(
      effectiveDailyBudgetCents({
        dailyBudgetCents: 100_000,
        glide: GLIDE,
        billedBySubscription: true,
        seed: SEED,
        today: '2026-09-06',
      }),
    ).toBe(100_000)
  })

  test('an unbilled campaign follows the taper', () => {
    expect(
      effectiveDailyBudgetCents({
        dailyBudgetCents: 100_000,
        glide: { ...GLIDE, jitterBps: 0 },
        billedBySubscription: false,
        seed: SEED,
        today: '2026-09-03',
      }),
    ).toBe(45_000)
  })
})

describe('the exponential curve', () => {
  const DECAY: BudgetGlide = {
    startCents: 15_000, // 300/day
    targetCents: 2_500, // 50/day
    days: 14,
    jitterBps: 0,
    startedOn: '2026-08-28',
    curve: 'exponential',
  }
  const capOnDay = (day: number) =>
    engagementsForDailyBudget(
      glidedDailyBudgetCents({
        glide: DECAY,
        seed: SEED,
        today: new Date(Date.parse('2026-08-28T00:00:00Z') + day * 86_400_000)
          .toISOString()
          .slice(0, 10),
      }),
    )

  test('lands on both endpoints exactly', () => {
    expect(capOnDay(0)).toBe(300)
    expect(capOnDay(14)).toBe(50)
    expect(capOnDay(40)).toBe(50)
  })

  test('front-loads the cut: more comes off in the first quarter than the last', () => {
    // This is the whole reason the shape exists. A linear taper still runs at
    // half volume halfway through, which reads as "still going" on a chart.
    const firstQuarter = capOnDay(0) - capOnDay(3)
    const lastQuarter = capOnDay(11) - capOnDay(14)
    expect(firstQuarter).toBeGreaterThan(lastQuarter * 2)
  })

  test('is below the straight line at every point in between', () => {
    for (let day = 1; day < 14; day++) {
      const linear = 300 - (250 * day) / 14
      expect(capOnDay(day)).toBeLessThan(linear)
    }
  })

  test('never increases from one day to the next', () => {
    for (let day = 1; day <= 14; day++) {
      expect(capOnDay(day)).toBeLessThanOrEqual(capOnDay(day - 1))
    }
  })
})

describe('deliveryWindowLimit', () => {
  const limit = (cap: number, windowKey: string, jitterBps = 2_500) =>
    deliveryWindowLimit({ capEngagements: cap, seed: SEED, windowKey, jitterBps })

  test('an hour gets about a twenty-fourth of the day', () => {
    const value = limit(240, '2026-08-28T09')
    expect(value).toBeGreaterThanOrEqual(8)
    expect(value).toBeLessThanOrEqual(13)
  })

  test('the whole day cannot be spent in one window', () => {
    // The property that matters at the daily reset: the ceiling one minute
    // after midnight is an hour's worth, not a day's.
    for (let hour = 0; hour < 24; hour++) {
      const key = `2026-08-28T${String(hour).padStart(2, '0')}`
      expect(limit(300, key)).toBeLessThan(300 / 4)
    }
  })

  test('the same hour always resolves to the same ceiling', () => {
    const first = limit(300, '2026-08-28T00')
    for (let i = 0; i < 20; i++) expect(limit(300, '2026-08-28T00')).toBe(first)
  })

  test('adjacent hours mostly differ — the regression that shipped first', () => {
    // The keys handed to the hash are a long shared prefix plus two changing
    // characters, and raw FNV-1a leaves those in the low bits. Reading the
    // high bits gave 24 consecutive hours TWO distinct ceilings between them:
    // a "randomized" pace that was a constant with a step in it. The finalizer
    // in `glideHash` is what this asserts.
    const hours = Array.from({ length: 24 }, (_, hour) =>
      limit(300, `2026-08-28T${String(hour).padStart(2, '0')}`),
    )
    const changes = hours.filter((value, i) => i > 0 && value !== hours[i - 1])
    expect(changes.length).toBeGreaterThan(12)
  })

  test('the ceiling moves between hours, so the cadence is not a clock', () => {
    const seen = new Set<number>()
    for (let hour = 0; hour < 24; hour++) {
      seen.add(limit(300, `2026-08-28T${String(hour).padStart(2, '0')}`))
    }
    expect(seen.size).toBeGreaterThan(3)
  })

  test('a day of windows adds up to roughly the daily cap', () => {
    let total = 0
    for (let hour = 0; hour < 24; hour++) {
      total += limit(300, `2026-08-28T${String(hour).padStart(2, '0')}`)
    }
    // Jitter is symmetric, so the windows should sum near the cap rather than
    // systematically over- or under-delivering it.
    expect(total).toBeGreaterThan(240)
    expect(total).toBeLessThan(360)
  })

  test('never drops to zero while the campaign is still running', () => {
    // A taper that has reached 50/day still has to deliver something; a floor
    // of zero would strand its whole tail at no delivery at all.
    expect(limit(50, '2026-08-28T03')).toBeGreaterThanOrEqual(1)
    expect(limit(1, '2026-08-28T03')).toBe(1)
  })

  test('a zero cap delivers nothing', () => {
    expect(limit(0, '2026-08-28T03')).toBe(0)
  })
})

describe('deliverySpacingSeconds', () => {
  const gap = (cap: number, windowKey = '2026-08-28T09', jitterBps = 2_500) =>
    deliverySpacingSeconds({ capEngagements: cap, seed: SEED, windowKey, jitterBps })

  test('a day divided into the day: 300/day is roughly five minutes apart', () => {
    const value = gap(300)
    expect(value).toBeGreaterThan(200)
    expect(value).toBeLessThan(380)
  })

  test('a smaller cap is spaced further apart', () => {
    // The tail of a taper delivers less often, not in a shorter burst.
    expect(gap(50)).toBeGreaterThan(gap(300))
    expect(gap(300)).toBeGreaterThan(gap(2_000))
  })

  test('an hour of spacing roughly reproduces the hourly ceiling', () => {
    // Spacing and the window limit are two expressions of the same rate; if
    // they disagreed badly, one of them would be doing nothing.
    const perHour = 3_600 / gap(300)
    expect(perHour).toBeGreaterThan(9)
    expect(perHour).toBeLessThan(18)
  })

  test('bounded at both ends', () => {
    // A huge cap still gets a floor, so delivery is never instantaneous...
    expect(gap(1_000_000)).toBe(15)
    // ...and a tiny one never waits longer than the window it lives in.
    expect(gap(1)).toBe(3_600)
  })

  test('stable within the hour, different across hours', () => {
    expect(gap(300, '2026-08-28T09')).toBe(gap(300, '2026-08-28T09'))
    const hours = Array.from({ length: 12 }, (_, h) =>
      gap(300, `2026-08-28T${String(h).padStart(2, '0')}`),
    )
    expect(new Set(hours).size).toBeGreaterThan(6)
  })

  test('a zero cap has no spacing to compute', () => {
    expect(gap(0)).toBe(0)
  })
})
