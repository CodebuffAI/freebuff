import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_FIRST_PARTY_BACKFILL,
  DEFAULT_FIRST_PARTY_PRIMARY_PERCENT,
  IMPREZIA_EXPERIMENT_PERCENT,
  adExperimentArmForUser,
  firstPartyAdRouteForUser,
  firstPartyAdRouteForGeoRequest,
  firstPartyArmKey,
  FIRST_PARTY_ARM_SALT,
  fnv1a,
  firstPartyPrimaryBucket,
  firstPartyPrimaryBasisPoints,
  houseLegOpen,
  houseSubscriptionBillingArmForUser,
  isImpreziaAudienceEmail,
  parseHouseSubscriptionBillingExperimentMode,
} from '../ad-experiment'

describe('house subscription billing experiment', () => {
  test('defaults unknown and absent modes off', () => {
    for (const value of [undefined, null, '', 'ON', 'shadow']) {
      expect(parseHouseSubscriptionBillingExperimentMode(value)).toBe('off')
    }
    expect(parseHouseSubscriptionBillingExperimentMode('on')).toBe('on')
  })

  test('keeps users sticky and assigns approximately half to each arm', () => {
    const N = 20_000
    let monthly = 0
    for (let index = 0; index < N; index++) {
      const userId = `user-${index}`
      const arm = houseSubscriptionBillingArmForUser(userId)
      expect(houseSubscriptionBillingArmForUser(userId)).toBe(arm)
      if (arm === 'monthly') monthly++
    }
    const monthlyPercent = (monthly / N) * 100
    expect(monthlyPercent).toBeGreaterThan(48.5)
    expect(monthlyPercent).toBeLessThan(51.5)
  })
})

describe('imprezia experiment arm', () => {
  test('signed-out sessions stay in control', () => {
    for (const id of [null, undefined, '']) {
      expect(adExperimentArmForUser(id)).toBe('control')
    }
  })

  test('a user gets the same arm every time', () => {
    for (const id of ['abc', 'user-42', 'a-very-long-uuid-like-identifier']) {
      const first = adExperimentArmForUser(id)
      for (let i = 0; i < 20; i++) {
        expect(adExperimentArmForUser(id)).toBe(first)
      }
    }
  })

  test(`puts ~${IMPREZIA_EXPERIMENT_PERCENT}% of users in the arm`, () => {
    const N = 20_000
    let inArm = 0
    for (let i = 0; i < N; i++) {
      if (adExperimentArmForUser(`user-${i}`) === 'imprezia_first') inArm++
    }
    const percent = (inArm / N) * 100
    // FNV-1a over sequential ids is not a perfect uniform source, so allow a
    // point of slack rather than asserting an exact count.
    expect(percent).toBeGreaterThan(IMPREZIA_EXPERIMENT_PERCENT - 1.5)
    expect(percent).toBeLessThan(IMPREZIA_EXPERIMENT_PERCENT + 1.5)
  })

  test('forces only the Imprezia domain and named test account', () => {
    for (const email of ['dev@Imprezia.AI', 'jahooma@gmail.com']) {
      expect(isImpreziaAudienceEmail(email)).toBe(true)
      expect(adExperimentArmForUser('user', email)).toBe('imprezia_forced')
    }
    for (const email of [
      'dev@imprezia.ai.evil.com',
      'jahooma+test@gmail.com',
    ]) {
      expect(isImpreziaAudienceEmail(email)).toBe(false)
    }
  })
})

