import { describe, expect, test } from 'bun:test'

import { dailyStreakXp } from '../../constants/freebuff-xp'
import { streakDayPositions, streakXp } from '../freebuff-xp-streak'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
/** Pacific midnight, 2026-10-01 (PDT): the first account day's start. */
const SWITCH = Date.parse('2026-10-01T07:00:00Z')

/** The `n`th account day after the switch, used an hour after it starts. */
function accountDay(n: number, startShiftMs = 0) {
  const startsAt = SWITCH + n * DAY + startShiftMs
  return {
    startsAt: new Date(startsAt),
    resetsAt: new Date(startsAt + DAY),
    firstAt: new Date(startsAt + HOUR),
  }
}

const days = (...ns: number[]) => ns.map((n) => accountDay(n))

describe('dailyStreakXp', () => {
  test('5 a day in week 1, 5 more each week, 25 from week 5', () => {
    expect([0, 1, 7, 8, 14, 15, 28, 29, 400].map(dailyStreakXp)).toEqual([
      0, 5, 5, 10, 10, 15, 20, 25, 25,
    ])
  })
})

describe('streakDayPositions', () => {
  test('consecutive account days climb; a missed day starts again at 1', () => {
    expect(
      streakDayPositions({
        accountDays: days(0, 1, 2, 4, 5),
        pacificUsageDates: [],
      }),
    ).toEqual([1, 2, 3, 1, 2])
  })

  test('order of the rows does not matter', () => {
    expect(
      streakDayPositions({ accountDays: days(2, 0, 1), pacificUsageDates: [] }),
    ).toEqual([1, 2, 3])
  })

  test('a gap under 20 hours (first enrollment, a tz change) is not a missed day', () => {
    const short = [
      accountDay(0),
      accountDay(1, 11.5 * HOUR),
      accountDay(2, 12 * HOUR),
    ]
    expect(
      streakDayPositions({ accountDays: short, pacificUsageDates: [] }),
    ).toEqual([1, 2, 3])
    // A real missed day is at least 23 hours.
    const missed = [accountDay(0), accountDay(1, 23 * HOUR)]
    expect(
      streakDayPositions({ accountDays: missed, pacificUsageDates: [] }),
    ).toEqual([1, 1])
  })

  test('the Pacific days before the switch count, and the first account day continues them', () => {
    expect(
      streakDayPositions({
        accountDays: days(0, 1),
        pacificUsageDates: ['2026-09-28', '2026-09-29', '2026-09-30'],
      }),
    ).toEqual([1, 2, 3, 4, 5])
  })

  test('a Pacific gap before the switch restarts the first account day', () => {
    expect(
      streakDayPositions({
        accountDays: days(0),
        pacificUsageDates: ['2026-09-27', '2026-09-28'],
      }),
    ).toEqual([1, 2, 1])
  })

  test('Pacific dates from the switch on are the account days, not counted twice', () => {
    expect(
      streakDayPositions({
        accountDays: days(0, 1),
        pacificUsageDates: [
          '2026-09-30',
          '2026-10-01',
          '2026-10-02',
          '2026-10-02',
        ],
      }),
    ).toEqual([1, 2, 3])
  })

  test('an account with only Pacific history', () => {
    expect(
      streakDayPositions({
        accountDays: [],
        pacificUsageDates: [
          '2026-09-02',
          '2026-09-01',
          '2026-09-03',
          '2026-09-05',
        ],
      }),
    ).toEqual([1, 2, 3, 1])
  })
})

describe('streakXp', () => {
  const run = (length: number) => Array.from({ length }, (_, i) => i + 1)

  test('nothing for no history', () => {
    expect(streakXp([])).toBe(0)
  })

  test('a 6-day streak earns its days, a 7-day one its first milestone too', () => {
    expect(streakXp(run(6))).toBe(30)
    expect(streakXp(run(7))).toBe(35 + 250)
  })

  test('a milestone is earned once, however many streaks reach it', () => {
    expect(streakXp([...run(7), ...run(7)])).toBe(70 + 250)
  })

  test('limited access earns a tenth of each day, rounded up to a whole XP', () => {
    // Week one's 5 XP days are 1 each, not 0.5; week two's 10 are 1 too.
    expect(streakXp(run(6), 'limited')).toBe(6)
    expect(streakXp(run(14), 'limited')).toBe(14 + 25)
  })

  test('a 30-day streak', () => {
    expect(streakXp(run(30))).toBe(35 + 70 + 105 + 140 + 2 * 25 + 250 + 1_000)
  })

  test('a year of daily use is about 23,000 XP', () => {
    expect(streakXp(run(365))).toBe(23_025)
  })
})
