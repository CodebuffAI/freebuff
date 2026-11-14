import { describe, expect, it } from 'bun:test'

import {
  freebuffSubscriptionMrrUsd,
  freebuffSubscriptionRenews,
} from '../freebuff-subscriptions'

/**
 * The unit every admin MRR figure sums (`FREEBUFF_MRR_DEFINITION`). Which rows
 * count (past due held out, banned accounts dropped) is each dashboard's
 * summary; what a counted row is worth, and whether it still renews, is here.
 */
const plan = (
  over: Partial<Parameters<typeof freebuffSubscriptionMrrUsd>[0]> = {},
) => ({
  tier: 'starter',
  billingInterval: 'monthly',
  source: 'stripe',
  pendingTier: null,
  ...over,
})

describe('freebuffSubscriptionMrrUsd', () => {
  it('prices a monthly plan at its list price', () => {
    expect(freebuffSubscriptionMrrUsd(plan())).toBe(8)
    expect(freebuffSubscriptionMrrUsd(plan({ tier: 'plus' }))).toBe(25)
    expect(freebuffSubscriptionMrrUsd(plan({ tier: 'pro' }))).toBe(60)
  })

  it('counts a yearly plan as a twelfth of its annual charge', () => {
    expect(
      freebuffSubscriptionMrrUsd(plan({ billingInterval: 'yearly' })),
    ).toBe(75 / 12)
    expect(
      freebuffSubscriptionMrrUsd(
        plan({ tier: 'pro', billingInterval: 'yearly' }),
      ),
    ).toBe(560 / 12)
  })

  it('counts a prepaid year like a yearly subscription', () => {
    expect(
      freebuffSubscriptionMrrUsd(
        plan({ tier: 'plus', billingInterval: 'yearly', source: 'prepaid' }),
      ),
    ).toBe(235 / 12)
  })

  it('never counts a grant, whatever its tier or cadence', () => {
    expect(freebuffSubscriptionMrrUsd(plan({ source: 'grant' }))).toBe(0)
    expect(
      freebuffSubscriptionMrrUsd(
        plan({ tier: 'pro', billingInterval: 'yearly', source: 'grant' }),
      ),
    ).toBe(0)
  })

  it('prices a scheduled downgrade at the tier the next renewal bills', () => {
    // Stripe moves the price at the downgrade; the row keeps the higher tier's
    // allowance until the renewal.
    expect(
      freebuffSubscriptionMrrUsd(
        plan({ tier: 'plus', pendingTier: 'starter' }),
      ),
    ).toBe(8)
    expect(
      freebuffSubscriptionMrrUsd(
        plan({ tier: 'pro', billingInterval: 'yearly', pendingTier: 'plus' }),
      ),
    ).toBe(235 / 12)
    expect(
      freebuffSubscriptionMrrUsd(plan({ tier: 'plus', pendingTier: 'plus' })),
    ).toBe(25)
  })

  it('falls back to the current tier when the pending one is unknown', () => {
    expect(
      freebuffSubscriptionMrrUsd(plan({ tier: 'plus', pendingTier: 'legacy' })),
    ).toBe(25)
  })

  it('prices a tier the catalog no longer carries at 0, not a guess', () => {
    expect(freebuffSubscriptionMrrUsd(plan({ tier: 'legacy' }))).toBe(0)
  })

  it('prices an unknown billing interval as monthly', () => {
    expect(
      freebuffSubscriptionMrrUsd(plan({ billingInterval: 'quarterly' })),
    ).toBe(8)
  })

  it('prices a past-due renewal like any other; holding it out is the summary', () => {
    // The price is status-blind, so the past-due tile can show what the
    // paused plans would add back once paid.
    expect(freebuffSubscriptionMrrUsd(plan({ tier: 'plus' }))).toBe(25)
  })
})

describe('freebuffSubscriptionRenews', () => {
  it('drops a Stripe plan set to cancel at period end', () => {
    expect(
      freebuffSubscriptionRenews({ source: 'stripe', cancelAtPeriodEnd: true }),
    ).toBe(false)
    expect(
      freebuffSubscriptionRenews({
        source: 'stripe',
        cancelAtPeriodEnd: false,
      }),
    ).toBe(true)
  })

  it('keeps a prepaid year, which always carries the flag', () => {
    expect(
      freebuffSubscriptionRenews({
        source: 'prepaid',
        cancelAtPeriodEnd: true,
      }),
    ).toBe(true)
  })
})
