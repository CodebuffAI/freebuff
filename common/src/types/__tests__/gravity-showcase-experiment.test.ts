import { describe, expect, test } from 'bun:test'

import {
  gravityShowcaseAssignment,
  gravityShowcaseConfig,
} from '../gravity-showcase-experiment'

describe('Gravity Showcase experiment assignment', () => {
  const endsAt = '2026-09-12T08:00:00.000Z'
  const nowMs = Date.parse('2026-09-12T00:00:00.000Z')

  test('is disabled unless both runtime gates are configured', () => {
    expect(
      gravityShowcaseConfig({ percent: 0, domains: 'eon.io', endsAt, nowMs }),
    ).toBeNull()
    expect(
      gravityShowcaseConfig({ percent: 10, domains: '', endsAt, nowMs }),
    ).toBeNull()
    expect(
      gravityShowcaseConfig({
        percent: 10.5,
        domains: 'eon.io',
        endsAt,
        nowMs,
      }),
    ).toBeNull()
    expect(
      gravityShowcaseConfig({ percent: 101, domains: 'eon.io', endsAt, nowMs }),
    ).toBeNull()
    expect(
      gravityShowcaseConfig({
        percent: 10,
        domains: 'eon.io',
        endsAt: '',
        nowMs,
      }),
    ).toBeNull()
    expect(
      gravityShowcaseConfig({
        percent: 10,
        domains: 'eon.io',
        endsAt,
        nowMs: Date.parse(endsAt),
      }),
    ).toBeNull()
  })

  test('normalizes config identity independent of allowlist order and whitespace', () => {
    expect(
      gravityShowcaseConfig({
        percent: 10,
        domains: ' EON.IO,baseten.co',
        endsAt,
        nowMs,
      }),
    ).toEqual(
      gravityShowcaseConfig({
        percent: 10,
        domains: 'baseten.co,eon.io',
        endsAt,
        nowMs,
      }),
    )
  })

  test('assigns deterministically and keeps empty identities out', () => {
    const config = { percent: 10, domains: 'eon.io', endsAt, nowMs }
    expect(gravityShowcaseAssignment({ userId: '', ...config })).toBeNull()
    expect(gravityShowcaseAssignment({ userId: 'user-1', ...config })).toEqual(
      gravityShowcaseAssignment({ userId: 'user-1', ...config }),
    )
  })

  test('100 percent assigns treatment', () => {
    expect(
      gravityShowcaseAssignment({
        userId: 'user-1',
        percent: 100,
        domains: 'eon.io',
        endsAt,
        nowMs,
      })?.arm,
    ).toBe('treatment')
  })
})
