import { describe, expect, it } from 'bun:test'

import {
  COMMUNITY_HANDLE_PATTERN,
  communityLeagueFloor,
  communityLeagueWeek,
  communityVerifiedPlan,
  formatCommunityCount,
} from '../contract'

describe('community plan rules', () => {
  it('puts any paid plan in Silver and Pro in Gold', () => {
    expect(communityLeagueFloor(null)).toBe('bronze')
    expect(communityLeagueFloor('starter')).toBe('silver')
    expect(communityLeagueFloor('plus')).toBe('silver')
    expect(communityLeagueFloor('pro')).toBe('gold')
  })

  it('verifies Plus and up, not Starter', () => {
    expect(communityVerifiedPlan(null)).toBe(false)
    expect(communityVerifiedPlan('starter')).toBe(false)
    expect(communityVerifiedPlan('plus')).toBe(true)
    expect(communityVerifiedPlan('pro')).toBe(true)
  })
})

describe('communityLeagueWeek', () => {
  const week = (iso: string) => {
    const { start, end } = communityLeagueWeek(new Date(iso))
    return [start.toISOString(), end.toISOString()]
  }

  it('runs Monday to Monday in UTC', () => {
    // 2026-11-19 is a Thursday.
    expect(week('2026-11-19T17:00:00Z')).toEqual([
      '2026-11-16T00:00:00.000Z',
      '2026-11-23T00:00:00.000Z',
    ])
  })

  it('keeps Sunday night in the week that is ending and Monday midnight in the next', () => {
    expect(week('2026-11-22T23:59:59Z')[0]).toBe('2026-11-16T00:00:00.000Z')
    expect(week('2026-11-23T00:00:00Z')[0]).toBe('2026-11-23T00:00:00.000Z')
  })

  it('crosses a year boundary', () => {
    expect(week('2027-01-01T12:00:00Z')).toEqual([
      '2026-12-28T00:00:00.000Z',
      '2027-01-04T00:00:00.000Z',
    ])
  })
})

describe('formatCommunityCount', () => {
  it('abbreviates without rounding up into the next unit', () => {
    expect(formatCommunityCount(0)).toBe('0')
    expect(formatCommunityCount(999)).toBe('999')
    expect(formatCommunityCount(1000)).toBe('1K')
    expect(formatCommunityCount(1234)).toBe('1.2K')
    expect(formatCommunityCount(48_200)).toBe('48.2K')
    expect(formatCommunityCount(128_400)).toBe('128K')
    expect(formatCommunityCount(999_499)).toBe('999K')
    expect(formatCommunityCount(999_500)).toBe('1M')
    expect(formatCommunityCount(3_460_000)).toBe('3.5M')
    expect(formatCommunityCount(2_100_000_000)).toBe('2.1B')
  })
})

describe('COMMUNITY_HANDLE_PATTERN', () => {
  it('accepts lowercase handles and refuses the rest', () => {
    for (const ok of ['mara', 'pixel_forge', 'a1b'])
      expect(COMMUNITY_HANDLE_PATTERN.test(ok)).toBe(true)
    for (const bad of ['ab', 'Mara', 'has space', 'a'.repeat(21), 'dash-ed'])
      expect(COMMUNITY_HANDLE_PATTERN.test(bad)).toBe(false)
  })
})
