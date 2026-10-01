import { describe, expect, it } from 'bun:test'

import {
  FREEBUFF_GEMINI_38_FLASH_MODEL_ID,
  FREEBUFF_GPT_6_LUNA_MODEL_ID,
  FREEBUFF_LIMITED_TIER_PLAN_ONLY_MODEL_IDS,
  FREEBUFF_MIMO_V26_PRO_MODEL_ID,
  getFreebuffModelsForAccessTier,
  LIMITED_FREEBUFF_MODEL_IDS,
} from '../../constants/freebuff-models'
import { freebuffPlanRequired } from '../freebuff-model-selection'

/**
 * The tier fallback of `freebuffPlanRequired`: what a picker draws locked when
 * the server sent no `planRequiredModelIds` (no Freebucks block, a balance
 * that is unavailable, an older server). Since 2026-09-30 the limited catalog
 * LISTS the rows a plan unlocks there to every limited account, so without
 * this the fallback (the full-access paid-only list) drew GPT-6 Luna and MiMo
 * 2.6 Pro as ordinary rows that admission then refuses.
 */
describe('the plan lock without a server verdict', () => {
  it('locks every limited plan-only row at limited access', () => {
    for (const id of FREEBUFF_LIMITED_TIER_PLAN_ONLY_MODEL_IDS) {
      expect(freebuffPlanRequired(id, false, undefined, 'limited')).toBe(true)
      expect(freebuffPlanRequired(id, false, null, 'limited')).toBe(true)
    }
  })

  it('agrees with the rows the limited catalog appends to the free ones', () => {
    const listed = getFreebuffModelsForAccessTier('limited').map((m) => m.id)
    const locked = listed.filter((id) =>
      freebuffPlanRequired(id, false, undefined, 'limited'),
    )
    expect(locked).toEqual(
      listed.filter(
        (id) => !(LIMITED_FREEBUFF_MODEL_IDS as readonly string[]).includes(id),
      ),
    )
  })

  it('leaves Luna and MiMo 2.6 Pro open at full access, Gemini locked', () => {
    for (const id of [FREEBUFF_GPT_6_LUNA_MODEL_ID, FREEBUFF_MIMO_V26_PRO_MODEL_ID]) {
      expect(freebuffPlanRequired(id, false, undefined, 'full')).toBe(false)
      expect(freebuffPlanRequired(id, false, undefined)).toBe(false)
    }
    expect(
      freebuffPlanRequired(FREEBUFF_GEMINI_38_FLASH_MODEL_ID, false, undefined, 'full'),
    ).toBe(true)
  })

  it('opens every row on a plan, and the server verdict still wins', () => {
    expect(
      freebuffPlanRequired(FREEBUFF_GPT_6_LUNA_MODEL_ID, true, undefined, 'limited'),
    ).toBe(false)
    expect(
      freebuffPlanRequired(
        FREEBUFF_GPT_6_LUNA_MODEL_ID,
        false,
        { planRequiredModelIds: [] },
        'limited',
      ),
    ).toBe(false)
  })
})
