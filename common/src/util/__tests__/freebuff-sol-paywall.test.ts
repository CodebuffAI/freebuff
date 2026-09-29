import { describe, expect, it } from 'bun:test'

import { GPT_61_SOL_MODEL_ID } from '../../constants/freebuff-sol-promo'
import {
  FREEBUFF_PRO_ONLY_CATALOG_MODEL_IDS,
  FREEBUFF_US_OR_PAID_MODEL_IDS,
} from '../../constants/freebuff-models'
import { freebuffPlanRequired } from '../freebuff-model-selection'

/**
 * GPT-6.1 Sol's paywall as every picker draws it (Desktop, CLI, Web, mobile
 * all call `freebuffPlanRequired`): the server ships a per-viewer verdict,
 * which leaves Sol out for a US viewer and in for everyone else.
 */
describe('the GPT-6.1 Sol lock', () => {
  const nonUsVerdict = {
    planRequiredModelIds: [...FREEBUFF_PRO_ONLY_CATALOG_MODEL_IDS],
  }
  const usVerdict = {
    planRequiredModelIds: FREEBUFF_PRO_ONLY_CATALOG_MODEL_IDS.filter(
      (id) => !FREEBUFF_US_OR_PAID_MODEL_IDS.includes(id),
    ),
  }

  it('is paid-only in the catalog, with the US as its one exemption', () => {
    expect(FREEBUFF_PRO_ONLY_CATALOG_MODEL_IDS).toContain(GPT_61_SOL_MODEL_ID)
    expect(FREEBUFF_US_OR_PAID_MODEL_IDS).toEqual([GPT_61_SOL_MODEL_ID])
  })

  it('opens for a planless US viewer and locks for everyone else', () => {
    expect(freebuffPlanRequired(GPT_61_SOL_MODEL_ID, false, usVerdict)).toBe(
      false,
    )
    expect(freebuffPlanRequired(GPT_61_SOL_MODEL_ID, false, nonUsVerdict)).toBe(
      true,
    )
  })

  it('locks when the client has no verdict (fails closed) and opens on a plan', () => {
    expect(freebuffPlanRequired(GPT_61_SOL_MODEL_ID, false, null)).toBe(true)
    expect(freebuffPlanRequired(GPT_61_SOL_MODEL_ID, true, nonUsVerdict)).toBe(
      false,
    )
  })

  it('keeps Muse Spark 1.3 paid-only for the US too', () => {
    const muse = 'meta/muse-spark-1.3-contributor'
    expect(freebuffPlanRequired(muse, false, usVerdict)).toBe(true)
    expect(freebuffPlanRequired(muse, true, usVerdict)).toBe(false)
  })
})
