/**
 * GPT-5.6 Luna-ES ("Codex (test)" — the Novita route) is god-only on Freebuff
 * Web, the same shape as Kimi K3 in kimi-k3-god-only.test.ts.
 *
 * A model in FREEBUFF_WEB_GOD_ONLY_MODELS must also carry its id in
 * FREEBUFF_WEB_GOD_ONLY_MODEL_IDS and FREEBUFF_WEB_PREMIUM_MODEL_IDS — the
 * first derived from the array above (so it cannot drift), the second
 * hand-maintained and the one this test actually pins. Both are load-bearing:
 * the first is the actual god-only gate, the second is what keeps a premium
 * model metered by SOME pool rather than none. This file pins the invariant
 * the same way kimi-k3-god-only.test.ts pins Kimi's — by construction for the
 * first list, by this test for the second.
 */
import { describe, expect, it } from 'bun:test'

import {
  FREEBUFF_GPT_5_6_LUNA_ES_MODEL_ID,
  FREEBUFF_MODELS,
  FREEBUFF_WEB_ALL_MODELS,
  FREEBUFF_WEB_GOD_ONLY_MODELS,
  FREEBUFF_WEB_MODELS,
  FREEBUFF_WEB_PREMIUM_MODEL_IDS,
  FREEBUFF_STANDARD_MODEL_IDS,
  isFreebuffWebGodOnlyModelId,
  isFreebuffWebModelId,
  SUPPORTED_FREEBUFF_MODELS,
} from '../constants/freebuff-models'

const LUNA_ES_ID = FREEBUFF_GPT_5_6_LUNA_ES_MODEL_ID

describe('Luna-ES (Codex test route) is god-only on Freebuff Web', () => {
  it('is offered to god users and nobody else', () => {
    expect(isFreebuffWebGodOnlyModelId(LUNA_ES_ID)).toBe(true)
    expect(isFreebuffWebModelId(LUNA_ES_ID, { includeGodOnly: true })).toBe(
      true,
    )
    expect(isFreebuffWebModelId(LUNA_ES_ID, { includeGodOnly: false })).toBe(
      false,
    )
    expect(FREEBUFF_WEB_GOD_ONLY_MODELS.map((m) => m.id)).toContain(
      LUNA_ES_ID,
    )
    // The god-only list is additive to the visible one, so it must NOT also
    // appear there or every user would see it.
    expect(FREEBUFF_WEB_MODELS.map((m) => m.id)).not.toContain(LUNA_ES_ID)
  })

  it('stays off every non-web surface', () => {
    expect(FREEBUFF_MODELS.map((m) => m.id)).not.toContain(LUNA_ES_ID)
    expect(SUPPORTED_FREEBUFF_MODELS.map((m) => m.id)).not.toContain(
      LUNA_ES_ID,
    )
    expect(FREEBUFF_WEB_ALL_MODELS.map((m) => m.id)).toContain(LUNA_ES_ID)
  })

  it('is metered by the premium pool, never the standard one', () => {
    // FREEBUFF_STANDARD_MODEL_IDS is derived by filtering `!premium` over the
    // catalog. GPT_5_6_LUNA_ES_MODEL declares `premium: true` for exactly this
    // reason, which correctly keeps it out of the standard/unmetered set — but
    // that alone left it metered by NOTHING until it was also added here.
    expect(FREEBUFF_WEB_PREMIUM_MODEL_IDS).toContain(LUNA_ES_ID)
    expect(FREEBUFF_STANDARD_MODEL_IDS).not.toContain(LUNA_ES_ID)
    const model = FREEBUFF_WEB_GOD_ONLY_MODELS.find((m) => m.id === LUNA_ES_ID)
    expect(model?.premium).toBe(true)
  })

  it('answers as Codex, so the label never says Luna', () => {
    const model = FREEBUFF_WEB_GOD_ONLY_MODELS.find((m) => m.id === LUNA_ES_ID)
    expect(model?.displayName).toBe('Codex (test)')
    expect(model?.displayName).not.toContain('Luna')
  })

  it('keeps its id distinct from every other catalog row', () => {
    const all = FREEBUFF_WEB_ALL_MODELS.map((m) => m.id)
    expect(new Set(all).size).toBe(all.length)
  })
})
