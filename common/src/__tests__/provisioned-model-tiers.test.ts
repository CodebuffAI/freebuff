/**
 * The provisioned tiers (extended-context `-max` and early-access) and the
 * internal evaluation routes.
 *
 * These are granted per account rather than picked, so the invariant is the
 * opposite of a normal model's: every catalog must NOT contain them. A client
 * that rendered one would offer a row most accounts cannot run, and the
 * request would fail at admission rather than at the picker — the confusing
 * shape a hidden tier always takes when it leaks into a selectable list.
 *
 * Each tier is pinned to exactly one root, like every other free-mode model,
 * and each root is pinned to exactly that tier: a root that also accepted the
 * base model would be a second, unmetered door onto it — which is what the
 * retired `base2-free-glm-crof` route turned out to be.
 */
import { describe, expect, test } from 'bun:test'

import {
  FREE_MODE_AGENT_MODELS,
  FREEBUFF_CLI_BASE3_AGENT_ID_BY_MODEL,
  FREEBUFF_ROOT_AGENT_IDS,
  FREEBUFF_WEB_BASE3_AGENT_ID_BY_MODEL,
  getFreebuffRootAgentIdForModel,
  isFreeModeAllowedAgentModel,
} from '../constants/free-agents'
import {
  FREEBUFF_MIMO_V25_MODEL_ID,
  FREEBUFF_CLAUDE_OPUS_4_8_MODEL_ID,
  FREEBUFF_CLAUDE_OPUS_5_5_MODEL_ID,
  FREEBUFF_CLAUDE_OPUS_5_MODEL_ID,
  FREEBUFF_CLAUDE_SONNET_4_6_MODEL_ID,
  FREEBUFF_CLAUDE_SONNET_5_MODEL_ID,
  FREEBUFF_CODESTRAL_2508_MODEL_ID,
  FREEBUFF_DEEPSEEK_V41_FLASH_MODEL_ID,
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
  FREEBUFF_FABLE_5_1_MODEL_ID,
  FREEBUFF_GEMINI_3_5_FLASH_MODEL_ID,
  FREEBUFF_GEMINI_3_6_FLASH_MODEL_ID,
  FREEBUFF_GEMINI_3_7_FLASH_MODEL_ID,
  FREEBUFF_GLM_5_3_FLASHX_MODEL_ID,
  FREEBUFF_GLM_5_3_PRIME_MODEL_ID,
  FREEBUFF_GLM_5_TURBO_MODEL_ID,
  FREEBUFF_GLM_V53_FLASH_MODEL_ID,
  FREEBUFF_GLM_V53_MODEL_ID,
  FREEBUFF_GPT_5_4_PRO_MODEL_ID,
  FREEBUFF_GPT_5_5_MODEL_ID,
  FREEBUFF_GPT_5_5_PRO_MODEL_ID,
  FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
  FREEBUFF_GPT_5_6_LUNA_PRO_MODEL_ID,
  FREEBUFF_GPT_5_6_SOL_MODEL_ID,
  FREEBUFF_GPT_5_6_SOL_PRO_MODEL_ID,
  FREEBUFF_GPT_5_6_TERRA_MODEL_ID,
  FREEBUFF_GPT_5_6_TERRA_PRO_MODEL_ID,
  FREEBUFF_GPT_6_ASTRA_MODEL_ID,
  FREEBUFF_GPT_6_ASTRA_PRO_MODEL_ID,
  FREEBUFF_GPT_6_LUNA_PRO_MODEL_ID,
  FREEBUFF_GPT_6_SOL_MODEL_ID,
  FREEBUFF_GPT_6_SOL_PRO_MODEL_ID,
  FREEBUFF_GROK_4_20_MODEL_ID,
  FREEBUFF_GROK_4_5_MODEL_ID,
  FREEBUFF_GROK_4_6_MODEL_ID,
  FREEBUFF_GROK_4_7_MODEL_ID,
  FREEBUFF_KIMI_K3_MODEL_ID,
  FREEBUFF_LLAMA_4_MAVERICK_MODEL_ID,
  FREEBUFF_MISTRAL_LARGE_MODEL_ID,
  FREEBUFF_MODELS,
  FREEBUFF_O3_PRO_MODEL_ID,
  FREEBUFF_PROVISIONED_MODELS,
  FREEBUFF_QWEN3_6_MAX_PREVIEW_MODEL_ID,
  FREEBUFF_QWEN3_6_PLUS_MODEL_ID,
  FREEBUFF_QWEN3_7_MAX_MODEL_ID,
  FREEBUFF_QWEN3_7_PLUS_MODEL_ID,
  FREEBUFF_QWEN3_8_27B_MODEL_ID,
  FREEBUFF_QWEN3_8_FLASH_MODEL_ID,
  FREEBUFF_QWEN3_8_MAX_0902_MODEL_ID,
  FREEBUFF_QWEN3_8_MAX_PRIME_MODEL_ID,
  FREEBUFF_SOLAR_MINI_4_MODEL_ID,
  FREEBUFF_STANDARD_MODEL_IDS,
  FREEBUFF_WEB_ALL_MODELS,
  FREEBUFF_WEB_MODELS,
  FREEBUFF_WEB_PREMIUM_MODEL_IDS,
  SUPPORTED_FREEBUFF_MODELS,
  resolveSupportedFreebuffModel,
} from '../constants/freebuff-models'

