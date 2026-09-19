import { describe, test, expect } from 'bun:test'

import {
  FREEBUFF_STREAK_INLINE_GAP,
  fitsFreebuffStreakOnHeadingRow,
  getFreebuffStreakBonusNote,
  getFreebuffStreakBonusNoteForLayout,
  getFreebuffStreakInlineWidth,
  getFreebuffStreakLine,
} from '../freebuff-streak-line'

// The CLI draws the shared ●/○ pair: filled-vs-hollow is what makes a partial
// week distinguishable from a full one at a glance, which • and · (same shape,
// different size) never managed.
describe('getFreebuffStreakLine', () => {
  test('hides the row for new / lapsed users (streak <= 0)', () => {
    expect(getFreebuffStreakLine(0)).toBeNull()
    expect(getFreebuffStreakLine(-1)).toBeNull()
  })

  test('labels and fills dots for an active streak', () => {
    expect(getFreebuffStreakLine(2)).toEqual({
      label: '2 day streak',
      dots: '●●○○○○○',
      progress: { filled: 2, total: 7, beyond: false },
    })
  })

  test('"day" stays singular as a compound modifier', () => {
    expect(getFreebuffStreakLine(1)?.label).toBe('1 day streak')
    expect(getFreebuffStreakLine(5)?.label).toBe('5 day streak')
  })

  test('fills the whole week on a 7-day milestone', () => {
    expect(getFreebuffStreakLine(7)).toEqual({
      label: '7 day streak',
      dots: '●●●●●●●',
      // filled === total is how a surface without the constant knows the
      // milestone is earned (the desktop banner gates its perk line on it)
      progress: { filled: 7, total: 7, beyond: false },
    })
  })

  test('stays full and gains a "+" once the streak passes the week', () => {
    expect(getFreebuffStreakLine(9)).toEqual({
      label: '9 day streak',
      dots: '●●●●●●●+',
      progress: { filled: 7, total: 7, beyond: true },
    })
    expect(getFreebuffStreakLine(19)).toEqual({
      label: '19 day streak',
      dots: '●●●●●●●+',
      progress: { filled: 7, total: 7, beyond: true },
    })
  })
})

describe('fitsFreebuffStreakOnHeadingRow', () => {
  const headingWidth = 'Start coding for free'.length
  const line = getFreebuffStreakLine(18)!
  // "18 day streak" + 2 + "●●●●●●●+"
  const inlineWidth = getFreebuffStreakInlineWidth(line)
  const exact = headingWidth + FREEBUFF_STREAK_INLINE_GAP + inlineWidth

  test('measures the label and dots together', () => {
    expect(inlineWidth).toBe(23)
  })

  test('shares the row only when the gap is fully clear', () => {
    expect(
      fitsFreebuffStreakOnHeadingRow({
        line,
        headingWidth,
        availableWidth: exact,
      }),
    ).toBe(true)
    expect(
      fitsFreebuffStreakOnHeadingRow({
        line,
        headingWidth,
        availableWidth: exact - 1,
      }),
    ).toBe(false)
  })

  test('measures an empty slot as the day-one streak it will become', () => {
    const dayOne = getFreebuffStreakLine(1)!
    const width = headingWidth + FREEBUFF_STREAK_INLINE_GAP
    expect(
      fitsFreebuffStreakOnHeadingRow({
        line: null,
        headingWidth,
        availableWidth: width + getFreebuffStreakInlineWidth(dayOne),
      }),
    ).toBe(true)
    expect(
      fitsFreebuffStreakOnHeadingRow({
        line: null,
        headingWidth,
        availableWidth: width + getFreebuffStreakInlineWidth(dayOne) - 1,
      }),
    ).toBe(false)
  })

  // A three-digit streak widens its own label, so the cutoff has to follow the
  // rendered strings rather than a fixed column count.
  test('accounts for the label growing with the day count', () => {
    const long = getFreebuffStreakLine(365)!
    expect(getFreebuffStreakInlineWidth(long)).toBeGreaterThan(inlineWidth)
    expect(
      fitsFreebuffStreakOnHeadingRow({
        line: long,
        headingWidth,
        availableWidth: exact,
      }),
    ).toBe(false)
  })
})

