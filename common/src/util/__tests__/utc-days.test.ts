import { describe, expect, it } from 'bun:test'

import {
  dayWindowBounds,
  shiftUtcDay,
  todayUtc,
  trailingUtcDays,
} from '../utc-days'

describe('shiftUtcDay', () => {
  it('walks back within a month', () => {
    expect(shiftUtcDay('2026-07-26', -1)).toBe('2026-07-25')
    expect(shiftUtcDay('2026-07-26', -6)).toBe('2026-07-20')
  })

  it('crosses month boundaries', () => {
    expect(shiftUtcDay('2026-07-01', -1)).toBe('2026-06-30')
    expect(shiftUtcDay('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('crosses year boundaries', () => {
    expect(shiftUtcDay('2027-01-01', -1)).toBe('2026-12-31')
  })

  it('handles a leap day', () => {
    expect(shiftUtcDay('2028-03-01', -1)).toBe('2028-02-29')
  })

  it('spans a full 30-day window without drifting', () => {
    expect(shiftUtcDay('2026-07-26', -29)).toBe('2026-06-27')
  })

  it('shifts forward too (the rollup uses +1 for the day-end bound)', () => {
    expect(shiftUtcDay('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('crosses month ends and leap days going forward (day-by-day loops)', () => {
    expect(shiftUtcDay('2026-01-31', 1)).toBe('2026-02-01')
    expect(shiftUtcDay('2026-02-28', 1)).toBe('2026-03-01')
    expect(shiftUtcDay('2024-02-28', 1)).toBe('2024-02-29')
  })

  it('spans a year-long lookback, across a leap day', () => {
    expect(shiftUtcDay('2026-10-06', -365)).toBe('2025-10-06')
    expect(shiftUtcDay('2024-03-01', -366)).toBe('2023-03-01')
  })
})

describe('todayUtc', () => {
  it('returns the UTC date of the given instant', () => {
    expect(todayUtc(new Date('2026-07-26T23:59:59.999Z'))).toBe('2026-07-26')
    expect(todayUtc(new Date('2026-07-26T00:00:00.000Z'))).toBe('2026-07-26')
  })

  it('rolls over at UTC midnight', () => {
    expect(todayUtc(new Date('2026-07-26T00:00:00.000Z'))).toBe('2026-07-26')
    expect(todayUtc(new Date('2026-07-25T23:59:59.999Z'))).toBe('2026-07-25')
  })
})

describe('dayWindowBounds', () => {
  it('returns the half-open [start, end) bounds for a day', () => {
    expect(dayWindowBounds('2026-07-26')).toEqual({
      start: '2026-07-26T00:00:00.000Z',
      end: '2026-07-27T00:00:00.000Z',
    })
  })

  it('crosses month and year boundaries without an off-by-one', () => {
    expect(dayWindowBounds('2026-06-30')).toEqual({
      start: '2026-06-30T00:00:00.000Z',
      end: '2026-07-01T00:00:00.000Z',
    })
    expect(dayWindowBounds('2026-12-31')).toEqual({
      start: '2026-12-31T00:00:00.000Z',
      end: '2027-01-01T00:00:00.000Z',
    })
  })
})

describe('trailingUtcDays', () => {
  it('returns complete days ending the day before today, oldest first', () => {
    expect(trailingUtcDays('2026-07-26', 3)).toEqual([
      '2026-07-23',
      '2026-07-24',
      '2026-07-25',
    ])
  })

  it('never includes today (still accumulating)', () => {
    expect(trailingUtcDays('2026-07-26', 1)).toEqual(['2026-07-25'])
  })

  it('crosses month boundaries', () => {
    expect(trailingUtcDays('2026-07-01', 2)).toEqual([
      '2026-06-29',
      '2026-06-30',
    ])
  })
})
