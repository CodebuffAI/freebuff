import { describe, expect, test } from 'bun:test'

import {
  DEEPSEEK_EXPENSIVE_WINDOW_UTC,
  DEEPSEEK_WEEKEND_OFFPEAK_EFFECTIVE_AT_UTC,
  deepSeekExpensiveWindowEndsAt,
  deepseekPricingWindow,
  formatDeepSeekExpensiveWindowLocal,
  formatDeepSeekExpensiveWindowReturn,
  formatDeepSeekOffPeakWindowLocal,
  isBeijingWeekend,
  isDeepSeekExpensiveWindow,
} from '../constants/freebuff-peak-hours'

/** A UTC instant on the given hour, on an ordinary day. */
const at = (hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 7, 20, hour, minute))

describe('the peak windows', () => {
  test.each([
    [0, 'off-peak'],
    [1, 'peak'],
    [3, 'peak'],
    [4, 'off-peak'],
    [5, 'off-peak'], // the gap BETWEEN the two windows — what a single range
    [6, 'peak'], //     check silently gets wrong
    [9, 'peak'],
    [10, 'off-peak'],
    [23, 'off-peak'],
  ])('%i:00 UTC is %s', (hour, window) => {
    expect(deepseekPricingWindow(at(hour as number))).toBe(window as any)
  })

  test('treats boundaries as half-open, so the closing hour is already off-peak', () => {
    expect(deepseekPricingWindow(at(3, 59))).toBe('peak')
    expect(deepseekPricingWindow(at(4, 0))).toBe('off-peak')
    expect(deepseekPricingWindow(at(9, 59))).toBe('peak')
    expect(deepseekPricingWindow(at(10, 0))).toBe('off-peak')
  })
})

describe('the expensive window', () => {
  // The one thing still keyed to the clock: V4 Pro pauses inside it. A user's
  // spend ceiling is deliberately NOT — it is the same figure at every hour.
  test('runs an hour ahead of the first peak through the last one’s close', () => {
    expect(DEEPSEEK_EXPENSIVE_WINDOW_UTC).toEqual([0, 10])
  })

  test.each([
    [0, true], // the lead hour: sessions admitted here still run into peak
    [2, true],
    [5, true], // swallows the off-peak gap rather than reopening for two hours
    [9, true],
    [10, false],
    [23, false],
  ])('%i:00 UTC expensive=%p', (hour, expensive) => {
    expect(isDeepSeekExpensiveWindow(at(hour as number))).toBe(
      expensive as boolean,
    )
  })

  test('reports the close, and leaves instants outside it alone', () => {
    expect(deepSeekExpensiveWindowEndsAt(at(2)).toISOString()).toBe(
      at(10).toISOString(),
    )
    expect(deepSeekExpensiveWindowEndsAt(at(14)).toISOString()).toBe(
      at(14).toISOString(),
    )
  })
})

describe('the Beijing weekend boundary', () => {
  test.each([
    ['2026-08-28T15:00:00Z', false],
    ['2026-08-28T16:00:00Z', true],
    ['2026-08-30T15:00:00Z', true],
    ['2026-08-30T16:00:00Z', false],
  ])('%s isBeijingWeekend=%p', (instant, weekend) => {
    expect(isBeijingWeekend(new Date(instant as string))).toBe(
      weekend as boolean,
    )
  })

  test('does not apply the weekend rule before its effective instant', () => {
    expect(DEEPSEEK_WEEKEND_OFFPEAK_EFFECTIVE_AT_UTC).toBe(
      Date.parse('2026-08-22T16:00:00Z'),
    )
    expect(deepseekPricingWindow(new Date('2026-08-22T09:59:59Z'))).toBe('peak')
    expect(isDeepSeekExpensiveWindow(new Date('2026-08-22T02:00:00Z'))).toBe(
      true,
    )
  })

  test('applies the weekend rule from its effective instant onward', () => {
    expect(deepseekPricingWindow(new Date('2026-08-23T01:30:00Z'))).toBe(
      'off-peak',
    )
    expect(isDeepSeekExpensiveWindow(new Date('2026-08-23T02:00:00Z'))).toBe(
      false,
    )
  })
})

test.each(['2026-08-29T02:00:00Z', '2026-08-30T02:00:00Z'])(
  '%s uses weekend rates in Beijing',
  (instant) => {
    const date = new Date(instant)
    expect(deepseekPricingWindow(date)).toBe('off-peak')
    expect(isDeepSeekExpensiveWindow(date)).toBe(false)
  },
)

/**
 * The 2026-08-26 report: a user in Germany was told V4 Flash was back "again at
 * 10:00 AM" at 10:34 on their own clock — a moment that read as already past.
 * It was 10:00 UTC, so noon for them, and nothing in the sentence said which
 * clock it meant. These formatters run on the server as often as in a picker,
 * so the zone is not optional decoration; it is what makes the string answerable
 * by a reader who is not in the process that wrote it.
 */
describe('every window names the clock it is quoted in', () => {
  const insideWindow = at(8)

  test('the return time says UTC when the caller asks for UTC', () => {
    expect(formatDeepSeekExpensiveWindowReturn(insideWindow, 'UTC')).toBe(
      'again at 10:00 AM UTC',
    )
  })

  test('the same instant, quoted for a reader in Berlin, is noon — and says so', () => {
    const berlin = formatDeepSeekExpensiveWindowReturn(
      insideWindow,
      'Europe/Berlin',
    )
    // The whole bug in one assertion: the digits differ from the UTC rendering,
    // so a string that named no zone was wrong for this reader by two hours.
    expect(berlin).toContain('12:00 PM')
    expect(berlin).not.toContain('10:00 AM')
    expect(berlin).toMatch(/GMT\+2|CEST/)
  })

  test('a range labels its zone ONCE, at the end', () => {
    const closed = formatDeepSeekExpensiveWindowLocal(insideWindow, 'UTC')
    expect(closed).toBe('12:00 AM – 10:00 AM UTC')
    expect(closed.match(/UTC/g)).toHaveLength(1)
  })

  test('the open window is the closed one inverted, and labelled too', () => {
    expect(formatDeepSeekOffPeakWindowLocal(insideWindow, 'UTC')).toBe(
      '10:00 AM – 12:00 AM UTC',
    )
  })

  test('an unknown zone falls back to UTC rather than to the host process', () => {
    // `timeZone: undefined` resolves to whatever the PROCESS runs in, which is
    // the reader in a browser and a Render container on the server. Only the
    // explicit argument is deterministic, which is why the server passes one.
    expect(formatDeepSeekExpensiveWindowReturn(insideWindow, 'UTC')).toBe(
      formatDeepSeekExpensiveWindowReturn(insideWindow, 'Etc/UTC'),
    )
  })
})
