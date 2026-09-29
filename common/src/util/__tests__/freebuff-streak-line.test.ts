import { describe, expect, test } from 'bun:test'

import {
  formatFreebuffStreakResetTime,
  getFreebuffStreakBonusStatus,
} from '../freebuff-streak-line'

// The streak day is Pacific; the reset instant below is the Pacific midnight
// that ends 2026-09-27 (PDT, so 07:00 UTC on the 28th). Every reader sees that
// same instant in their own clock — which is the whole point of the copy.
const RESET_AT = new Date('2026-09-28T07:00:00.000Z')

describe('formatFreebuffStreakResetTime', () => {
  test('Pacific readers see midnight', () => {
    expect(
      formatFreebuffStreakResetTime({
        resetAt: RESET_AT,
        now: new Date('2026-09-27T20:00:00.000Z'),
        timeZone: 'America/Los_Angeles',
      }),
    ).toBe('midnight')
  })

  test('Singapore sees 3 PM, today while it is still morning there', () => {
    // 01:00 UTC = 09:00 SGT on the 28th; the Pacific day ends 15:00 SGT.
    expect(
      formatFreebuffStreakResetTime({
        resetAt: RESET_AT,
        now: new Date('2026-09-28T01:00:00.000Z'),
        timeZone: 'Asia/Singapore',
      }),
    ).toBe('3:00 PM')
  })

  test('says tomorrow once that time of day has passed locally', () => {
    // 08:00 UTC on the 27th = 16:00 SGT on the 27th; the next reset is
    // 15:00 SGT on the 28th — a clock time that already went by today.
    expect(
      formatFreebuffStreakResetTime({
        resetAt: RESET_AT,
        now: new Date('2026-09-27T08:00:00.000Z'),
        timeZone: 'Asia/Singapore',
      }),
    ).toBe('3:00 PM tomorrow')
  })

  test('Europe sees the morning reset', () => {
    // 07:00 UTC = 09:00 CEST; at 22:00 CEST the evening before it is tomorrow.
    expect(
      formatFreebuffStreakResetTime({
        resetAt: RESET_AT,
        now: new Date('2026-09-27T20:00:00.000Z'),
        timeZone: 'Europe/Berlin',
      }),
    ).toBe('9:00 AM tomorrow')
  })

  test('half-hour offsets keep their minutes', () => {
    expect(
      formatFreebuffStreakResetTime({
        resetAt: RESET_AT,
        now: new Date('2026-09-28T03:00:00.000Z'),
        timeZone: 'Asia/Kolkata',
      }),
    ).toBe('12:30 PM')
  })
})

describe('getFreebuffStreakBonusStatus', () => {
  const base = {
    streak: 9,
    todayUsed: true,
    freebucksDailyBonus: 15,
    nextResetAt: RESET_AT.toISOString(),
    // 09:00 SGT on the 28th: still the 27th in Pacific.
    now: new Date('2026-09-28T01:00:00.000Z'),
    timeZone: 'Asia/Singapore',
  }

  // The bonus is part of the DAILY allowance, never the wallet: the line says
  // it went to today's allowance and when that allowance resets and takes it
  // away (Singapore midnight, 16:00Z), apart from when the next streak day
  // opens (Pacific midnight, 3:00 PM there).
  test('a granted bonus names today\'s allowance and when it expires', () => {
    expect(
      getFreebuffStreakBonusStatus({
        ...base,
        todayCredited: true,
        bonusExpiresAt: '2026-09-28T16:00:00.000Z',
      }),
    ).toBe('+15 added to today\'s allowance until midnight · next +15 after 3:00 PM')
  })

  test('one reset for both reads once (a Pacific reader)', () => {
    expect(
      getFreebuffStreakBonusStatus({
        ...base,
        todayCredited: true,
        bonusExpiresAt: RESET_AT.toISOString(),
        now: new Date('2026-09-27T20:00:00.000Z'),
        timeZone: 'America/Los_Angeles',
      }),
    ).toBe(
      '+15 added to today\'s allowance until midnight · next +15 with your first message after that',
    )
  })

  test('a bonus whose allowance already reset says it expired', () => {
    for (const bonusExpiresAt of [null, '2026-09-27T16:00:00.000Z']) {
      expect(
        getFreebuffStreakBonusStatus({
          ...base,
          todayCredited: true,
          bonusExpiresAt,
        }),
      ).toBe(
        '+15 expired at your daily reset · next +15 with your first message after 3:00 PM',
      )
    }
  })

  test('without an expiry (older server) it only says credited', () => {
    expect(getFreebuffStreakBonusStatus({ ...base, todayCredited: true })).toBe(
      '+15 credited · next +15 with your first message after 3:00 PM',
    )
  })

  // The 2026-09-29 Desktop report, as the ledger recorded it: a 17-day streak
  // in India, credited at 07:00Z every day (12:30 PM IST). At 11:15 AM IST
  // their local day and daily pool had rolled over, but the Pacific streak day
  // had not — its +15 had landed at 12:30 PM the previous LOCAL day. Now that
  // bonus lived in that local day's allowance and left with its reset.
  test('east of Pacific after local midnight, it never calls the credit "today\'s"', () => {
    const status = getFreebuffStreakBonusStatus({
      streak: 17,
      todayUsed: true,
      todayCredited: true,
      bonusExpiresAt: null,
      freebucksDailyBonus: 15,
      nextResetAt: '2026-09-29T07:00:00.000Z',
      now: new Date('2026-09-29T05:45:20.426Z'),
      timeZone: 'Asia/Kolkata',
    })
    expect(status).toBe(
      '+15 expired at your daily reset · next +15 with your first message after 12:30 PM',
    )
    expect(status).not.toMatch(/today|wallet/i)
  })

  test('a used day without a confirmed credit promises only the next one', () => {
    for (const todayCredited of [false, null, undefined]) {
      expect(getFreebuffStreakBonusStatus({ ...base, todayCredited })).toBe(
        'Next +15 with your first message after 3:00 PM',
      )
    }
  })

  test('an unused day says the message is what pays it, and by when', () => {
    expect(
      getFreebuffStreakBonusStatus({
        ...base,
        todayUsed: false,
        todayCredited: false,
      }),
    ).toBe('Send a message before 3:00 PM to earn +15')
  })

  test('hidden off the meter, below the milestone, or without a reset', () => {
    expect(
      getFreebuffStreakBonusStatus({ ...base, freebucksDailyBonus: null }),
    ).toBeNull()
    expect(getFreebuffStreakBonusStatus({ ...base, streak: 6 })).toBeNull()
    expect(
      getFreebuffStreakBonusStatus({ ...base, nextResetAt: undefined }),
    ).toBeNull()
    expect(
      getFreebuffStreakBonusStatus({ ...base, nextResetAt: 'not a date' }),
    ).toBeNull()
  })

  // A client that held the payload across the reset would describe a day
  // that is already over.
  test('hidden once the reset has passed', () => {
    expect(
      getFreebuffStreakBonusStatus({
        ...base,
        todayCredited: true,
        now: new Date(RESET_AT.getTime() + 1_000),
      }),
    ).toBeNull()
  })
})
