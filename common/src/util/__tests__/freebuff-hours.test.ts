import { describe, expect, test } from 'bun:test'

import {
  FREEBUCKS_PER_HOUR,
  formatHours,
  formatHoursShort,
  formatHoursWithUnit,
  freebucksToHours,
  freebuffModelMultiplierLabel,
  freebuffMultiplierText,
  freebucksShortfallLine,
} from '../freebuff-hours'

describe('hours', () => {
  test('one hour is 5 Freebucks', () => {
    expect(FREEBUCKS_PER_HOUR).toBe(5)
    expect(freebucksToHours(250)).toBe(50)
    expect(freebucksToHours(37)).toBe(7.4)
  })

  test.each([
    [0, '0'],
    [5, '1'],
    [250, '50'],
    // Whole hours only, rounded down: never more than the balance buys, and
    // never a fraction of an hour.
    [37, '7'],
    [39, '7'],
    [4, '0'],
    [9.99, '1'],
    [-10, '0'],
    [6_500, '1,300'],
  ])('%p Freebucks reads as %p', (freebucks, text) => {
    expect(formatHours(freebucks)).toBe(text)
  })

  test('units', () => {
    expect(formatHoursWithUnit(5)).toBe('1 hour')
    expect(formatHoursWithUnit(250)).toBe('50 hours')
    expect(formatHoursShort(5)).toBe('1 hr')
    expect(formatHoursShort(50)).toBe('10 hrs')
  })

  test.each([
    [10, '2x'],
    [15, '3x'],
    [20, '4x'],
    [25, '5x'],
    [250, '50x'],
    [2, '0.4x'],
    // 1x reads "1x" since 2026-10-17 (MiMo v2.6 Flash Slow).
    [5, '1x'],
    // No label: free (Unlimited), unpriced.
    [0, null],
    [undefined, null],
    [null, null],
    [Number.NaN, null],
  ])('a %p Freebuck row is labelled %p', (price, label) => {
    expect(freebuffModelMultiplierLabel(price)).toBe(label)
  })

  test('multiplier text never leaves a hole in a sentence', () => {
    expect(freebuffMultiplierText(15)).toBe('3x')
    expect(freebuffMultiplierText(5)).toBe('1x')
    expect(freebuffMultiplierText(0)).toBe('free')
  })
})

describe('freebucksShortfallLine', () => {
  test('hours left that cover a 1x hour point at a lower multiplier', () => {
    const { line, cheaperModelFits } = freebucksShortfallLine({
      price: 15,
      balance: 10,
      modelName: 'DeepSeek V4.1 Flash',
    })
    expect(cheaperModelFits).toBe(true)
    expect(line).toBe(
      'An hour of DeepSeek V4.1 Flash uses 3 hours, and you have 2 hours left. Pick a model with a lower multiplier to keep going.',
    )
  })

  test('under one hour left suggests nothing a cheaper metered row could start', () => {
    const { line, cheaperModelFits } = freebucksShortfallLine({
      price: 10,
      balance: 4,
    })
    expect(cheaperModelFits).toBe(false)
    expect(line).toBe(
      'An hour of this model uses 2 hours, and you have less than an hour left.',
    )
  })
})
