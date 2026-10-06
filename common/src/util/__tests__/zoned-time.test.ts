import { describe, expect, test } from 'bun:test'

import {
  getZonedDayBounds,
  getZonedWeekBounds,
  getZonedYmd,
} from '../zoned-time'

describe('getZonedDayBounds', () => {
  test('returns the current Pacific day bounds on a normal day', () => {
    const bounds = getZonedDayBounds(
      new Date('2026-04-17T16:00:00Z'),
      'America/Los_Angeles',
    )

    expect(bounds.startsAt.toISOString()).toBe('2026-04-17T07:00:00.000Z')
    expect(bounds.resetsAt.toISOString()).toBe('2026-04-18T07:00:00.000Z')
  })

  test('handles the shorter spring-forward Pacific day', () => {
    const bounds = getZonedDayBounds(
      new Date('2026-03-08T09:00:00Z'),
      'America/Los_Angeles',
    )

    expect(bounds.startsAt.toISOString()).toBe('2026-03-08T08:00:00.000Z')
    expect(bounds.resetsAt.toISOString()).toBe('2026-03-09T07:00:00.000Z')
  })

  test('handles the longer fall-back Pacific day', () => {
    const bounds = getZonedDayBounds(
      new Date('2026-11-01T09:00:00Z'),
      'America/Los_Angeles',
    )

    expect(bounds.startsAt.toISOString()).toBe('2026-11-01T07:00:00.000Z')
    expect(bounds.resetsAt.toISOString()).toBe('2026-11-02T08:00:00.000Z')
  })
})

describe('getZonedWeekBounds', () => {
  // The week is Monday-anchored by default. 2026-04-17 is a Friday; its week
  // starts Monday 2026-04-13 and resets the following Monday 2026-04-20, both at
  // Pacific midnight (07:00Z during PDT).
  test('returns Monday→Monday Pacific bounds for a mid-week day', () => {
    const bounds = getZonedWeekBounds(
      new Date('2026-04-17T16:00:00Z'),
      'America/Los_Angeles',
    )

    expect(bounds.startsAt.toISOString()).toBe('2026-04-13T07:00:00.000Z')
    expect(bounds.resetsAt.toISOString()).toBe('2026-04-20T07:00:00.000Z')
  })

  test('groups Sunday into the week that started the prior Monday', () => {
    // 2026-04-19 is the Sunday of the same week, so it must yield identical
    // bounds to the Friday case (Sunday is the LAST day of a Monday-week).
    const bounds = getZonedWeekBounds(
      new Date('2026-04-19T18:00:00Z'),
      'America/Los_Angeles',
    )

    expect(bounds.startsAt.toISOString()).toBe('2026-04-13T07:00:00.000Z')
    expect(bounds.resetsAt.toISOString()).toBe('2026-04-20T07:00:00.000Z')
  })

  test('handles the spring-forward week (start in PST, reset in PDT)', () => {
    // 2026-03-08 (DST switch day) is a Sunday; its week started Monday
    // 2026-03-02 at PST midnight (08:00Z) and resets Monday 2026-03-09 at PDT
    // midnight (07:00Z) — the week itself is one hour short.
    const bounds = getZonedWeekBounds(
      new Date('2026-03-08T18:00:00Z'),
      'America/Los_Angeles',
    )

    expect(bounds.startsAt.toISOString()).toBe('2026-03-02T08:00:00.000Z')
    expect(bounds.resetsAt.toISOString()).toBe('2026-03-09T07:00:00.000Z')
  })

  test('honors a Sunday week start when requested', () => {
    // weekStartsOn=0 → the Friday 2026-04-17 belongs to the week starting
    // Sunday 2026-04-12.
    const bounds = getZonedWeekBounds(
      new Date('2026-04-17T16:00:00Z'),
      'America/Los_Angeles',
      0,
    )

    expect(bounds.startsAt.toISOString()).toBe('2026-04-12T07:00:00.000Z')
    expect(bounds.resetsAt.toISOString()).toBe('2026-04-19T07:00:00.000Z')
  })
})

describe('getZonedYmd', () => {
  test('reports the Pacific day, not the UTC one, after 5pm Pacific', () => {
    // 2026-04-18T02:00Z is still 2026-04-17 in Los Angeles. This is the exact
    // case `toISOString().slice(0, 10)` gets wrong every single evening.
    expect(
      getZonedYmd(new Date('2026-04-18T02:00:00Z'), 'America/Los_Angeles'),
    ).toBe('2026-04-17')
  })

  test('rolls over at Pacific midnight', () => {
    expect(
      getZonedYmd(new Date('2026-04-18T06:59:59Z'), 'America/Los_Angeles'),
    ).toBe('2026-04-17')
    expect(
      getZonedYmd(new Date('2026-04-18T07:00:00Z'), 'America/Los_Angeles'),
    ).toBe('2026-04-18')
  })

  test('is correct across a DST spring-forward boundary', () => {
    // Pacific loses an hour at 2026-03-08T10:00Z. A fixed -8 offset would
    // report the previous day for the hour after the transition.
    expect(
      getZonedYmd(new Date('2026-03-08T09:59:00Z'), 'America/Los_Angeles'),
    ).toBe('2026-03-08')
    expect(
      getZonedYmd(new Date('2026-03-08T10:01:00Z'), 'America/Los_Angeles'),
    ).toBe('2026-03-08')
  })

  test('zero-pads month and day so the string sorts lexicographically', () => {
    // Every consumer sorts and range-filters these as plain strings.
    expect(getZonedYmd(new Date('2026-01-05T18:00:00Z'), 'UTC')).toBe(
      '2026-01-05',
    )
  })

  test('agrees with UTC when asked for UTC', () => {
    expect(getZonedYmd(new Date('2026-09-18T23:30:00Z'), 'UTC')).toBe(
      '2026-09-18',
    )
  })
})

