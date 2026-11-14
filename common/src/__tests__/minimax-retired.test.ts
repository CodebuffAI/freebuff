/**
 * MiniMax M3 was withdrawn from free mode on 2026-08-20 (on cost) and answered
 * with the retired-model 410 from 2026-10-01; on 2026-10-24 product retired
 * MiniMax from Freebuff altogether, together with the catalog-only MiniMax
 * M3.1 Flash row (whose half is pinned in
 * web/src/server/model-catalog/__tests__/model-catalog.test.ts).
 *
 * Like ox-alpha.test.ts, these tests pin a RETIREMENT and the two halves of it
 * that a later reader would otherwise "tidy" in opposite directions:
 *
 *   - it is out of every picker and every quota or offer list, on every
 *     surface and at every tier;
 *   - it is still a RECOGNISED id, with its roots still allowlisted to it.
 *
 * The second half is what tells a released CLI or Desktop binary (which holds
 * the pick in its compiled-in catalog and its roots in its bundled agents) to
 * update, instead of refusing an unknown id it will retry forever (#1801).
 */
import { describe, expect, it } from 'bun:test'

import {
  DEFAULT_FREEBUFF_MODEL_ID,
  FALLBACK_FREEBUFF_MODEL_ID,
  FREEBUFF_MINIMAX_M3_MODEL_ID,
  FREEBUFF_MODELS,
  FREEBUFF_PAUSED_FREE_MODEL_IDS,
  FREEBUFF_RETIRED_MODEL_IDS,
  FREEBUFF_STANDARD_MODEL_IDS,
  FREEBUFF_TRACED_MODEL_IDS,
  FREEBUFF_WEB_ALL_MODELS,
  FREEBUFF_WEB_GEO_EXEMPT_MODEL_IDS,
  FREEBUFF_WEB_LIMITED_MODEL_IDS,
  FREEBUFF_WEB_MODELS,
  FREEBUFF_WEB_PREMIUM_MODEL_IDS,
  freebuffRetiredModelAvailabilityLabel,
  freebuffRetiredModelMessage,
  getFreebuffModelsForAccessTier,
  isFreebuffModelId,
  isFreebuffPausedFreeModelId,
  isFreebuffRetiredModelId,
  isFreebuffSessionModelAllowedForAccessTier,
  isFreebuffSessionModelId,
  isFreebuffWebModelAllowedForLimitedTier,
  isFreebuffWebModelId,
  isSupportedFreebuffModelId,
  LIMITED_FREEBUFF_MODEL_IDS,
  SUPPORTED_FREEBUFF_MODELS,
} from '../constants/freebuff-models'
import {
  FREE_MODE_AGENT_MODELS,
  FREEBUFF_CLI_BASE3_AGENT_ID_BY_MODEL,
  FREEBUFF_ROOT_AGENT_ID_BY_MODEL,
  FREEBUFF_ROOT_AGENT_IDS,
  FREEBUFF_WEB_BASE3_AGENT_ID_BY_MODEL,
} from '../constants/free-agents'
import { freebuffPickerPlacement } from '../util/freebuff-picker-sections'

const M3 = FREEBUFF_MINIMAX_M3_MODEL_ID
const DATED = `${M3}-20260211`
const isMiniMaxName = (name: string) => /minimax/i.test(name)

