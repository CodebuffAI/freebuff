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

  test('a landed credit says so, and when the next one opens', () => {
    expect(getFreebuffStreakBonusStatus({ ...base, todayCredited: true })).toBe(
      "Today's +15 is in your wallet · next after 3:00 PM",
    )
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
    ).toBe("Send a message before 3:00 PM for today's +15")
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