/**
 * getZonedYmd replaced ~15 Pacific-day helpers that formatted with `en-CA`
 * (whose `YYYY-MM-DD` output is an ICU locale convention, not a contract) or
 * joined `formatToParts` themselves. The live wall and the ad rollups key
 * rows by these strings, so the replacement must be exact: pinned values at
 * every Pacific edge, and agreement with each retired expression over a sweep.
 */
describe('getZonedYmd matches every Pacific-day expression it replaced', () => {
  const PT = 'America/Los_Angeles'

  const enCa = new Intl.DateTimeFormat('en-CA', { timeZone: PT })
  const enCaTwoDigit = new Intl.DateTimeFormat('en-CA', {
    timeZone: PT,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const enCaShort = new Intl.DateTimeFormat('en-CA', {
    timeZone: PT,
    dateStyle: 'short',
  })
  const enUsParts = new Intl.DateTimeFormat('en-US', {
    timeZone: PT,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const retired: Record<string, (at: Date) => string> = {
    'en-CA format()': (at) => enCa.format(at),
    'en-CA 2-digit format()': (at) => enCaTwoDigit.format(at),
    'en-CA dateStyle short': (at) => enCaShort.format(at),
    'en-US formatToParts join': (at) => {
      const parts = enUsParts.formatToParts(at)
      const get = (type: string) => parts.find((p) => p.type === type)?.value
      return `${get('year')}-${get('month')}-${get('day')}`
    },
  }

  const EDGES: Array<[string, string]> = [
    // Midnight in PST (UTC-8) and PDT (UTC-7).
    ['2026-01-15T07:59:59.999Z', '2026-01-14'],
    ['2026-01-15T08:00:00.000Z', '2026-01-15'],
    ['2026-07-15T06:59:59.999Z', '2026-07-14'],
    ['2026-07-15T07:00:00.000Z', '2026-07-15'],
    // Spring forward: 02:00 PST -> 03:00 PDT at 10:00Z on 2026-03-08.
    ['2026-03-08T07:59:59.999Z', '2026-03-07'],
    ['2026-03-08T08:00:00.000Z', '2026-03-08'],
    ['2026-03-08T09:59:59.999Z', '2026-03-08'],
    ['2026-03-08T10:00:00.000Z', '2026-03-08'],
    ['2026-03-09T06:59:59.999Z', '2026-03-08'],
    ['2026-03-09T07:00:00.000Z', '2026-03-09'],
    // Fall back: 02:00 PDT -> 01:00 PST at 09:00Z on 2026-11-01.
    ['2026-11-01T06:59:59.999Z', '2026-10-31'],
    ['2026-11-01T07:00:00.000Z', '2026-11-01'],
    ['2026-11-01T08:30:00.000Z', '2026-11-01'],
    ['2026-11-01T09:30:00.000Z', '2026-11-01'],
    ['2026-11-02T07:59:59.999Z', '2026-11-01'],
    ['2026-11-02T08:00:00.000Z', '2026-11-02'],
    // Year and month rollover, leap day.
    ['2027-01-01T07:59:59.999Z', '2026-12-31'],
    ['2027-01-01T08:00:00.000Z', '2027-01-01'],
    ['2028-02-29T08:00:00.000Z', '2028-02-29'],
    ['2028-03-01T07:59:59.999Z', '2028-02-29'],
    ['2028-03-01T08:00:00.000Z', '2028-03-01'],
  ]

  test.each(EDGES)('%s is Pacific day %s', (iso, expected) => {
    const at = new Date(iso)
    expect(getZonedYmd(at, PT)).toBe(expected)
    for (const format of Object.values(retired)) expect(format(at)).toBe(expected)
  })

  test('agrees with each retired expression every 30 minutes through 2026', () => {
    const start = Date.parse('2026-01-01T00:00:00Z')
    const end = Date.parse('2027-01-01T00:00:00Z')
    const mismatches: string[] = []
    for (let ms = start; ms < end; ms += 30 * 60 * 1000) {
      const at = new Date(ms)
      const ymd = getZonedYmd(at, PT)
      for (const [name, format] of Object.entries(retired)) {
        if (format(at) !== ymd) mismatches.push(`${at.toISOString()} ${name}`)
      }
    }
    expect(mismatches).toEqual([])
  })
})