describe('MiniMax is offered on no Freebuff surface', () => {
  it('is in no picker list: CLI, Desktop, Web/Cloud, either tier', () => {
    for (const models of [
      FREEBUFF_MODELS,
      FREEBUFF_WEB_MODELS,
      FREEBUFF_WEB_ALL_MODELS,
      getFreebuffModelsForAccessTier('full'),
      getFreebuffModelsForAccessTier('limited'),
    ]) {
      expect(models.map((m) => m.id)).not.toContain(M3)
      // By name as well: no other row may carry MiniMax into a picker.
      expect(models.filter((m) => isMiniMaxName(m.displayName))).toEqual([])
    }
    expect(isFreebuffModelId(M3)).toBe(false)
    expect(isFreebuffWebModelId(M3)).toBe(false)
    expect(isFreebuffWebModelId(M3, { includeGodOnly: true })).toBe(false)
  })

  it('is in no quota, price or limited-tier list', () => {
    expect(FREEBUFF_WEB_PREMIUM_MODEL_IDS as readonly string[]).not.toContain(M3)
    expect(FREEBUFF_STANDARD_MODEL_IDS as readonly string[]).not.toContain(M3)
    expect(LIMITED_FREEBUFF_MODEL_IDS as readonly string[]).not.toContain(M3)
    expect(FREEBUFF_WEB_GEO_EXEMPT_MODEL_IDS as readonly string[]).not.toContain(M3)
    expect(FREEBUFF_WEB_LIMITED_MODEL_IDS as readonly string[]).not.toContain(M3)
    expect(isFreebuffWebModelAllowedForLimitedTier(M3)).toBe(false)
    // Unpriced (no Freebucks entry) is pinned in freebuff-freebucks.test.ts:
    // that module is excluded from the public export, so this file may not
    // import it.
    expect(FREEBUFF_TRACED_MODEL_IDS as readonly string[]).not.toContain(M3)
  })

  it('is refused at session admission on both tiers, dated builds included', () => {
    for (const id of [M3, DATED]) {
      expect(isFreebuffSessionModelAllowedForAccessTier(id, 'full')).toBe(false)
      expect(isFreebuffSessionModelAllowedForAccessTier(id, 'limited')).toBe(
        false,
      )
    }
  })

  it('has no compiled picker placement', () => {
    const fallback = { premium: true, locked: false, price: undefined }
    expect(freebuffPickerPlacement([M3], fallback)).toMatchObject({
      order: Number.POSITIVE_INFINITY,
      more: true,
    })
  })

  it('is not the default or the fallback anything steps down to', () => {
    expect(DEFAULT_FREEBUFF_MODEL_ID).not.toBe(M3)
    expect(FALLBACK_FREEBUFF_MODEL_ID).not.toBe(M3)
  })
})

describe('MiniMax M3 is RETIRED, not deleted', () => {
  it('is paused and retired, so both admission and completions answer it', () => {
    expect(FREEBUFF_PAUSED_FREE_MODEL_IDS).toContain(M3)
    expect(FREEBUFF_RETIRED_MODEL_IDS).toContain(M3)
    for (const id of [M3, DATED]) {
      expect(isFreebuffPausedFreeModelId(id)).toBe(true)
      expect(isFreebuffRetiredModelId(id)).toBe(true)
    }
  })

  /**
   * The load-bearing half. Dropping the row from SUPPORTED looks like
   * finishing the scrub and is the outage: admission can only refuse an id it
   * does not recognise, and the completions route cannot name it.
   */
  it('stays a recognised id, and the answer tells the client to update', () => {
    expect(SUPPORTED_FREEBUFF_MODELS.some((m) => m.id === M3)).toBe(true)
    expect(isSupportedFreebuffModelId(M3)).toBe(true)
    expect(isFreebuffSessionModelId(M3)).toBe(true)
    // Completions: 410 freebuff_model_retired with this message.
    const message = freebuffRetiredModelMessage(M3)
    expect(message).toContain('MiniMax M3 is no longer available')
    expect(message).toContain('npm install -g freebuff@latest')
    expect(message).toContain('Freebuff Desktop')
    // Admission: 409 model_unavailable, withdrawn, with this label.
    expect(freebuffRetiredModelAvailabilityLabel()).toContain('update Freebuff')
  })

  it('keeps its roots allowlisted to M3 alone, which is how the 410 knows them', () => {
    // web/src/llm-api/retired-model-agents.ts derives the retired roots from
    // FREE_MODE_AGENT_MODELS: an agent pinned to retired models only. Drop
    // these entries and a released binary sending `base2-free-minimax-m3`
    // gets a generic refusal instead of "update Freebuff".
    expect(FREEBUFF_ROOT_AGENT_ID_BY_MODEL[M3]).toBe('base2-free-minimax-m3')
    expect(FREEBUFF_WEB_BASE3_AGENT_ID_BY_MODEL[M3]).toBe('base3-free-minimax-m3')
    expect(FREEBUFF_CLI_BASE3_AGENT_ID_BY_MODEL[M3]).toBe('base3-free-minimax-m3')
    for (const id of ['base2-free-minimax-m3', 'base3-free-minimax-m3']) {
      expect(FREEBUFF_ROOT_AGENT_IDS as readonly string[]).toContain(id)
    }
    for (const id of [
      'base2-free-minimax-m3',
      'base3-free-minimax-m3',
      'code-reviewer-minimax-m3',
    ]) {
      // Pinned to exactly one model: a retired root that widened would be a
      // door onto everything it allows.
      expect([...(FREE_MODE_AGENT_MODELS[id] ?? [])]).toEqual([M3])
    }
  })
})