describe('getFreebuffStreakBonusNote', () => {
  test('hidden with no streak at all', () => {
    expect(
      getFreebuffStreakBonusNote({ streak: 0, accessTier: 'full' }),
    ).toBeNull()
    expect(
      getFreebuffStreakBonusNote({ streak: -1, accessTier: 'limited' }),
    ).toBeNull()
  })

  test('teases the unlock countdown below the 7-day milestone', () => {
    expect(getFreebuffStreakBonusNote({ streak: 3, accessTier: 'full' })).toBe(
      '🎁 4 more days to unlock +1 bonus session every day + 1 reward session each day',
    )
    expect(
      getFreebuffStreakBonusNote({ streak: 3, accessTier: 'limited' }),
    ).toBe('🎁 4 more days to unlock +1 bonus session every day')
  })

  test('"day" goes singular on the eve of the milestone', () => {
    expect(
      getFreebuffStreakBonusNote({ streak: 6, accessTier: 'limited' }),
    ).toBe('🎁 1 more day to unlock +1 bonus session every day')
  })

  test('full access advertises the daily session + daily GLM perk at 7+', () => {
    const note = getFreebuffStreakBonusNote({ streak: 7, accessTier: 'full' })
    expect(note).toBe(
      '🎁 Streak perk: +1 bonus session every day + 1 reward session each day',
    )
  })

  test('the GLM streak count grows per completed 7 days, capped at 4', () => {
    expect(getFreebuffStreakBonusNote({ streak: 14, accessTier: 'full' })).toBe(
      '🎁 Streak perk: +1 bonus session every day + 2 reward sessions each day',
    )
    expect(getFreebuffStreakBonusNote({ streak: 35, accessTier: 'full' })).toBe(
      '🎁 Streak perk: +1 bonus session every day + 4 reward sessions each day',
    )
  })

  test('limited access advertises only the daily session perk', () => {
    const note = getFreebuffStreakBonusNote({
      streak: 14,
      accessTier: 'limited',
    })
    expect(note).toBe('🎁 Streak perk: +1 bonus session every day')
  })

  // On the Freebucks meter a session bonus buys nothing, so the perk is the
  // wallet credit the server reports — for both tiers, and in the countdown.
  test('on the meter the perk is the daily Freebucks credit', () => {
    expect(
      getFreebuffStreakBonusNote({
        streak: 14,
        accessTier: 'full',
        freebucksDailyBonus: 15,
      }),
    ).toBe('🎁 Streak perk: +15 Freebucks every Pacific day')
    expect(
      getFreebuffStreakBonusNote({
        streak: 14,
        accessTier: 'limited',
        freebucksDailyBonus: 15,
      }),
    ).toBe('🎁 Streak perk: +15 Freebucks every Pacific day')
    expect(
      getFreebuffStreakBonusNote({
        streak: 3,
        accessTier: 'full',
        freebucksDailyBonus: 15,
      }),
    ).toBe('🎁 4 more days to unlock +15 Freebucks every Pacific day')
    // An older server sends no field; null keeps the session copy.
    expect(
      getFreebuffStreakBonusNote({
        streak: 14,
        accessTier: 'limited',
        freebucksDailyBonus: null,
      }),
    ).toBe('🎁 Streak perk: +1 bonus session every day')
  })
})

describe('getFreebuffStreakBonusNoteForLayout', () => {
  const params = {
    streak: 7,
    accessTier: 'full' as const,
  }
  const note = getFreebuffStreakBonusNote(params)!

  test('hides the unlock countdown before the bonus is earned', () => {
    expect(
      getFreebuffStreakBonusNoteForLayout({
        ...params,
        streak: 6,
        terminalHeight: 30,
        availableWidth: 200,
      }),
    ).toBeNull()
  })

  test('hides the earned note below 30 rows', () => {
    expect(
      getFreebuffStreakBonusNoteForLayout({
        ...params,
        terminalHeight: 29,
        availableWidth: note.length,
      }),
    ).toBeNull()
  })

  test('shows the earned note at 30 rows when it fits on one line', () => {
    expect(
      getFreebuffStreakBonusNoteForLayout({
        ...params,
        terminalHeight: 30,
        availableWidth: note.length,
      }),
    ).toBe(note)
  })

  test('hides the earned note when it would wrap', () => {
    expect(
      getFreebuffStreakBonusNoteForLayout({
        ...params,
        terminalHeight: 30,
        availableWidth: note.length - 1,
      }),
    ).toBeNull()
  })
})
