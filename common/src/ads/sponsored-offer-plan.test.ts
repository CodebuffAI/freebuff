import { describe, expect, test } from 'bun:test'

import {
  sponsoredNeedsUserLabel,
  sponsoredOfferEstimateSeconds,
  sponsoredOfferPlan,
  sponsoredOfferPlanFromWire,
  sponsoredOfferPlanToWire,
  sponsoredOfferSummary,
  sponsoredNeedsUserAnnotations,
} from './sponsored-offer-plan'

const ARCHIL = [
  'Set this project up with Archil storage.',
  '',
  '1. Install the Archil SDK with the project package manager.',
  '2) Add `lib/storage.ts` exporting a client.',
  '   1. Nested numbering is detail, not a step.',
  '   - so are bullets',
  '3. Create the storage volume. needs-user: Archil account',
  '',
  '   Wait for the user to finish signing up before continuing.',
  '4. Wire uploads through the client.',
  '5. Add the env names to `.env.example`.',
  '6. Run the tests (needs-user: approve the test run).',
  '',
  'outcomes: api_key_issued',
].join('\n')

describe('the plan from a procedure', () => {
  test('counts the shared step list and every needs-user annotation', () => {
    const plan = sponsoredOfferPlan({ procedure: ARCHIL })
    // The nested "1." and the bullet are part of step 2, not steps.
    expect(plan.stepCount).toBe(6)
    expect(plan.needsUser).toEqual(['Archil account', 'approve the test run'])
  })

  test('the annotation may sit on a detail line of its step', () => {
    expect(
      sponsoredNeedsUserAnnotations(
        '1. Sign up.\n   needs-user: Archil account\n2. Done.',
      ),
    ).toEqual(['Archil account'])
  })

  test('no numbered lines is no step count, not a guess', () => {
    expect(sponsoredOfferPlan({ procedure: 'Set up storage.' })).toEqual({
      stepCount: null,
      needsUser: [],
      estimateSeconds: null,
    })
  })

  test('an unprintable or overlong label is kept as an unnamed need', () => {
    expect(
      sponsoredNeedsUserAnnotations(
        `1. a needs-user: <script>\n2. b needs-user: ${'x'.repeat(80)}\n3. c needs-user:`,
      ),
    ).toEqual(['', '', ''])
  })
})

describe('sponsoredOfferPlan', () => {
  test('declared credentials need the user too, deduplicated against step marks', () => {
    const plan = sponsoredOfferPlan({
      procedure: [
        '1. Get a key. needs-user: Sieve API key',
        '2. Use it.',
        'requires-credential: env=SIEVE_API_KEY label="Sieve API key"',
        'requires-credential: env=OTHER_TOKEN label="Other token"',
      ].join('\n'),
    })
    expect(plan.needsUser).toEqual(['Sieve API key', 'Other token'])
    expect(plan.stepCount).toBe(2)
  })

  test('the campaign median wins once it has enough perfect runs', () => {
    expect(
      sponsoredOfferEstimateSeconds({
        perfectRunSeconds: [200, 260, 240, 9_999_999, -1],
        stepCount: 6,
      }),
    ).toBe(240)
    expect(
      sponsoredOfferEstimateSeconds({
        perfectRunSeconds: [100, 200, 300, 400],
        stepCount: null,
      }),
    ).toBe(250)
  })

  test('with too little history the fallback is per step, bounded', () => {
    expect(
      sponsoredOfferEstimateSeconds({ perfectRunSeconds: [60], stepCount: 6 }),
    ).toBe(270)
    expect(
      sponsoredOfferEstimateSeconds({ perfectRunSeconds: [], stepCount: 1 }),
    ).toBe(120)
    expect(
      sponsoredOfferEstimateSeconds({ perfectRunSeconds: [], stepCount: 50 }),
    ).toBe(900)
    expect(
      sponsoredOfferEstimateSeconds({ perfectRunSeconds: [], stepCount: null }),
    ).toBeNull()
  })

  test('the wire round-trips', () => {
    const plan = sponsoredOfferPlan({
      procedure: ARCHIL,
      perfectRunSeconds: [230, 240, 250],
    })
    expect(sponsoredOfferPlanFromWire(sponsoredOfferPlanToWire(plan))).toEqual(
      plan,
    )
  })
})

describe('sponsoredOfferSummary', () => {
  test('reads like the issue says it should', () => {
    expect(
      sponsoredOfferSummary({
        stepCount: 6,
        needsUser: ['Archil account'],
        estimateSeconds: 240,
      }),
    ).toBe('6 steps · ~4 min · 1 needs you (Archil account)')
  })

  test('drops what it does not know, and names at most three', () => {
    expect(
      sponsoredOfferSummary({
        stepCount: 1,
        needsUser: [],
        estimateSeconds: null,
      }),
    ).toBe('1 step')
    expect(
      sponsoredOfferSummary({
        stepCount: null,
        needsUser: ['', 'a', 'b', 'c', 'd'],
        estimateSeconds: 20,
      }),
    ).toBe('~1 min · 5 needs you (a, b, c, +1 more)')
    expect(
      sponsoredOfferSummary({
        stepCount: null,
        needsUser: [],
        estimateSeconds: null,
      }),
    ).toBeNull()
    expect(sponsoredOfferSummary(null)).toBeNull()
  })

  test('labels are printable text only', () => {
    expect(sponsoredNeedsUserLabel('Archil account)')).toBe('Archil account')
    expect(sponsoredNeedsUserLabel('a\u001b[2Jb')).toBeNull()
    expect(sponsoredNeedsUserLabel('<b>')).toBeNull()
  })
})
