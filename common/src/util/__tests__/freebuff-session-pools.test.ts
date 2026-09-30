/**
 * Which row is allowed to speak for a picker section's header.
 *
 * The subscription rule is the reason this file exists. A subscription-backed
 * row's `limit` is a private allowance that REPLACES the shared pool for one
 * model, so a header taken from it advertises sessions that every other row in
 * the section is unable to spend. `docs/freebuff-model-subscriptions.md`
 * described this skip as already shipped while no client implemented it.
 */
import { describe, expect, it } from 'bun:test'

import {
  getFreebuffSectionQuotas,
  getFreebuffSharedPoolQuota,
} from '../freebuff-session-pools'

import type { FreebuffSessionRateLimit } from '../../types/freebuff-session'

function quota(
  model: string,
  opts: {
    pool?: string
    limit?: number
    recentCount?: number
    resetAt?: string
    subscription?: number
  } = {},
): FreebuffSessionRateLimit {
  const row: FreebuffSessionRateLimit = {
    model,
    pool: opts.pool,
    limit: opts.limit ?? 5,
    recentCount: opts.recentCount ?? 0,
    period: 'pacific_day',
    resetTimeZone: 'America/Los_Angeles',
    resetAt: opts.resetAt ?? '2026-08-25T07:00:00.000Z',
    windowHours: 24,
  }
  if (opts.subscription !== undefined) {
    row.entitlementBreakdown = {
      base: 0,
      referral: 0,
      streak: 0,
      subscription: opts.subscription,
    }
  }
  return row
}

describe('a subscription-backed row', () => {
  it('never speaks for the section header, even serialized first', () => {
    const quotas = {
      luna: quota('luna', { pool: 'subscription:tier2', limit: 40, subscription: 40 }),
      pro: quota('pro', { pool: 'premium', limit: 4, recentCount: 1 }),
      kimi: quota('kimi', { pool: 'premium', limit: 4, recentCount: 1 }),
    }
    const { header, perModel } = getFreebuffSectionQuotas(
      ['luna', 'pro', 'kimi'],
      quotas,
    )

    expect(header?.pool).toBe('premium')
    expect(header?.limit).toBe(4)
    // Its allowance is still reachable — inline, on its own row.
    expect(perModel.luna?.limit).toBe(40)
  })

  it('still speaks for the header when it is the only kind of row left', () => {
    const quotas = {
      luna: quota('luna', { pool: 'subscription:tier2', limit: 40, subscription: 40 }),
    }
    const { header } = getFreebuffSectionQuotas(['luna'], quotas)

    // No shared pool exists for a header to describe, so showing the
    // subscriber's real number beats showing nothing.
    expect(header?.limit).toBe(40)
  })

  it('keeps its own chip when an older server sends no pool token', () => {
    const quotas = {
      luna: quota('luna', { limit: 40, subscription: 40 }),
      pro: quota('pro', { limit: 4 }),
    }
    const { header, perModel } = getFreebuffSectionQuotas(['luna', 'pro'], quotas)

    expect(header?.model).toBe('pro')
    expect(perModel.luna?.limit).toBe(40)
  })
})

describe('getFreebuffSharedPoolQuota', () => {
  const isPremium = (id: string) => id === 'luna' || id === 'pro'

  it('resolves the preferred section rather than the first key', () => {
    const quotas = {
      glm: quota('glm', { pool: 'glm', limit: 3 }),
      luna: quota('luna', { pool: 'premium', limit: 4 }),
      pro: quota('pro', { pool: 'premium', limit: 4 }),
    }

    expect(getFreebuffSharedPoolQuota(quotas, isPremium)?.pool).toBe('premium')
  })

  it('falls back to every row when the section has none', () => {
    // The limited tier gets no premium rows at all; a strict filter would
    // leave it with no counter instead of its own pool.
    const quotas = { glm: quota('glm', { pool: 'glm', limit: 3 }) }

    expect(getFreebuffSharedPoolQuota(quotas, isPremium)?.pool).toBe('glm')
  })

  it('has nothing to report without a snapshot', () => {
    expect(getFreebuffSharedPoolQuota(undefined)).toBeUndefined()
    expect(getFreebuffSharedPoolQuota({})).toBeUndefined()
  })

  it('carries the reset of the pool it picked', () => {
    const quotas = {
      glm: quota('glm', { pool: 'glm', resetAt: '2026-08-25T07:00:00.000Z' }),
      luna: quota('luna', {
        pool: 'premium',
        resetAt: '2026-08-26T07:00:00.000Z',
      }),
      pro: quota('pro', { pool: 'premium', resetAt: '2026-08-26T07:00:00.000Z' }),
    }

    // The countdown printed beside a count must come from that count's pool.
    expect(getFreebuffSharedPoolQuota(quotas, isPremium)?.resetAt).toBe(
      '2026-08-26T07:00:00.000Z',
    )
  })
})
