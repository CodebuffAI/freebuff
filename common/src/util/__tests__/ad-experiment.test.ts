import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_FIRST_PARTY_BACKFILL,
  firstPartyAdRouteForUser,
  firstPartyAdRouteForGeoRequest,
  firstPartyPrimaryBucket,
  firstPartyPrimaryBasisPoints,
  houseLegOpen,
  houseSubscriptionBillingArmForUser,
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

describe('first-party request routing', () => {
  test('normalizes decimal percentages to whole basis points', () => {
    expect(firstPartyPrimaryBasisPoints(0)).toBe(0)
    expect(firstPartyPrimaryBasisPoints(2.5)).toBe(250)
    expect(firstPartyPrimaryBasisPoints(100)).toBe(10_000)
    expect(firstPartyPrimaryBasisPoints(Number.NaN)).toBe(0)
    expect(firstPartyPrimaryBasisPoints(-5)).toBe(0)
    expect(firstPartyPrimaryBasisPoints(500)).toBe(10_000)
  })

  test('keeps an absent runtime configuration on the paid-network-only path', () => {
    expect(DEFAULT_FIRST_PARTY_BACKFILL).toBe(false)
    expect(
      firstPartyAdRouteForUser('user-42', {
        backfill: DEFAULT_FIRST_PARTY_BACKFILL,
      }),
    ).toBe('paid_network_only')
  })

  test('never routes a missing user id into first-party inventory', () => {
    for (const id of [null, undefined, '']) {
      expect(firstPartyAdRouteForUser(id, { backfill: true })).toBe(
        'paid_network_only',
      )
    }
  })

  test('our book only ever follows Gravity', () => {
    for (let i = 0; i < 1_000; i++) {
      const id = `user-${i}`
      expect(firstPartyAdRouteForUser(id, { backfill: false })).toBe(
        'paid_network_only',
      )
      expect(firstPartyAdRouteForUser(id, { backfill: true })).toBe(
        'gravity_then_first_party',
      )
    }
  })

  test('geo routing keeps Tier 1 on the configured backfill policy', () => {
    expect(
      firstPartyAdRouteForGeoRequest(
        'user',
        {
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
    ).toBe('gravity_then_first_party')
  })

  test('Tier 2 bonus inventory waits for terminal paid no-fill and unknown geo fails closed', () => {
    const config = {
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

  test('the Tier 2 bonus share samples requests in the shared bucket space', () => {
    const config = { backfill: true, geoRouting: true, tier2BonusPercent: 2 }
    for (let index = 0; index < 10_000; index++) {
      const sampleId = `shared-sample-${index}`
      expect(
        firstPartyAdRouteForGeoRequest(
          'user',
          config,
          { geoTier: 'tier2', terminalPaidFallback: true },
          sampleId,
        ),
      ).toBe(
        firstPartyPrimaryBucket(sampleId) < 200
          ? 'paid_networks_then_first_party_bonus'
          : 'paid_network_only',
      )
    }
  })

  test('geo gate off preserves the legacy global policy', () => {
    expect(
      firstPartyAdRouteForGeoRequest(
        'user',
        {
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
