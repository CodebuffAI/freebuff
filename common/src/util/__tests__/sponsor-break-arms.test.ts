import { describe, expect, test } from 'bun:test'

import {
  clampSponsorBreakTimerMs,
  DEFAULT_SPONSOR_BREAK_SPLIT_BPS,
  parseSponsorBreakExperimentMode,
  parseSponsorBreakSplitBps,
  showcaseArmForUser,
  showcaseArmKey,
  SPONSOR_BREAK_ARM_PLACEMENT_IDS,
  SPONSOR_BREAK_ARM_POLICY,
  SPONSOR_BREAK_ARMS,
  sponsorBreakArmForUser,
  sponsorBreakArmKey,
} from '../ad-experiment'

import { PLACEMENT_SLOTS } from '../../constants/freebuff-placements'

import type { SponsorBreakArm } from '../ad-experiment'

/**
 * COD-453 item 5. The properties worth pinning are the ones a readout depends
 * on: `off` is a true no-op, the assignment is STICKY and identical on both
 * rails, and a malformed split cannot half-apply.
 */
describe('the sponsor break arm', () => {
  const users = Array.from({ length: 4_000 }, (_, i) => `user-${i}`)

  test('`off` is control for everyone, with no hash taken', () => {
    for (const userId of users.slice(0, 500)) {
      expect(sponsorBreakArmForUser(userId, { mode: 'off' })).toBe('control')
      expect(showcaseArmForUser(userId, { mode: 'off' })).toBe('control')
    }
  })

  test('`shadow` assigns a real arm — a shadow week that measured nothing would be pointless', () => {
    const arms = new Set(
      users.map((userId) => sponsorBreakArmForUser(userId, { mode: 'shadow' })),
    )
    expect([...arms].sort()).toEqual([...SPONSOR_BREAK_ARMS].sort())
  })

  test('the assignment is sticky: the same user always lands in the same arm', () => {
    for (const userId of users.slice(0, 200)) {
      const first = sponsorBreakArmForUser(userId, { mode: 'on' })
      for (let i = 0; i < 5; i++) {
        expect(sponsorBreakArmForUser(userId, { mode: 'on' })).toBe(first)
      }
    }
  })

  test('the default split is roughly even across the four arms', () => {
    const counts = new Map<SponsorBreakArm, number>()
    for (const userId of users) {
      const arm = sponsorBreakArmForUser(userId, { mode: 'on' })
      counts.set(arm, (counts.get(arm) ?? 0) + 1)
    }
    for (const arm of SPONSOR_BREAK_ARMS) {
      const share = (counts.get(arm) ?? 0) / users.length
      expect(share).toBeGreaterThan(0.2)
      expect(share).toBeLessThan(0.3)
    }
  })

  /**
   * A table summing UNDER 10,000 is how a ramp is expressed: the remainder
   * stays in control rather than being spread over the treatments.
   */
  test('a partial split leaves the remainder in control', () => {
    const splitBps = parseSponsorBreakSplitBps(
      'control=0,reduced=1000,reduced_spotlight=0,reduced_intermission=0',
    )
    const arms = users.map((userId) =>
      sponsorBreakArmForUser(userId, { mode: 'on', splitBps }),
    )
    const reduced = arms.filter((arm) => arm === 'reduced').length
    expect(reduced / users.length).toBeGreaterThan(0.05)
    expect(reduced / users.length).toBeLessThan(0.15)
    expect(arms.every((arm) => arm === 'reduced' || arm === 'control')).toBe(
      true,
    )
  })

  test('an anonymous caller parks in control rather than diluting an arm', () => {
    expect(sponsorBreakArmForUser(null, { mode: 'on' })).toBe('control')
    expect(sponsorBreakArmForUser(undefined, { mode: 'on' })).toBe('control')
    expect(showcaseArmForUser('', { mode: 'on' })).toBe('control')
  })

  test('the break and showcase assignments are independent', () => {
    const bothTreated = users.filter(
      (userId) =>
        sponsorBreakArmForUser(userId, { mode: 'on' }) !== 'control' &&
        showcaseArmForUser(userId, { mode: 'on' }) === 'showcase',
    ).length
    // Independent 75% x 50%; correlated salts would push this to 0 or to 0.75.
    expect(bothTreated / users.length).toBeGreaterThan(0.3)
    expect(bothTreated / users.length).toBeLessThan(0.45)
  })

  test('the sample keys are distinguishable, so one cannot be read as the other', () => {
    expect(sponsorBreakArmKey('u1')).toStartWith('sbk_')
    expect(showcaseArmKey('u1')).toStartWith('swk_')
    expect(sponsorBreakArmKey('u1')).not.toBe(showcaseArmKey('u1'))
  })
})

