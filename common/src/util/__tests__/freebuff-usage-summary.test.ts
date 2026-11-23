import { describe, expect, it } from 'bun:test'

import {
  buildFreebuffUsageGrid,
  buildFreebuffUsageSummary,
  calculateLongestFreebuffStreak,
  summarizeFreebuffLifetimeTokens,
} from '../freebuff-usage-summary'

describe('calculateLongestFreebuffStreak', () => {
  it('finds the longest run rather than the most recent one', () => {
    expect(
      calculateLongestFreebuffStreak([
        '2026-08-01',
        '2026-08-02',
        '2026-08-03',
        '2026-08-04',
        // gap
        '2026-08-10',
        '2026-08-11',
      ]),
    ).toBe(4)
  })

  it('does not extend a run across a gap, unlike the current streak', () => {
    // The current streak deliberately survives "used yesterday, not yet today"
    // because the day is not over. A historical run has no such grace.
    expect(calculateLongestFreebuffStreak(['2026-08-01', '2026-08-03'])).toBe(1)
  })

  it('counts each day once when the input repeats or arrives unsorted', () => {
    expect(
      calculateLongestFreebuffStreak([
        '2026-08-03',
        '2026-08-01',
        '2026-08-02',
        '2026-08-02',
      ]),
    ).toBe(3)
  })

  it('is zero with no history', () => {
    expect(calculateLongestFreebuffStreak([])).toBe(0)
  })

  it('handles a run across a month boundary', () => {
    expect(
      calculateLongestFreebuffStreak([
        '2026-07-30',
        '2026-07-31',
        '2026-08-01',
      ]),
    ).toBe(3)
  })
})

describe('buildFreebuffUsageSummary', () => {
  const activeDates = ['2026-08-10', '2026-08-11', '2026-08-12']

  it('reports the current and longest streak together', () => {
    const summary = buildFreebuffUsageSummary({
      activeDates: [
        // A four-day run that has since lapsed...
        '2026-07-01',
        '2026-07-02',
        '2026-07-03',
        '2026-07-04',
        // ...and a shorter one running right now.
        '2026-08-11',
        '2026-08-12',
      ],
      todayDateKey: '2026-08-12',
    })

    expect(summary.streak.current).toBe(2)
    expect(summary.streak.longest).toBe(4)
    expect(summary.streak.todayUsed).toBe(true)
    expect(summary.streak.lastUsageDate).toBe('2026-08-12')
  })

  it('counts all-time active days regardless of the map window', () => {
    const summary = buildFreebuffUsageSummary({
      activeDates,
      todayDateKey: '2026-08-12',
      windowDays: 2,
    })

    // The window covers 08-11 and 08-12; 08-10 falls outside it but still
    // counts toward the account's history.
    expect(summary.activeDates).toEqual(['2026-08-11', '2026-08-12'])
    expect(summary.allTimeActiveDays).toBe(3)
  })

  it('drops days after today rather than letting a fast clock inflate totals', () => {
    const summary = buildFreebuffUsageSummary({
      activeDates: [...activeDates, '2026-08-13'],
      todayDateKey: '2026-08-12',
    })

    expect(summary.allTimeActiveDays).toBe(3)
    expect(summary.streak.lastUsageDate).toBe('2026-08-12')
  })

  it('sorts and dedupes unordered input before walking the streak', () => {
    const summary = buildFreebuffUsageSummary({
      activeDates: ['2026-08-12', '2026-08-10', '2026-08-11', '2026-08-11'],
      todayDateKey: '2026-08-12',
    })

    expect(summary.streak.current).toBe(3)
    expect(summary.activeDates).toEqual(activeDates)
    expect(summary.allTimeActiveDays).toBe(3)
  })

  it('carries a null recent window through rather than inventing zeros', () => {
    // The token aggregate caps itself with a statement timeout; a timeout must
    // read as "unknown" downstream, never as "you sent nothing".
    const summary = buildFreebuffUsageSummary({
      activeDates,
      todayDateKey: '2026-08-12',
      recent: null,
    })

    expect(summary.recent).toBeNull()
  })

  it('passes the recent window through when it resolved', () => {
    const summary = buildFreebuffUsageSummary({
      activeDates,
      todayDateKey: '2026-08-12',
      recent: {
        days: 7,
        messages: 12,
        inputTokens: 300,
        cacheReadTokens: 50,
        outputTokens: 50,
        totalTokens: 350,
      },
    })

    expect(summary.recent?.messages).toBe(12)
    expect(summary.recent?.totalTokens).toBe(350)
  })
})

