import { describe, test, expect } from 'bun:test'

import {
  getFreebuffStreakBonusNote,
  getFreebuffStreakBonusNoteForLayout,
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

describe('getFreebuffStreakBonusNote', () => {
  test('hidden with no streak at all', () => {
    expect(getFreebuffStreakBonusNote({ streak: 0 })).toBeNull()
    expect(getFreebuffStreakBonusNote({ streak: -1 })).toBeNull()
  })
})

describe('getFreebuffStreakBonusNoteForLayout', () => {
  const params = { streak: 7 }
  const note = getFreebuffStreakBonusNote(params)!

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
