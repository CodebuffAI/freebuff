import { describe, expect, test } from 'bun:test'

import { getFreebuffStreakWeekSlots } from '../freebuff-streak-line'

describe('getFreebuffStreakWeekSlots', () => {
  test('no streak: today is the first slot', () => {
    expect(getFreebuffStreakWeekSlots(0, false)).toEqual([
      'today', 'empty', 'empty', 'empty', 'empty', 'empty', 'empty',
    ])
  })

  test('mid-week: done days, then today while it is unsent', () => {
    expect(getFreebuffStreakWeekSlots(3, false)).toEqual([
      'done', 'done', 'done', 'today', 'empty', 'empty', 'empty',
    ])
    expect(getFreebuffStreakWeekSlots(3, true)).toEqual([
      'done', 'done', 'done', 'empty', 'empty', 'empty', 'empty',
    ])
  })

  test('past the week the row stays full', () => {
    expect(getFreebuffStreakWeekSlots(19, false)).toEqual(Array(7).fill('done'))
  })
})
