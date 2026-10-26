import { describe, expect, test } from 'bun:test'

import {
  FREEBUFF_GPT_61_TERRA_MODEL_ID,
  FREEBUFF_LIMITED_TIER_PLAN_ONLY_MODEL_IDS,
  FREEBUFF_MODELS,
  FREEBUFF_PLAN_METERED_CATALOG_MODEL_IDS,
  FREEBUFF_PRO_ONLY_CATALOG_MODEL_IDS,
  FREEBUFF_PRO_ONLY_EVERY_SURFACE_MODEL_IDS,
  FREEBUFF_US_OR_PAID_MODEL_IDS,
  isFreebuffSessionModelAllowedForAccessTier,
} from '../freebuff-models'
import {
  freebuffDailySessionLimit,
  GPT_61_TERRA_MODEL_ID,
  GPT_61_TERRA_PROMOTIONAL,
} from '../freebuff-sol-promo'

/**
 * GPT-6.1 Terra's launch terms (product, 2026-10-26): a promotional 100
 * Freebucks, one session a day for every account, open on every full-access
 * account and a paid plan at limited access — MiMo 2.6 Pro's terms, not Sol's
 * US-or-paid.
 */
describe('GPT-6.1 Terra launch terms', () => {
  test('the leaf module and the catalog name the same id', () => {
    expect(GPT_61_TERRA_MODEL_ID).toBe(FREEBUFF_GPT_61_TERRA_MODEL_ID)
  })

  // The 100 Freebucks price is pinned in freebuff-freebucks.test.ts ("prices
  // every row"): that module is excluded from the public export, which this
  // published test may not import.
  test('is offered on every surface, labelled promotional', () => {
    const row = FREEBUFF_MODELS.find((m) => m.id === FREEBUFF_GPT_61_TERRA_MODEL_ID)
    expect(row).toBeDefined()
    expect((row as { promotional?: unknown }).promotional).toEqual(
      GPT_61_TERRA_PROMOTIONAL,
    )
  })

  test('is one session a day for every account', () => {
    expect(freebuffDailySessionLimit(FREEBUFF_GPT_61_TERRA_MODEL_ID)).toBe(1)
  })

  test('opens at full access without a plan, and needs one at limited access', () => {
    expect(
      isFreebuffSessionModelAllowedForAccessTier(FREEBUFF_GPT_61_TERRA_MODEL_ID, 'full', false),
    ).toBe(true)
    expect(
      isFreebuffSessionModelAllowedForAccessTier(FREEBUFF_GPT_61_TERRA_MODEL_ID, 'limited', false),
    ).toBe(false)
    expect(
      isFreebuffSessionModelAllowedForAccessTier(FREEBUFF_GPT_61_TERRA_MODEL_ID, 'limited', true),
    ).toBe(true)
    expect(FREEBUFF_LIMITED_TIER_PLAN_ONLY_MODEL_IDS).toContain(FREEBUFF_GPT_61_TERRA_MODEL_ID)
    expect(FREEBUFF_PLAN_METERED_CATALOG_MODEL_IDS).toContain(FREEBUFF_GPT_61_TERRA_MODEL_ID)
  })

  test('is not paywalled at full access, and not tied to the US', () => {
    expect(FREEBUFF_PRO_ONLY_CATALOG_MODEL_IDS).not.toContain(FREEBUFF_GPT_61_TERRA_MODEL_ID)
    expect(FREEBUFF_PRO_ONLY_EVERY_SURFACE_MODEL_IDS).not.toContain(
      FREEBUFF_GPT_61_TERRA_MODEL_ID,
    )
    expect(FREEBUFF_US_OR_PAID_MODEL_IDS).not.toContain(FREEBUFF_GPT_61_TERRA_MODEL_ID)
  })
})