describe('buildFreebuffUsageGrid', () => {
  // 2026-08-12 is a Wednesday (weekday 3).
  const todayDateKey = '2026-08-12'
  const todayWeekday = 3

  it('pads to whole weeks so every row is one weekday', () => {
    const grid = buildFreebuffUsageGrid({
      activeDates: [],
      todayDateKey,
      windowDays: 365,
      todayWeekday,
    })

    expect(grid.length % 7).toBe(0)
  })

  it('places today at its own weekday in the final column', () => {
    const grid = buildFreebuffUsageGrid({
      activeDates: [],
      todayDateKey,
      windowDays: 365,
      todayWeekday,
    })

    const lastColumn = grid.slice(grid.length - 7)
    expect(lastColumn[todayWeekday]).toMatchObject({ date: todayDateKey })
    // Everything after today in the final column is padding, not a quiet day —
    // those dates have not happened yet.
    expect(lastColumn.slice(todayWeekday + 1).every((cell) => cell === null)).toBe(
      true,
    )
  })

  it('marks active days and fills the rest as quiet', () => {
    const grid = buildFreebuffUsageGrid({
      activeDates: ['2026-08-11'],
      todayDateKey,
      windowDays: 3,
      todayWeekday,
    })

    const cells = grid.filter((cell) => cell !== null)
    expect(cells).toEqual([
      { date: '2026-08-10', active: false, level: 0 },
      { date: '2026-08-11', active: true, level: 4 },
      { date: '2026-08-12', active: false, level: 0 },
    ])
  })
})

describe('summarizeFreebuffLifetimeTokens', () => {
  const day = (date: string, inputTokens: number, outputTokens: number) => ({
    date,
    inputTokens,
    outputTokens,
  })

  it('never counts a stored day the live read also covers', () => {
    // The nightly roll stored 11-16 and 11-17; the live read starts at 11-17
    // (a stale coverage mark) and covers 11-17 and today.
    const lifetime = summarizeFreebuffLifetimeTokens({
      stored: [day('2026-11-16', 100, 10), day('2026-11-17', 500, 50)],
      live: [day('2026-11-17', 600, 60), day('2026-11-18', 7, 3)],
      liveFrom: '2026-11-17',
      todayDateKey: '2026-11-18',
    })
    expect(lifetime.totalTokens).toBe(110 + 660 + 10)
    expect(lifetime.days).toEqual([
      { date: '2026-11-16', tokens: 110 },
      { date: '2026-11-17', tokens: 660 },
      { date: '2026-11-18', tokens: 10 },
    ])
  })

  it('ignores live rows before the live start and sums split live days', () => {
    const lifetime = summarizeFreebuffLifetimeTokens({
      stored: [day('2026-11-16', 100, 10)],
      // A live row dated before its start would be a stored day counted again.
      live: [
        day('2026-11-16', 999, 999),
        day('2026-11-17', 40, 4),
        day('2026-11-17', 60, 6),
      ],
      liveFrom: '2026-11-17',
      todayDateKey: '2026-11-17',
    })
    expect(lifetime).toMatchObject({
      totalTokens: 110 + 110,
      inputTokens: 200,
      outputTokens: 20,
      peakDay: { date: '2026-11-16', tokens: 110 },
      firstDate: '2026-11-16',
    })
  })

  it('counts all of history but keeps only the window in days', () => {
    const lifetime = summarizeFreebuffLifetimeTokens({
      stored: [day('2024-10-05', 5_000, 500), day('2026-11-10', 10, 0)],
      live: [],
      liveFrom: '2026-11-17',
      todayDateKey: '2026-11-17',
      windowDays: 30,
    })
    expect(lifetime.totalTokens).toBe(5_510)
    expect(lifetime.peakDay).toEqual({ date: '2024-10-05', tokens: 5_500 })
    expect(lifetime.days).toEqual([{ date: '2026-11-10', tokens: 10 }])
  })
})