describe('shrinking the holdout in two steps', () => {
  const moves = (from: string, to: string) => {
    const before = parseSponsorBreakSplitBps(from)
    const after = parseSponsorBreakSplitBps(to)
    const counts = new Map<string, number>()
    const total = 20_000
    for (let i = 0; i < total; i++) {
      const userId = `holdout-user-${i}`
      const move = `${sponsorBreakArmForUser(userId, { mode: 'on', splitBps: before })}>${sponsorBreakArmForUser(userId, { mode: 'on', splitBps: after })}`
      counts.set(move, (counts.get(move) ?? 0) + 1)
    }
    return { counts, total }
  }
  const original =
    'control=5000,reduced=2500,reduced_spotlight=2500,reduced_intermission=0'
  const first =
    'control=5000,reduced=5000,reduced_spotlight=0,reduced_intermission=0'
  const second =
    'control=1000,reduced=9000,reduced_spotlight=0,reduced_intermission=0'

  test('the first step retires the break arm and leaves control alone', () => {
    const { counts } = moves(original, first)
    expect([...counts.keys()].sort()).toEqual([
      'control>control',
      'reduced>reduced',
      'reduced_spotlight>reduced',
    ])
  })

  test('the second step moves people out of control only, and nobody into it', () => {
    const { counts, total } = moves(first, second)
    expect([...counts.keys()].sort()).toEqual([
      'control>control',
      'control>reduced',
      'reduced>reduced',
    ])
    expect(counts.get('control>control')! / total).toBeCloseTo(0.1, 1)
  })
})

describe('parseSponsorBreakSplitBps', () => {
  test('parses a well-formed table', () => {
    expect(
      parseSponsorBreakSplitBps(
        'control=4000,reduced=2000,reduced_spotlight=2000,reduced_intermission=2000',
      ),
    ).toEqual({
      control: 4000,
      reduced: 2000,
      reduced_spotlight: 2000,
      reduced_intermission: 2000,
    })
  })

  /**
   * TOTAL, and whole-table: a half-applied split is a silently unbalanced
   * experiment nobody notices until the readout, while a whole-table fallback
   * is visible the moment anyone compares the knob to the logged arm.
   */
  test('falls back to the default on anything malformed', () => {
    for (const raw of [
      undefined,
      null,
      '',
      '   ',
      'nonsense',
      'control',
      'control=abc',
      'control=-1',
      'control=10001',
      'control=2.5',
      'unknown_arm=2500',
      // Sums past 10,000: the buckets would overlap.
      'control=9000,reduced=9000',
    ]) {
      expect(parseSponsorBreakSplitBps(raw)).toEqual(
        DEFAULT_SPONSOR_BREAK_SPLIT_BPS,
      )
    }
  })
})

describe('the policy tables', () => {
  test('control keeps the original cadence: a 60s rotation on the clock and a pool of four', () => {
    expect(SPONSOR_BREAK_ARM_POLICY.control).toEqual({
      rotationMs: 60_000,
      inlinePoolMax: 4,
      rotateOnlyWhileActive: false,
    })
  })

  test('every reduced arm rotates only while the person is active', () => {
    for (const arm of SPONSOR_BREAK_ARMS.filter((a) => a !== 'control'))
      expect(SPONSOR_BREAK_ARM_POLICY[arm].rotateOnlyWhileActive).toBe(true)
  })

  test('every reduced arm slows and shrinks the inline load', () => {
    for (const arm of SPONSOR_BREAK_ARMS.filter((a) => a !== 'control')) {
      expect(SPONSOR_BREAK_ARM_POLICY[arm].rotationMs).toBeGreaterThan(
        SPONSOR_BREAK_ARM_POLICY.control.rotationMs,
      )
      expect(SPONSOR_BREAK_ARM_POLICY[arm].inlinePoolMax).toBeLessThan(
        SPONSOR_BREAK_ARM_POLICY.control.inlinePoolMax,
      )
    }
  })

  test('`reduced` runs no break, which is what makes it the cadence control', () => {
    expect(SPONSOR_BREAK_ARM_PLACEMENT_IDS.control).toEqual([])
    expect(SPONSOR_BREAK_ARM_PLACEMENT_IDS.reduced).toEqual([])
  })

  /**
   * Every id an arm may hand a client has to exist in the registry and be a
   * break: an arm naming a slot nothing serves is an arm that measures a
   * no-fill.
   */
  test('every arm placement is a real, available break slot', () => {
    for (const arm of SPONSOR_BREAK_ARMS) {
      for (const placementId of SPONSOR_BREAK_ARM_PLACEMENT_IDS[arm]) {
        const slot = PLACEMENT_SLOTS.find((entry) => entry.id === placementId)
        expect(slot).toBeDefined()
        expect(slot!.available).toBe(true)
        expect(slot!.format).not.toBe('inline')
      }
    }
  })
})

describe('the mode and timer knobs', () => {
  test('an unrecognised mode reads as `off`, never as `on`', () => {
    expect(parseSponsorBreakExperimentMode(undefined)).toBe('off')
    expect(parseSponsorBreakExperimentMode('')).toBe('off')
    expect(parseSponsorBreakExperimentMode('true')).toBe('off')
    expect(parseSponsorBreakExperimentMode('ON')).toBe('off')
    expect(parseSponsorBreakExperimentMode('shadow')).toBe('shadow')
    expect(parseSponsorBreakExperimentMode('on')).toBe('on')
  })

  test('the timer clamps rather than rejecting, so a typo cannot break the route', () => {
    expect(clampSponsorBreakTimerMs(undefined)).toBe(3000)
    expect(clampSponsorBreakTimerMs('not-a-number')).toBe(3000)
    expect(clampSponsorBreakTimerMs(0)).toBe(1000)
    expect(clampSponsorBreakTimerMs(-5)).toBe(1000)
    expect(clampSponsorBreakTimerMs(99_999)).toBe(5000)
    expect(clampSponsorBreakTimerMs('2500')).toBe(2500)
  })
})
