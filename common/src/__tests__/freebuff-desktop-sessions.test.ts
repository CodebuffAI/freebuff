import { describe, expect, test } from 'bun:test'

import { freebuffLegacyModelDigest } from '../types/freebuff-model-catalog'
import {
  FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID,
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_GEMINI_38_FLASH_MODEL_ID,
  FREEBUFF_GLM_V53_FLASH_MODEL_ID,
  FREEBUFF_GPT_6_LUNA_MODEL_ID,
  FREEBUFF_MIMO_V26_PRO_MODEL_ID,
  FREEBUFF_MODELS,
  FREEBUFF_MUSE_SPARK_MODEL_IDS,
  FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID,
  FREEBUFF_SOLAR_PRO_4_MODEL_ID,
  FREEBUFF_WEB_PREMIUM_MODEL_IDS,
} from '../constants/freebuff-models'
import {
  FREEBUFF_CLAUDE_HAIKU_55_CATALOG_KEY,
  FREEBUFF_CLAUDE_HAIKU_55_MODEL_ID,
  FREEBUFF_DESKTOP_UNCAPPED_TAB_LIMIT,
  freebuffDesktopConcurrencyLimits,
  freebuffDesktopModelTabLimit,
  getFreebuffDesktopConcurrency,
} from '../constants/freebuff-desktop-sessions'

describe('Freebuff Desktop session concurrency', () => {
  test('projects account ceilings', () => {
    expect(freebuffDesktopConcurrencyLimits('full', false)).toEqual({
      'slot-bound': 1,
      'multi-tab': 3,
    })
    expect(freebuffDesktopConcurrencyLimits('limited', false)).toEqual({
      'slot-bound': 1,
      'multi-tab': 0,
    })
    expect(freebuffDesktopConcurrencyLimits('limited', true)).toEqual({
      'slot-bound': 3,
      'multi-tab': 8,
    })
  })

  test('free full access in country tiers 1 and 2 gets five ordinary tabs', () => {
    for (const countryTier of ['tier1', 'tier2']) {
      expect(
        freebuffDesktopConcurrencyLimits('full', false, false, countryTier),
      ).toEqual({ 'slot-bound': 1, 'multi-tab': 5 })
      // A plan's ceilings and the limited tier's are unchanged.
      expect(
        freebuffDesktopConcurrencyLimits('full', true, false, countryTier),
      ).toEqual({ 'slot-bound': 3, 'multi-tab': 8 })
      expect(
        freebuffDesktopConcurrencyLimits('limited', false, false, countryTier),
      ).toEqual({ 'slot-bound': 1, 'multi-tab': 0 })
    }
    for (const countryTier of ['tier3', 'tier4', null, undefined]) {
      expect(
        freebuffDesktopConcurrencyLimits('full', false, false, countryTier),
      ).toEqual({ 'slot-bound': 1, 'multi-tab': 3 })
    }
  })

  test('an uncapped account gets the runaway guard in every bucket and tier', () => {
    for (const tier of ['full', 'limited'] as const) {
      for (const paid of [false, true]) {
        expect(freebuffDesktopConcurrencyLimits(tier, paid, true)).toEqual({
          'slot-bound': FREEBUFF_DESKTOP_UNCAPPED_TAB_LIMIT,
          'multi-tab': FREEBUFF_DESKTOP_UNCAPPED_TAB_LIMIT,
        })
      }
    }
    expect(freebuffDesktopModelTabLimit(0)).toBe(1)
    expect(freebuffDesktopModelTabLimit(0, true)).toBe(Infinity)
  })

  test('classifies models by tier and plan', () => {
    const cases = [
      [FREEBUFF_GEMINI_38_FLASH_MODEL_ID, 'full', false, 'slot-bound'],
      [`${FREEBUFF_GEMINI_38_FLASH_MODEL_ID}-20260922`, 'full', true, 'slot-bound'],
      // Claude Haiku 5.5 with full context is slot-bound since 2026-10-14,
      // under both of its names; its 100k-context row is not.
      [FREEBUFF_CLAUDE_HAIKU_55_MODEL_ID, 'full', false, 'slot-bound'],
      [FREEBUFF_CLAUDE_HAIKU_55_MODEL_ID, 'full', true, 'slot-bound'],
      [FREEBUFF_CLAUDE_HAIKU_55_CATALOG_KEY, 'full', true, 'slot-bound'],
      [`${FREEBUFF_CLAUDE_HAIKU_55_MODEL_ID}-100k`, 'full', true, 'multi-tab'],
      // GPT-6 Luna, MiMo 2.6 Pro and DeepSeek Flash fast mode are multi-tab
      // since 2026-10-14.
      [`${FREEBUFF_GPT_6_LUNA_MODEL_ID}-20260922`, 'full', false, 'multi-tab'],
      [FREEBUFF_MIMO_V26_PRO_MODEL_ID, 'full', true, 'multi-tab'],
      [FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID, 'full', false, 'multi-tab'],
      [FREEBUFF_GPT_6_LUNA_MODEL_ID, 'limited', false, 'slot-bound'],
      [FREEBUFF_GLM_V53_FLASH_MODEL_ID, 'full', false, 'multi-tab'],
      [FREEBUFF_SOLAR_PRO_4_MODEL_ID, 'full', false, 'multi-tab'],
      [FREEBUFF_SOLAR_PRO_4_MODEL_ID, 'limited', false, 'slot-bound'],
      [FREEBUFF_SOLAR_PRO_4_MODEL_ID, 'limited', true, 'multi-tab'],
      [FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID, 'limited', false, 'slot-bound'],
      // Muse Spark is multi-tab since 2026-10-10, when Meta lifted the
      // Contributor rate limit that held it to one tab.
      [FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID, 'full', false, 'multi-tab'],
      [FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID, 'full', true, 'multi-tab'],
      [FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID, 'limited', true, 'multi-tab'],
    ] as const
    for (const [model, tier, paidPlan, expected] of cases) {
      expect(getFreebuffDesktopConcurrency(model, tier, paidPlan)).toBe(
        expected,
      )
    }

    // Premium rows are slot-bound unless named multi-tab here, so a new
    // premium row takes one tab until someone decides otherwise.
    const multiTabPremium = new Set<string>([
      FREEBUFF_GPT_6_LUNA_MODEL_ID,
      FREEBUFF_MIMO_V26_PRO_MODEL_ID,
      FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID,
    ])
    const desktopModels = new Set<string>(FREEBUFF_MODELS.map(({ id }) => id))
    for (const id of FREEBUFF_WEB_PREMIUM_MODEL_IDS) {
      if (desktopModels.has(id)) {
        expect(getFreebuffDesktopConcurrency(id, 'full')).toBe(
          multiTabPremium.has(id) ? 'multi-tab' : 'slot-bound',
        )
      }
    }
    for (const id of FREEBUFF_MUSE_SPARK_MODEL_IDS) {
      expect(getFreebuffDesktopConcurrency(id, 'full')).toBe('multi-tab')
    }
  })

  test("Haiku 5.5's catalog key is the default catalog's key for its id", () => {
    // packages/internal's defaultCatalogKey, which common cannot import.
    expect(FREEBUFF_CLAUDE_HAIKU_55_CATALOG_KEY).toBe(
      `m-${freebuffLegacyModelDigest(`key:${FREEBUFF_CLAUDE_HAIKU_55_MODEL_ID}`).slice(0, 10)}`,
    )
  })
})
