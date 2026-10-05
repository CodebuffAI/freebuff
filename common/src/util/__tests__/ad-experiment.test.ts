import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_FIRST_PARTY_BACKFILL,
  DEFAULT_FIRST_PARTY_PRIMARY_PERCENT,
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
  test('keeps ordinary, signed-out, and former preview users in control', () => {
    for (const id of [null, undefined, '', 'user-42']) {
      expect(adExperimentArmForUser(id)).toBe('control')
    }
    for (const email of ['dev@Imprezia.AI', 'jahooma@gmail.com']) {
      expect(adExperimentArmForUser('user', email)).toBe('control')
    }
  })

  test('removes the personal account from the legacy preview audience', () => {
    expect(isImpreziaAudienceEmail('dev@Imprezia.AI')).toBe(true)
    for (const email of [
      'jahooma@gmail.com',
      ' JAHOOMA@gmail.com ',
      'dev@imprezia.ai.evil.com',
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
        },
        'sample',
      ),
    ).toBe('gravity_then_first_party')
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
