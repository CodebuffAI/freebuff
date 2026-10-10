import { describe, expect, test } from 'bun:test'

import {
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_GEMINI_38_FLASH_MODEL_ID,
  FREEBUFF_GLM_V53_FLASH_MODEL_ID,
  FREEBUFF_GPT_6_LUNA_MODEL_ID,
  FREEBUFF_MODELS,
  FREEBUFF_MUSE_SPARK_MODEL_IDS,
  FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID,
  FREEBUFF_SOLAR_PRO_4_MODEL_ID,
  FREEBUFF_WEB_PREMIUM_MODEL_IDS,
} from '../constants/freebuff-models'
import {
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
      [
        // GPT-6 Luna since 2026-09-22, when it took 5.6's slot-bound entry.
        `${FREEBUFF_GPT_6_LUNA_MODEL_ID}-20260922`,
        'full',
        false,
        'slot-bound',
      ],
      [FREEBUFF_GEMINI_38_FLASH_MODEL_ID, 'full', false, 'slot-bound'],
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

    const desktopModels = new Set<string>(FREEBUFF_MODELS.map(({ id }) => id))
    for (const id of FREEBUFF_WEB_PREMIUM_MODEL_IDS) {
      if (desktopModels.has(id)) {
        expect(getFreebuffDesktopConcurrency(id, 'full')).toBe('slot-bound')
      }
    }
    for (const id of FREEBUFF_MUSE_SPARK_MODEL_IDS) {
      expect(getFreebuffDesktopConcurrency(id, 'full')).toBe('multi-tab')
    }
  })
})
