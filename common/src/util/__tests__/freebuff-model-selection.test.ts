import { describe, expect, it } from 'bun:test'

import {
  FREEBUFF_GEMINI_38_FLASH_MODEL_ID,
  FREEBUFF_GPT_6_LUNA_MODEL_ID,
  FREEBUFF_LIMITED_TIER_PLAN_ONLY_MODEL_IDS,
  FREEBUFF_MIMO_V26_PRO_MODEL_ID,
  getFreebuffModelsForAccessTier,
  LIMITED_FREEBUFF_MODEL_IDS,
} from '../../constants/freebuff-models'
import type { FreebuffFreebucksInfo } from '../../types/freebuff-session'
import {
  freebuffPlanRequired,
  freebuffSessionUntimed,
  freebucksRowIntent,
} from '../freebuff-model-selection'

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

  it('leaves MiMo 2.6 Pro open at full access; Gemini and GPT-6 Luna locked', () => {
    expect(freebuffPlanRequired(FREEBUFF_MIMO_V26_PRO_MODEL_ID, false, undefined, 'full')).toBe(false)
    expect(freebuffPlanRequired(FREEBUFF_MIMO_V26_PRO_MODEL_ID, false, undefined)).toBe(false)
    // GPT-6 Luna takes a plan at both tiers since 2026-11-06.
    for (const id of [FREEBUFF_GEMINI_38_FLASH_MODEL_ID, FREEBUFF_GPT_6_LUNA_MODEL_ID])
      expect(freebuffPlanRequired(id, false, undefined, 'full')).toBe(true)
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

/** Full access (2026-10-16): never asked before an hour, and a row locks on
 *  its price less `soloDiscount`, which the server sends while nothing is live. */
describe('the full-access session policy', () => {
  const freebucks = (over: Partial<FreebuffFreebucksInfo> = {}) =>
    ({
      balance: 10,
      daily: { limit: 150, spent: 150, remaining: 0, resetAt: '' },
      wallet: { balance: 10, monthlyBonus: 0 },
      planId: null,
      prices: { flash: 15, pro: 30 },
      ...over,
    }) as FreebuffFreebucksInfo
  const intent = (info: FreebuffFreebucksInfo, model: string, active?: string) =>
    freebucksRowIntent(info, model, active).kind

  it('asks nothing, not even before ending the live session', () => {
    const info = freebucks({ balance: 30, wallet: { balance: 30, monthlyBonus: 0 } })
    expect(intent({ ...info, spendWithoutAsking: true }, 'pro', 'flash')).toBe('allow')
    expect(intent(info, 'pro', 'flash')).toBe('confirm')
  })

  it('locks on the price less the solo discount, and on list price without it', () => {
    const never = { spendWithoutAsking: true }
    expect(intent(freebucks({ ...never, soloDiscount: 15 }), 'flash')).toBe('allow')
    expect(intent(freebucks(never), 'flash')).toBe('paywall')
    // 30 less 15 is still more than 10.
    expect(intent(freebucks({ ...never, soloDiscount: 15 }), 'pro')).toBe('paywall')
  })

  it('hides the clock only on the rows the server names', () => {
    const info = freebucks({ spendWithoutAsking: true, untimedModelIds: ['flash'] })
    expect(freebuffSessionUntimed('flash', info)).toBe(true)
    expect(freebuffSessionUntimed('pro', info)).toBe(false)
    expect(freebuffSessionUntimed(undefined, info)).toBe(false)
    // No verdict (an older server, another tier, an unreadable balance) keeps it.
    expect(freebuffSessionUntimed('flash', freebucks())).toBe(false)
    expect(freebuffSessionUntimed('flash', null)).toBe(false)
    expect(freebuffSessionUntimed('flash', undefined)).toBe(false)
  })
})