describe('first-party request routing', () => {
  test('normalizes decimal percentages to the same integer basis points used by campaign allocation', () => {
    expect(firstPartyPrimaryBasisPoints(1.234)).toBe(123)
    expect(firstPartyPrimaryBasisPoints(-1)).toBe(0)
    expect(firstPartyPrimaryBasisPoints(101)).toBe(10_000)
    expect(firstPartyPrimaryBasisPoints(Number.NaN)).toBe(0)
  })

  test('keeps an absent runtime configuration on the paid-network-only path', () => {
    expect(DEFAULT_FIRST_PARTY_PRIMARY_PERCENT).toBe(0)
    expect(DEFAULT_FIRST_PARTY_BACKFILL).toBe(false)
    expect(
      firstPartyAdRouteForUser('user-42', {
        primaryPercent: DEFAULT_FIRST_PARTY_PRIMARY_PERCENT,
        backfill: DEFAULT_FIRST_PARTY_BACKFILL,
      }),
    ).toBe('paid_network_only')
  })

  test('never routes a missing user id into first-party inventory', () => {
    for (const id of [null, undefined, '']) {
      expect(
        firstPartyAdRouteForUser(id, {
          primaryPercent: 100,
          backfill: true,
        }),
      ).toBe('paid_network_only')
    }
  })

  test('keeps legacy callers stable when no request sample is supplied', () => {
    for (const id of ['abc', 'user-42', 'another-user']) {
      const config = { primaryPercent: 37.5, backfill: true }
      const first = firstPartyAdRouteForUser(id, config)
      for (let i = 0; i < 20; i++) {
        expect(firstPartyAdRouteForUser(id, config)).toBe(first)
      }
    }
  })

  test('rotates the same user across independently sampled requests', () => {
    const routes = new Set(
      Array.from({ length: 10_000 }, (_, index) =>
        firstPartyAdRouteForUser(
          'same-user',
          { primaryPercent: 1, backfill: false },
          `request-${index}`,
        ),
      ),
    )
    expect(routes).toEqual(
      new Set<ReturnType<typeof firstPartyAdRouteForUser>>([
        'first_party_primary',
        'paid_network_only',
      ]),
    )
  })

  test('routes a sampled request from the same bucket used by campaign allocation', () => {
    for (let index = 0; index < 10_000; index++) {
      const sampleId = `shared-sample-${index}`
      const expected =
        firstPartyPrimaryBucket(sampleId) < 200
          ? 'first_party_primary'
          : 'paid_network_only'
      expect(
        firstPartyAdRouteForUser(
          'user',
          { primaryPercent: 2, backfill: false },
          sampleId,
        ),
      ).toBe(expected)
    }
  })

  test('makes the 0 and 100 percent settings exact', () => {
    for (let i = 0; i < 1_000; i++) {
      const id = `user-${i}`
      expect(
        firstPartyAdRouteForUser(id, {
          primaryPercent: 0,
          backfill: false,
        }),
      ).toBe('paid_network_only')
      expect(
        firstPartyAdRouteForUser(id, {
          primaryPercent: 0,
          backfill: true,
        }),
      ).toBe('gravity_then_first_party')
      expect(
        firstPartyAdRouteForUser(id, {
          primaryPercent: 100,
          backfill: false,
        }),
      ).toBe('first_party_primary')
    }
  })

  test(`allocates about ${DEFAULT_FIRST_PARTY_PRIMARY_PERCENT}% of users by default`, () => {
    const N = 20_000
    let allocated = 0
    for (let i = 0; i < N; i++) {
      if (
        firstPartyAdRouteForUser(`user-${i}`, {
          primaryPercent: DEFAULT_FIRST_PARTY_PRIMARY_PERCENT,
          backfill: true,
        }) === 'first_party_primary'
      ) {
        allocated++
      }
    }
    const percent = (allocated / N) * 100
    expect(percent).toBeGreaterThan(DEFAULT_FIRST_PARTY_PRIMARY_PERCENT - 1.5)
    expect(percent).toBeLessThan(DEFAULT_FIRST_PARTY_PRIMARY_PERCENT + 1.5)
  })

  test('expands the same request sample when the primary percentage increases', () => {
    for (let i = 0; i < 10_000; i++) {
      const id = `user-${i}`
      const atTen = firstPartyAdRouteForUser(id, {
        primaryPercent: 10,
        backfill: false,
      })
      const atTwenty = firstPartyAdRouteForUser(id, {
        primaryPercent: 20,
        backfill: false,
      })
      if (atTen === 'first_party_primary') {
        expect(atTwenty).toBe('first_party_primary')
      }
    }
  })

  test('geo routing keeps Tier 1 on the configured primary/backfill policy', () => {
    expect(
      firstPartyAdRouteForGeoRequest(
        'user',
        {
          primaryPercent: 100,
          backfill: true,
          geoRouting: true,
          tier2BonusPercent: 100,
        },
        {
          geoTier: 'tier1',
          terminalPaidFallback: false,
          impreziaFirstRefusal: false,
        },
        'sample',
      ),
    ).toBe('first_party_primary')
  })

  test('Tier 2 bonus inventory waits for terminal paid no-fill and unknown geo fails closed', () => {
    const config = {
      primaryPercent: 100,
      backfill: true,
      geoRouting: true,
      tier2BonusPercent: 100,
    }
    expect(
      firstPartyAdRouteForGeoRequest(
        'user',
        config,
        {
          geoTier: 'tier2',
          terminalPaidFallback: false,
          impreziaFirstRefusal: false,
        },
        'sample',
      ),
    ).toBe('paid_network_only')
    expect(
      firstPartyAdRouteForGeoRequest(
        'user',
        config,
        {
          geoTier: 'tier2',
          terminalPaidFallback: true,
          impreziaFirstRefusal: false,
        },
        'sample',
      ),
    ).toBe('paid_networks_then_first_party_bonus')
    expect(
      firstPartyAdRouteForGeoRequest(
        'user',
        config,
        {
          geoTier: 'unknown',
          terminalPaidFallback: true,
          impreziaFirstRefusal: false,
        },
        'sample',
      ),
    ).toBe('paid_network_only')
  })

  test('geo gate off preserves the legacy global policy', () => {
    expect(
      firstPartyAdRouteForGeoRequest(
        'user',
        {
          primaryPercent: 0,
          backfill: true,
          geoRouting: false,
          tier2BonusPercent: 100,
        },
        {
          geoTier: 'unknown',
          terminalPaidFallback: false,
          impreziaFirstRefusal: false,
        },
        'sample',
      ),
    ).toBe('gravity_then_first_party')
  })
})

