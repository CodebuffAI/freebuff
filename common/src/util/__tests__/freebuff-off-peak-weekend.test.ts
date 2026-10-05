import { describe, expect, test } from 'bun:test'

import { freebucksOffPeakCopy } from '../freebuff-off-peak-price'
import { offPeakPriceAt } from '../freebuff-price-changes'

// DeepSeek's clock as the fast row publishes it: peak on Beijing weekdays
// 00:00-10:00 UTC, off-peak the rest of the day and all weekend.
const deepseekClock = {
  startHourUtc: 10,
  endHourUtc: 0,
  weekendsOffPeak: true,
  price: 25,
  regularPrice: 45,
}

describe('a policy with weekends off-peak', () => {
  test('is off-peak all weekend, Beijing time, and peak only in the weekday window', () => {
    // Saturday 2026-09-19 03:00Z: a peak hour by the clock, but a Beijing Saturday.
    expect(offPeakPriceAt(deepseekClock, Date.UTC(2026, 8, 19, 3)).price).toBe(
      25,
    )
    // Sunday 15:59Z is still the weekend; 16:00Z is Monday in Beijing, but
    // 16:00Z is off-peak by the clock anyway.
    expect(
      offPeakPriceAt(deepseekClock, Date.UTC(2026, 8, 20, 15, 59)).price,
    ).toBe(25)
    expect(offPeakPriceAt(deepseekClock, Date.UTC(2026, 8, 20, 16)).price).toBe(
      25,
    )
    // Monday 2026-09-21: peak reopens at midnight UTC and closes at 10:00.
    expect(offPeakPriceAt(deepseekClock, Date.UTC(2026, 8, 21, 0)).price).toBe(
      45,
    )
    expect(
      offPeakPriceAt(deepseekClock, Date.UTC(2026, 8, 21, 9, 59)).price,
    ).toBe(45)
    expect(offPeakPriceAt(deepseekClock, Date.UTC(2026, 8, 21, 10)).price).toBe(
      25,
    )
  })

  test('announces the next real change, not the next clock edge', () => {
    // Friday 23:00Z, off-peak: the daily window ends at 00:00Z, but the
    // weekend holds the price until Monday 00:00Z.
    expect(
      offPeakPriceAt(deepseekClock, Date.UTC(2026, 8, 18, 23)).nextChangeAt,
    ).toBe(Date.UTC(2026, 8, 21, 0))
    // Monday 05:00Z, peak: changes at 10:00Z.
    expect(
      offPeakPriceAt(deepseekClock, Date.UTC(2026, 8, 21, 5)).nextChangeAt,
    ).toBe(Date.UTC(2026, 8, 21, 10))
    // Thursday noon, off-peak: changes at Friday 00:00Z.
    expect(
      offPeakPriceAt(deepseekClock, Date.UTC(2026, 8, 17, 12)).nextChangeAt,
    ).toBe(Date.UTC(2026, 8, 18, 0))
  })

  test('a policy without the flag resolves exactly as before', () => {
    const flash = {
      startHourUtc: 22,
      endHourUtc: 6,
      price: 10,
      regularPrice: 15,
    }
    const saturdayNoon = offPeakPriceAt(flash, Date.UTC(2026, 8, 19, 12))
    expect(saturdayNoon.price).toBe(15)
    expect(saturdayNoon.nextChangeAt).toBe(Date.UTC(2026, 8, 19, 22))
    const saturdayNight = offPeakPriceAt(flash, Date.UTC(2026, 8, 19, 23))
    expect(saturdayNight.price).toBe(10)
    expect(saturdayNight.nextChangeAt).toBe(Date.UTC(2026, 8, 20, 6))
    expect(+saturdayNight.start).toBe(Date.UTC(2026, 8, 19, 22))
    expect(+saturdayNight.end).toBe(Date.UTC(2026, 8, 20, 6))
  })

  test("the copy names the weekend in the reader's own clock", () => {
    const copy = freebucksOffPeakCopy(
      { prices: { fast: 25 }, offPeak: { fast: deepseekClock } },
      'fast',
      { now: Date.UTC(2026, 8, 17, 12), timeZone: 'America/Los_Angeles' },
    )!
    expect(copy.tooltip).toBe(
      'Off-peak: 25 Freebucks/hour, daily 3:00 AM–5:00 PM PDT, and all weekend (Fri 9:00 AM–Sun 9:00 AM PDT).',
    )
    expect(copy.active).toBe(true)
  })
})