/** tier -> the root that runs it, and the base model it extends. */
const TIERS: Array<{ id: string; root: string; base: string }> = [
  {
    id: FREEBUFF_DEEPSEEK_V41_FLASH_MODEL_ID,
    root: 'base2-free-deepseek-v4-1-flash',
    base: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  },
  {
    id: FREEBUFF_GLM_V53_MODEL_ID,
    root: 'base2-free-glm-5-3',
    base: FREEBUFF_GLM_V53_FLASH_MODEL_ID,
  },
  {
    id: FREEBUFF_GPT_6_SOL_MODEL_ID,
    root: 'base2-free-gpt-6-sol',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_GPT_6_SOL_PRO_MODEL_ID,
    root: 'base2-free-gpt-6-sol-pro',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_GPT_6_LUNA_PRO_MODEL_ID,
    root: 'base2-free-gpt-6-luna-pro',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_GPT_6_ASTRA_MODEL_ID,
    root: 'base2-free-gpt-6-astra',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_GPT_6_ASTRA_PRO_MODEL_ID,
    root: 'base2-free-gpt-6-astra-pro',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_GPT_5_6_SOL_MODEL_ID,
    root: 'base2-free-gpt-5-6-sol',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_GPT_5_6_SOL_PRO_MODEL_ID,
    root: 'base2-free-gpt-5-6-sol-pro',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_GPT_5_6_TERRA_MODEL_ID,
    root: 'base2-free-gpt-5-6-terra',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_GPT_5_6_TERRA_PRO_MODEL_ID,
    root: 'base2-free-gpt-5-6-terra-pro',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_GPT_5_6_LUNA_PRO_MODEL_ID,
    root: 'base2-free-gpt-5-6-luna-pro',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_GPT_5_5_MODEL_ID,
    root: 'base2-free-gpt-5-5',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_GPT_5_5_PRO_MODEL_ID,
    root: 'base2-free-gpt-5-5-pro',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_GPT_5_4_PRO_MODEL_ID,
    root: 'base2-free-gpt-5-4-pro',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_O3_PRO_MODEL_ID,
    root: 'base2-free-o3-pro',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_CLAUDE_OPUS_5_5_MODEL_ID,
    root: 'base2-free-claude-opus-5-5',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_CLAUDE_OPUS_5_MODEL_ID,
    root: 'base2-free-claude-opus-5',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_CLAUDE_SONNET_5_MODEL_ID,
    root: 'base2-free-claude-sonnet-5',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_CLAUDE_OPUS_4_8_MODEL_ID,
    root: 'base2-free-claude-opus-4-8',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_CLAUDE_SONNET_4_6_MODEL_ID,
    root: 'base2-free-claude-sonnet-4-6',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_QWEN3_8_MAX_PRIME_MODEL_ID,
    root: 'base2-free-qwen3-8-max-prime',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_QWEN3_8_MAX_0902_MODEL_ID,
    root: 'base2-free-qwen3-8-max-0902',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_QWEN3_8_FLASH_MODEL_ID,
    root: 'base2-free-qwen3-8-flash',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_QWEN3_8_27B_MODEL_ID,
    root: 'base2-free-qwen3-8-27b',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_QWEN3_7_MAX_MODEL_ID,
    root: 'base2-free-qwen3-7-max',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_QWEN3_7_PLUS_MODEL_ID,
    root: 'base2-free-qwen3-7-plus',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_QWEN3_6_MAX_PREVIEW_MODEL_ID,
    root: 'base2-free-qwen3-6-max-preview',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_QWEN3_6_PLUS_MODEL_ID,
    root: 'base2-free-qwen3-6-plus',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_GROK_4_7_MODEL_ID,
    root: 'base2-free-grok-4-7',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_GROK_4_6_MODEL_ID,
    root: 'base2-free-grok-4-6',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_GROK_4_5_MODEL_ID,
    root: 'base2-free-grok-4-5',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_GROK_4_20_MODEL_ID,
    root: 'base2-free-grok-4-20',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_GEMINI_3_7_FLASH_MODEL_ID,
    root: 'base2-free-gemini-3-7-flash',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_GEMINI_3_6_FLASH_MODEL_ID,
    root: 'base2-free-gemini-3-6-flash',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_GEMINI_3_5_FLASH_MODEL_ID,
    root: 'base2-free-gemini-3-5-flash',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_KIMI_K3_MODEL_ID,
    root: 'base2-free-kimi-k3',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_GLM_5_3_PRIME_MODEL_ID,
    root: 'base2-free-glm-5-3-prime',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_GLM_5_3_FLASHX_MODEL_ID,
    root: 'base2-free-glm-5-3-flashx',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_GLM_5_TURBO_MODEL_ID,
    root: 'base2-free-glm-5-turbo',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_MISTRAL_LARGE_MODEL_ID,
    root: 'base2-free-mistral-large',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_CODESTRAL_2508_MODEL_ID,
    root: 'base2-free-codestral-2508',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
  {
    id: FREEBUFF_LLAMA_4_MAVERICK_MODEL_ID,
    root: 'base2-free-llama-4-maverick',
    base: FREEBUFF_MIMO_V25_MODEL_ID,
  },
]

describe('provisioned tiers are never offered from a catalog', () => {
  test('the tier list is not empty', () => {
    // Floor: an empty list makes every case below vacuous.
    expect(FREEBUFF_PROVISIONED_MODELS.length).toBe(TIERS.length)
    const rowIds = [...FREEBUFF_PROVISIONED_MODELS].map((m) => m.id)
    for (const tier of TIERS) expect(rowIds).toContain(tier.id)
  })

  const catalogs: Array<[string, readonly string[]]> = [
    ['SUPPORTED_FREEBUFF_MODELS', SUPPORTED_FREEBUFF_MODELS.map((m) => m.id)],
    ['FREEBUFF_MODELS', FREEBUFF_MODELS.map((m) => m.id)],
    ['FREEBUFF_WEB_MODELS', FREEBUFF_WEB_MODELS.map((m) => m.id)],
    ['FREEBUFF_WEB_ALL_MODELS', FREEBUFF_WEB_ALL_MODELS.map((m) => m.id)],
    ['FREEBUFF_WEB_PREMIUM_MODEL_IDS', [...FREEBUFF_WEB_PREMIUM_MODEL_IDS]],
    ['FREEBUFF_STANDARD_MODEL_IDS', [...FREEBUFF_STANDARD_MODEL_IDS]],
  ]

  test.each(catalogs)('%s omits every provisioned tier', (_name, ids) => {
    for (const tier of TIERS) expect(ids).not.toContain(tier.id)
  })

  test('a saved preference for a tier falls back to a pickable model', () => {
    for (const tier of TIERS) {
      expect(resolveSupportedFreebuffModel(tier.id)).not.toBe(tier.id)
    }
  })

  test('the base2 root map resolves each tier to its own root', () => {
    // An account holding the grant starts on the tier's root, never on the
    // base model's.
    for (const tier of TIERS) {
      expect(getFreebuffRootAgentIdForModel(tier.id)).toBe(tier.root)
    }
  })

  test('no base3 root map resolves a provisioned tier', () => {
    for (const tier of TIERS) {
      expect(FREEBUFF_WEB_BASE3_AGENT_ID_BY_MODEL[tier.id]).toBeUndefined()
      expect(FREEBUFF_CLI_BASE3_AGENT_ID_BY_MODEL[tier.id]).toBeUndefined()
    }
  })
})

describe('each tier is pinned to exactly one root', () => {
  test.each(TIERS)('$id runs on $root and nothing else', (tier) => {
    expect(FREE_MODE_AGENT_MODELS[tier.root]?.has(tier.id)).toBe(true)
    expect(isFreeModeAllowedAgentModel(tier.root, tier.id)).toBe(true)
  })

  test.each(TIERS)('$root cannot run the base model $base', (tier) => {
    // A second, unmetered door onto the base model otherwise.
    expect(isFreeModeAllowedAgentModel(tier.root, tier.base)).toBe(false)
  })

  test.each(TIERS)('$root is a registered root agent', (tier) => {
    // A root absent from this list is treated as a subagent, so a top-level
    // request on it fails the hierarchy check instead of running.
    expect(FREEBUFF_ROOT_AGENT_IDS).toContain(tier.root)
  })

  test.each(TIERS)('the base model does not run on $root', (tier) => {
    const rootForBase = Object.entries(FREE_MODE_AGENT_MODELS).filter(
      ([agentId, models]) => models.has(tier.base) && agentId === tier.root,
    )
    expect(rootForBase).toEqual([])
  })
})