describe('first-party ahead of Imprezia (COD-338)', () => {
  const config = {
    primaryPercent: 0,
    backfill: false,
    geoRouting: true,
    tier2BonusPercent: 0,
    impreziaArmPercent: 100,
  }
  const tier1 = { geoTier: 'tier1' as const, terminalPaidFallback: false }

  test('routes ahead of Imprezia only where Imprezia holds first refusal', () => {
    expect(
      firstPartyAdRouteForGeoRequest(
        'user',
        config,
        { ...tier1, impreziaFirstRefusal: true },
        'sample',
      ),
    ).toBe('first_party_before_imprezia')
    expect(
      firstPartyAdRouteForGeoRequest(
        'user',
        config,
        { ...tier1, impreziaFirstRefusal: false },
        'sample',
      ),
    ).toBe('paid_network_only')
  })

  test('never fires outside Tier 1, with geo routing off, at 0, or unset', () => {
    const refusal = { terminalPaidFallback: true, impreziaFirstRefusal: true }
    expect(
      firstPartyAdRouteForGeoRequest(
        'user',
        config,
        { geoTier: 'tier2', ...refusal },
        'sample',
      ),
    ).toBe('paid_network_only')
    expect(
      firstPartyAdRouteForGeoRequest(
        'user',
        config,
        { geoTier: 'unknown', ...refusal },
        'sample',
      ),
    ).toBe('paid_network_only')
    expect(
      firstPartyAdRouteForGeoRequest(
        'user',
        { ...config, geoRouting: false },
        { geoTier: 'tier1', ...refusal },
        'sample',
      ),
    ).toBe('paid_network_only')
    expect(
      firstPartyAdRouteForGeoRequest(
        'user',
        { ...config, impreziaArmPercent: 0 },
        { geoTier: 'tier1', ...refusal },
        'sample',
      ),
    ).toBe('paid_network_only')
    expect(
      firstPartyAdRouteForGeoRequest(
        'user',
        {
          primaryPercent: 0,
          backfill: false,
          geoRouting: true,
          tier2BonusPercent: 0,
        },
        { geoTier: 'tier1', ...refusal },
        'sample',
      ),
    ).toBe('paid_network_only')
  })

  test('the primary window wins and the arm window stacks above it', () => {
    const context = { ...tier1, impreziaFirstRefusal: true }
    let primary = 0
    let preempt = 0
    let paidOnly = 0
    for (let index = 0; index < 4_000; index++) {
      const route = firstPartyAdRouteForGeoRequest(
        'user',
        { ...config, primaryPercent: 25, impreziaArmPercent: 50 },
        context,
        `sample-${index}`,
      )
      if (route === 'first_party_primary') primary++
      else if (route === 'first_party_before_imprezia') preempt++
      else if (route === 'paid_network_only') paidOnly++
      else throw new Error(`unexpected route ${route}`)
    }
    expect(primary / 4_000).toBeGreaterThan(0.21)
    expect(primary / 4_000).toBeLessThan(0.29)
    expect(preempt / 4_000).toBeGreaterThan(0.46)
    expect(preempt / 4_000).toBeLessThan(0.54)
    expect(paidOnly / 4_000).toBeGreaterThan(0.21)
    expect(paidOnly / 4_000).toBeLessThan(0.29)
  })

  test('a stack past 100% takes every remaining request and nothing more', () => {
    const context = { ...tier1, impreziaFirstRefusal: true }
    for (let index = 0; index < 1_000; index++) {
      const route = firstPartyAdRouteForGeoRequest(
        'user',
        { ...config, primaryPercent: 60, impreziaArmPercent: 75 },
        context,
        `sample-${index}`,
      )
      expect(
        route === 'first_party_primary' ||
          route === 'first_party_before_imprezia',
      ).toBe(true)
    }
  })

  test('the primary window is identical with and without first refusal', () => {
    for (let index = 0; index < 2_000; index++) {
      const sampleId = `sample-${index}`
      const withRefusal = firstPartyAdRouteForGeoRequest(
        'user',
        { ...config, primaryPercent: 30, backfill: true },
        { ...tier1, impreziaFirstRefusal: true },
        sampleId,
      )
      const without = firstPartyAdRouteForGeoRequest(
        'user',
        { ...config, primaryPercent: 30, backfill: true },
        { ...tier1, impreziaFirstRefusal: false },
        sampleId,
      )
      expect(withRefusal === 'first_party_primary').toBe(
        without === 'first_party_primary',
      )
      if (withRefusal !== 'first_party_before_imprezia') {
        expect(withRefusal).toBe(without)
      }
    }
  })

  test('backfill stays the route when the sample misses the arm window', () => {
    let backfill = 0
    for (let index = 0; index < 2_000; index++) {
      if (
        firstPartyAdRouteForGeoRequest(
          'user',
          { ...config, backfill: true, impreziaArmPercent: 50 },
          { ...tier1, impreziaFirstRefusal: true },
          `sample-${index}`,
        ) === 'gravity_then_first_party'
      ) {
        backfill++
      }
    }
    expect(backfill / 2_000).toBeGreaterThan(0.46)
    expect(backfill / 2_000).toBeLessThan(0.54)
  })
})

