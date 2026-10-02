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

  test('labels a clock time as the reader\'s on request, never midnight', () => {
    expect(
      formatFreebuffStreakResetTime({
        resetAt: RESET_AT,
        now: new Date('2026-09-27T20:00:00.000Z'),
        timeZone: 'Europe/Berlin',
        labelReaderClock: true,
      }),
    ).toBe('9:00 AM tomorrow (your time)')
    expect(
      formatFreebuffStreakResetTime({
        resetAt: RESET_AT,
        now: new Date('2026-09-27T20:00:00.000Z'),
        timeZone: 'America/Los_Angeles',
        labelReaderClock: true,
      }),
    ).toBe('midnight')
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
    ).toBe(
      '+15 added to today\'s allowance until midnight · next +15 after 3:00 PM (your time)',
    )
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
        '+15 expired at your daily reset · next +15 with your first message after 3:00 PM (your time)',
      )
    }
  })

  test('without an expiry (older server) it only says credited', () => {
    expect(getFreebuffStreakBonusStatus({ ...base, todayCredited: true })).toBe(
      '+15 credited · next +15 with your first message after 3:00 PM (your time)',
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
      '+15 expired at your daily reset · next +15 with your first message after 12:30 PM (your time)',
    )
    expect(status).not.toMatch(/today|wallet/i)
  })

  test('a used day without a confirmed credit promises only the next one', () => {
    for (const todayCredited of [false, null, undefined]) {
      expect(getFreebuffStreakBonusStatus({ ...base, todayCredited })).toBe(
        'Next +15 with your first message after 3:00 PM (your time)',
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
    ).toBe('Send a message before 3:00 PM (your time) to earn +15')
  })

  // The 2026-10-01 Desktop report from Dubai (8-day streak): granted at
  // 07:01Z on 09-30 (11:01 AM there), expired at Dubai midnight, and at
  // 9:46 AM on 10-01 the Pacific day had not turned over. The grant was
  // right; the bare "after 11:00 AM" left them asking whether it meant server
  // time or their PC's.
  test('names the reader\'s clock, so an odd hour is not read as server time', () => {
    expect(
      getFreebuffStreakBonusStatus({
        streak: 8,
        todayUsed: true,
        todayCredited: true,
        bonusExpiresAt: null,
        freebucksDailyBonus: 15,
        nextResetAt: '2026-10-01T07:00:00.000Z',
        now: new Date('2026-10-01T05:46:05.697Z'),
        timeZone: 'Asia/Dubai',
      }),
    ).toBe(
      '+15 expired at your daily reset · next +15 with your first message after 11:00 AM (your time)',
    )
  })

  test('compact drops the clock label, and a Pacific midnight never had one', () => {
    expect(
      getFreebuffStreakBonusStatus({ ...base, todayUsed: false, compact: true }),
    ).toBe('Send a message before 3:00 PM to earn +15')
    expect(
      getFreebuffStreakBonusStatus({
        ...base,
        todayUsed: false,
        now: new Date('2026-09-27T20:00:00.000Z'),
        timeZone: 'America/Los_Angeles',
      }),
    ).toBe('Send a message before midnight to earn +15')
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

// Since 2026-10-01 the streak day IS the account's allowance day, so the
// server's `nextResetAt` (and `bonusExpiresAt`) is the account's own midnight.
// A Dubai account, 8-day streak: the day ends at 20:00Z, Dubai midnight.
describe('the streak day is the account day', () => {
  const DUBAI_MIDNIGHT = '2026-10-01T20:00:00.000Z'
  const dubai = {
    streak: 8,
    freebucksDailyBonus: 15,
    nextResetAt: DUBAI_MIDNIGHT,
    // 09:46 in Dubai on 2026-10-01: the report that started this.
    now: new Date('2026-10-01T05:46:00.000Z'),
    timeZone: 'Asia/Dubai',
  }

  test('a reader at home sees midnight, with the bonus lasting until it', () => {
    expect(
      getFreebuffStreakBonusStatus({
        ...dubai,
        todayUsed: true,
        todayCredited: true,
        bonusExpiresAt: DUBAI_MIDNIGHT,
      }),
    ).toBe(
      "+15 added to today's allowance until midnight · next +15 with your first message after that",
    )
    expect(getFreebuffStreakBonusStatus({ ...dubai, todayUsed: true })).toBe(
      'Next +15 with your first message after midnight',
    )
    expect(getFreebuffStreakBonusStatus({ ...dubai, todayUsed: false })).toBe(
      'Send a message before midnight to earn +15',
    )
  })

  test('a reader away from the account timezone gets a labelled clock time', () => {
    expect(
      getFreebuffStreakBonusStatus({
        ...dubai,
        todayUsed: true,
        timeZone: 'Europe/London',
      }),
    ).toBe('Next +15 with your first message after 9:00 PM (your time)')
  })

  // The one interval after a timezone change runs past a day (UTC to Tokyo:
  // from 00:00Z on the 15th to the Tokyo midnight that starts the 17th), so
  // the copy names the weekday instead of a wrong "tomorrow" or "midnight".
  test('a reset more than a day out names its weekday', () => {
    const resetAt = new Date('2026-09-16T15:00:00.000Z')
    expect(
      formatFreebuffStreakResetTime({
        resetAt,
        now: new Date('2026-09-15T01:00:00.000Z'),
        timeZone: 'Asia/Tokyo',
      }),
    ).toBe('12:00 AM Thursday')
    expect(
      formatFreebuffStreakResetTime({
        resetAt,
        now: new Date('2026-09-15T16:00:00.000Z'),
        timeZone: 'Asia/Tokyo',
      }),
    ).toBe('midnight')
  })
})
