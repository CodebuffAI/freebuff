import { describe, expect, test } from 'bun:test'

import {
  clampSponsorBreakDismissLockMs,
  DEFAULT_SPONSOR_BREAK_SPLIT_BPS,
  fnv1a,
  parseSponsorBreakExperimentMode,
  parseSponsorBreakSplitBps,
  parseSponsorBreakSplitBpsDetailed,
  showcaseArmForUser,
  showcaseArmKey,
  SPONSOR_BREAK_ARM_POLICY,
  SPONSOR_BREAK_ARM_SALT,
  SPONSOR_BREAK_ARMS,
  sponsorBreakArmBucket,
  sponsorBreakArmForUser,
  sponsorBreakArmKey,
} from '../ad-experiment'

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

  test('the fallback split is a quarter control, the rest reduced', () => {
    const counts = new Map<SponsorBreakArm, number>()
    for (const userId of users) {
      const arm = sponsorBreakArmForUser(userId, { mode: 'on' })
      counts.set(arm, (counts.get(arm) ?? 0) + 1)
    }
    const control = (counts.get('control') ?? 0) / users.length
    expect(control).toBeGreaterThan(0.2)
    expect(control).toBeLessThan(0.3)
    expect((counts.get('control') ?? 0) + (counts.get('reduced') ?? 0)).toBe(
      users.length,
    )
  })

  /**
   * A table summing UNDER 10,000 is how a ramp is expressed: the remainder
   * stays in control rather than being spread over the treatments.
   */
  test('a partial split leaves the remainder in control', () => {
    const splitBps = parseSponsorBreakSplitBps('control=0,reduced=1000')
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

/**
 * THE HOLDOUT IS LIVE. Removing the two break arms (2026-11-12) must not move
 * a single user between `control` and `reduced`: the same salt, the same
 * `fnv1a(salt:userId) % 10000` bucket, the same cumulative ranges. The old
 * four-arm walk is restated here verbatim as the reference.
 */
describe('removing the break arms moves nobody', () => {
  const OLD_ARMS = [
    'control',
    'reduced',
    'reduced_spotlight',
    'reduced_intermission',
  ] as const
  const oldArmForUser = (userId: string, split: Record<string, number>) => {
    const bucket =
      fnv1a(`ads_sponsor_break_arm_2026_09:${userId}`) % 10_000
    let ceiling = 0
    for (const arm of OLD_ARMS) {
      ceiling += split[arm] ?? 0
      if (bucket < ceiling) return arm
    }
    return 'control'
  }
  const PROD_SPLITS = {
    // main before #10819
    '50/50': {
      raw: 'control=5000,reduced=5000,reduced_spotlight=0,reduced_intermission=0',
      old: {
        control: 5000,
        reduced: 5000,
        reduced_spotlight: 0,
        reduced_intermission: 0,
      },
      controlBelow: 5000,
    },
    // #10819
    '10/90': {
      raw: 'control=1000,reduced=9000,reduced_spotlight=0,reduced_intermission=0',
      old: {
        control: 1000,
        reduced: 9000,
        reduced_spotlight: 0,
        reduced_intermission: 0,
      },
      controlBelow: 1000,
    },
  } as const

  test('the salt and the bucket function are unchanged', () => {
    expect(SPONSOR_BREAK_ARM_SALT).toBe('ads_sponsor_break_arm_2026_09')
    expect(SPONSOR_BREAK_ARMS).toEqual(['control', 'reduced'])
    for (const userId of ['u1', 'user_2abc', 'owen-test']) {
      expect(sponsorBreakArmBucket(userId)).toBe(
        fnv1a(`ads_sponsor_break_arm_2026_09:${userId}`) % 10_000,
      )
    }
    // Pinned literals, so a change to fnv1a itself is caught too.
    expect(sponsorBreakArmBucket('u1')).toBe(5258)
    expect(sponsorBreakArmBucket('user_2abc')).toBe(2662)
    expect(sponsorBreakArmBucket('owen-test')).toBe(7428)
  })

  for (const [name, { raw, old, controlBelow }] of Object.entries(
    PROD_SPLITS,
  )) {
    test(`${name}: every user lands in the arm the four-arm code gave them`, () => {
      const splitBps = parseSponsorBreakSplitBps(raw)
      for (let i = 0; i < 50_000; i++) {
        const userId = `holdout-pin-${i}`
        expect(sponsorBreakArmForUser(userId, { mode: 'on', splitBps })).toBe(
          oldArmForUser(userId, old) as SponsorBreakArm,
        )
      }
    })

    test(`${name}: buckets 0..${controlBelow - 1} are control, ${controlBelow}..9999 reduced`, () => {
      const splitBps = parseSponsorBreakSplitBps(raw)
      // Ids found by search to sit exactly on each boundary bucket.
      const atBucket: Record<number, string> = {
        0: 'pin-2765',
        999: 'pin-847',
        1000: 'pin-12878',
        4999: 'pin-32064',
        5000: 'pin-51',
        9999: 'pin-858',
      }
      for (const [bucket, userId] of Object.entries(atBucket)) {
        expect(sponsorBreakArmBucket(userId)).toBe(Number(bucket))
        expect(sponsorBreakArmForUser(userId, { mode: 'on', splitBps })).toBe(
          Number(bucket) < controlBelow ? 'control' : 'reduced',
        )
      }
      // The short form #10819 could be written as decides identically.
      const short = parseSponsorBreakSplitBps(
        `control=${old.control},reduced=${old.reduced}`,
      )
      expect(short).toEqual(splitBps)
    })
  }
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
  const second = 'control=1000,reduced=9000'

  test('a stale value that still gives Spotlight a share folds it into reduced and leaves control alone', () => {
    const { counts } = moves(original, first)
    expect([...counts.keys()].sort()).toEqual([
      'control>control',
      'reduced>reduced',
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
    expect(parseSponsorBreakSplitBps('control=4000,reduced=6000')).toEqual({
      control: 4000,
      reduced: 6000,
    })
  })

  test('accepts the removed arm keys; a zero share is a no-op', () => {
    expect(
      parseSponsorBreakSplitBpsDetailed(
        'control=5000,reduced=5000,reduced_spotlight=0,reduced_intermission=0',
      ),
    ).toEqual({
      split: { control: 5000, reduced: 5000 },
      foldedRemovedArmBps: 0,
      fellBack: false,
    })
  })

  test('a non-zero removed arm share is folded into reduced and reported, never an error', () => {
    expect(
      parseSponsorBreakSplitBpsDetailed(
        'control=4000,reduced=2000,reduced_spotlight=2000,reduced_intermission=2000',
      ),
    ).toEqual({
      split: { control: 4000, reduced: 6000 },
      foldedRemovedArmBps: 4000,
      fellBack: false,
    })
    // Still bounded: removed shares count toward the 10,000 ceiling.
    expect(
      parseSponsorBreakSplitBpsDetailed(
        'control=5000,reduced=5000,reduced_spotlight=1',
      ).fellBack,
    ).toBe(true)
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
      'reduced_spotlight=',
      // Sums past 10,000: the buckets would overlap.
      'control=9000,reduced=9000',
    ]) {
      expect(parseSponsorBreakSplitBps(raw)).toEqual(
        DEFAULT_SPONSOR_BREAK_SPLIT_BPS,
      )
    }
    expect(DEFAULT_SPONSOR_BREAK_SPLIT_BPS).toEqual({
      control: 2500,
      reduced: 7500,
    })
  })
})

describe('the policy tables', () => {
  test('control keeps the original cadence: a 60s rotation on the clock and a pool of four', () => {
    expect(SPONSOR_BREAK_ARM_POLICY.control).toEqual({
      rotationMs: 60_000,
      inlinePoolMax: 4,
      rotateOnlyWhileActive: false,
      oneAdOnScreen: false,
    })
  })

  test('every reduced arm rotates only while the person is active', () => {
    for (const arm of SPONSOR_BREAK_ARMS.filter((a) => a !== 'control'))
      expect(SPONSOR_BREAK_ARM_POLICY[arm].rotateOnlyWhileActive).toBe(true)
  })

  test('every reduced arm shows at most one ad on screen; control does not', () => {
    expect(SPONSOR_BREAK_ARM_POLICY.control.oneAdOnScreen).toBe(false)
    for (const arm of SPONSOR_BREAK_ARMS.filter((a) => a !== 'control'))
      expect(SPONSOR_BREAK_ARM_POLICY[arm].oneAdOnScreen).toBe(true)
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
})

describe('the mode and dismiss-lock knobs', () => {
  test('an unrecognised mode reads as `off`, never as `on`', () => {
    expect(parseSponsorBreakExperimentMode(undefined)).toBe('off')
    expect(parseSponsorBreakExperimentMode('')).toBe('off')
    expect(parseSponsorBreakExperimentMode('true')).toBe('off')
    expect(parseSponsorBreakExperimentMode('ON')).toBe('off')
    expect(parseSponsorBreakExperimentMode('shadow')).toBe('shadow')
    expect(parseSponsorBreakExperimentMode('on')).toBe('on')
  })

  test('the dismiss lock clamps rather than rejecting, and 0 is legal', () => {
    expect(clampSponsorBreakDismissLockMs(undefined)).toBe(5000)
    expect(clampSponsorBreakDismissLockMs('not-a-number')).toBe(5000)
    expect(clampSponsorBreakDismissLockMs(0)).toBe(0)
    expect(clampSponsorBreakDismissLockMs(-5)).toBe(0)
    expect(clampSponsorBreakDismissLockMs(99_999)).toBe(5000)
    expect(clampSponsorBreakDismissLockMs('2500')).toBe(2500)
  })
})