describe('the house leg (COD-358)', () => {
  test('opens on Tier 1 and Tier 2, never on unknown geo, never signed out, never off', () => {
    const on = { houseLeg: true, geoRouting: true }
    expect(houseLegOpen('user', on, 'tier1')).toBe(true)
    expect(houseLegOpen('user', on, 'tier2')).toBe(true)
    expect(houseLegOpen('user', on, 'unknown')).toBe(false)
    expect(houseLegOpen(null, on, 'tier1')).toBe(false)
    expect(houseLegOpen('user', { ...on, houseLeg: false }, 'tier1')).toBe(
      false,
    )
  })

  test('with geo routing off there is no tier and the knob alone decides', () => {
    const off = { houseLeg: true, geoRouting: false }
    expect(houseLegOpen('user', off, 'unknown')).toBe(true)
    expect(houseLegOpen('user', { ...off, houseLeg: false }, 'tier1')).toBe(
      false,
    )
  })
})

/**
 * COD-369. The arm is a LOGGED field today, not a routing input -- the route
 * draw still reads a fresh per-request `randomUUID()`. These cover the key
 * itself so that COD-362 can point routing at it later without re-deriving the
 * properties it needs.
 */
describe('sticky first-party arm (logged, not routed on)', () => {
  test('one user lands in one bucket, on every surface and every request', () => {
    const first = firstPartyPrimaryBucket(firstPartyArmKey('user-a'))
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(firstPartyPrimaryBucket(firstPartyArmKey('user-a'))).toBe(first)
    }
    expect(first).toBeGreaterThanOrEqual(0)
    expect(first).toBeLessThan(10_000)
  })

  test('two users do not share a bucket by construction', () => {
    const buckets = new Set(
      Array.from({ length: 200 }, (_, index) =>
        firstPartyPrimaryBucket(firstPartyArmKey(`user-${index}`)),
      ),
    )
    // A hash into 10,000 buckets will collide a little; what would be wrong is
    // every user landing together.
    expect(buckets.size).toBeGreaterThan(150)
  })

  test('rotating the salt is the only thing that moves a bucket', () => {
    const rotated = `fpa_${fnv1a(`${FIRST_PARTY_ARM_SALT}_rotated:user-a`).toString(36)}`
    expect(firstPartyPrimaryBucket(rotated)).not.toBe(
      firstPartyPrimaryBucket(firstPartyArmKey('user-a')),
    )
  })
})
