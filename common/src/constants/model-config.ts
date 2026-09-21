// Allowed model prefixes for validation
export const ALLOWED_MODEL_PREFIXES = [
  'anthropic',
  'openai',
  'google',
  'x-ai',
  'deepseek',
  'minimax',
  'mimo',
  'tencent',
] as const

export const costModes = [
  'free',
  'lite',
  'normal',
  'max',
  'experimental',
  'ask',
] as const
export type CostMode = (typeof costModes)[number]

export const openaiModels = {
  gpt4_1: 'gpt-4.1-2025-04-14',
  gpt4o: 'gpt-4o-2024-11-20',
  gpt4omini: 'gpt-4o-mini-2024-07-18',
  o3mini: 'o3-mini-2025-01-31',
  o3: 'o3-2025-04-16',
  o3pro: 'o3-pro-2025-06-10',
  o4mini: 'o4-mini-2025-04-16',
  generatePatch:
    'ft:gpt-4o-2024-08-06:manifold-markets:generate-patch-batch2:AKYtDIhk',
} as const
export type OpenAIModel = (typeof openaiModels)[keyof typeof openaiModels]

export const openrouterModels = {
  openrouter_claude_sonnet_4_5: 'anthropic/claude-sonnet-4.5',
  openrouter_claude_sonnet_4: 'anthropic/claude-4-sonnet-20250522',
  openrouter_claude_opus_4: 'anthropic/claude-opus-4.1',
  openrouter_claude_3_5_haiku: 'anthropic/claude-3.5-haiku-20241022',
  openrouter_claude_3_5_sonnet: 'anthropic/claude-3.5-sonnet-20240620',
  openrouter_gpt4o: 'openai/gpt-4o-2024-11-20',
  openrouter_gpt5: 'openai/gpt-5.1',
  openrouter_gpt5_chat: 'openai/gpt-5.1-chat',
  openrouter_gpt4o_mini: 'openai/gpt-4o-mini-2024-07-18',
  openrouter_gpt4_1_nano: 'openai/gpt-4.1-nano',
  openrouter_o3_mini: 'openai/o3-mini-2025-01-31',
  openrouter_gemini2_5_pro_preview: 'google/gemini-2.5-pro',
  openrouter_gemini2_5_flash: 'google/gemini-2.5-flash',
  openrouter_gemini2_5_flash_thinking:
    'google/gemini-2.5-flash-preview:thinking',
  openrouter_grok_4: 'x-ai/grok-4-07-09',
} as const
export type openrouterModel =
  (typeof openrouterModels)[keyof typeof openrouterModels]

export const openCodeZenModels = {
  opencode_kimi_k2_6: 'opencode/kimi-k2.6',
} as const
export type OpenCodeZenModel =
  (typeof openCodeZenModels)[keyof typeof openCodeZenModels]

export const deepseekModels = {
  deepseekChat: 'deepseek-chat',
  deepseekReasoner: 'deepseek-reasoner',
  deepseekV4ProDirect: 'deepseek-v4-pro',
  deepseekV4Pro: 'deepseek/deepseek-v4-pro',
  deepseekV4FlashDirect: 'deepseek-v4-flash',
  deepseekV4Flash: 'deepseek/deepseek-v4-flash',
} as const
export type DeepseekModel = (typeof deepseekModels)[keyof typeof deepseekModels]

export const mimoModels = {
  mimoV25Direct: 'mimo-v2.5',
  mimoV25: 'mimo/mimo-v2.5',
  mimoV25ProDirect: 'mimo-v2.5-pro',
  mimoV25Pro: 'mimo/mimo-v2.5-pro',
  // MiMo 2.6 Flash has NO wire id of its own: it is served under `mimoV25`,
  // which every released client, allowlist and fallback already names — the
  // same move as DeepSeek V4.1 under the undated V4 Flash id. This is only the
  // upstream name Xiaomi's API (and OpenRouter's `xiaomi/` slug) calls it.
  mimoV26FlashDirect: 'mimo-v2.6-flash',
  mimoV26ProDirect: 'mimo-v2.6-pro',
  mimoV26Pro: 'mimo/mimo-v2.6-pro',
} as const
export type MimoModel = (typeof mimoModels)[keyof typeof mimoModels]

export const minimaxModels = {
  minimaxM3: 'minimax/minimax-m3',
} as const
export type MiniMaxModel = (typeof minimaxModels)[keyof typeof minimaxModels]

export const moonshotModels = {
  kimiK26: 'moonshotai/kimi-k2.6',
  kimiK27Code: 'moonshotai/kimi-k2.7-code',
} as const
export type MoonshotModel = (typeof moonshotModels)[keyof typeof moonshotModels]

// Vertex uses "endpoint IDs" for finetuned models, which are just integers
export const finetunedVertexModels = {
  ft_filepicker_003: '196166068534771712',
  ft_filepicker_005: '8493203957034778624',
  ft_filepicker_007: '2589952415784501248',
  ft_filepicker_topk_001: '3676445825887633408',
  ft_filepicker_008: '2672143108984012800',
  ft_filepicker_topk_002: '1694861989844615168',
  ft_filepicker_010: '3808739064941641728',
  ft_filepicker_010_epoch_2: '6231675664466968576',
  ft_filepicker_topk_003: '1502192368286171136',
} as const
export const finetunedVertexModelNames: Record<string, string> = {
  [finetunedVertexModels.ft_filepicker_003]: 'ft_filepicker_003',
  [finetunedVertexModels.ft_filepicker_005]: 'ft_filepicker_005',
  [finetunedVertexModels.ft_filepicker_007]: 'ft_filepicker_007',
  [finetunedVertexModels.ft_filepicker_topk_001]: 'ft_filepicker_topk_001',
  [finetunedVertexModels.ft_filepicker_008]: 'ft_filepicker_008',
  [finetunedVertexModels.ft_filepicker_topk_002]: 'ft_filepicker_topk_002',
  [finetunedVertexModels.ft_filepicker_010]: 'ft_filepicker_010',
  [finetunedVertexModels.ft_filepicker_010_epoch_2]:
    'ft_filepicker_010_epoch_2',
  [finetunedVertexModels.ft_filepicker_topk_003]: 'ft_filepicker_topk_003',
}
export type FinetunedVertexModel =
  (typeof finetunedVertexModels)[keyof typeof finetunedVertexModels]

export const models = {
  ...openaiModels,
  ...deepseekModels,
  ...mimoModels,
  ...minimaxModels,
  ...openrouterModels,
  ...finetunedVertexModels,
} as const

export const shortModelNames = {
  'gemini-2.5-pro': models.openrouter_gemini2_5_pro_preview,
  'flash-2.5': models.openrouter_gemini2_5_flash,
  'opus-4': models.openrouter_claude_opus_4,
  'sonnet-4.5': models.openrouter_claude_sonnet_4_5,
  'sonnet-4': models.openrouter_claude_sonnet_4,
  'sonnet-3.7': models.openrouter_claude_sonnet_4,
  'sonnet-3.6': models.openrouter_claude_3_5_sonnet,
  'sonnet-3.5': models.openrouter_claude_3_5_sonnet,
  'gpt-4.1': models.gpt4_1,
  'o3-mini': models.o3mini,
  o3: models.o3,
  'o4-mini': models.o4mini,
  'o3-pro': models.o3pro,
}

export const providerModelNames = {
  ...Object.fromEntries(
    Object.entries(openaiModels).map(([name, model]) => [
      model,
      'openai' as const,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(openrouterModels).map(([name, model]) => [
      model,
      'openrouter' as const,
    ]),
  ),
}

export type Model = (typeof models)[keyof typeof models] | (string & {})

const explicitlyDefinedModels = new Set<string>(Object.values(models))

/** Whether `model` is one of the statically configured model IDs. */
export function isExplicitlyDefinedModel(model: Model): boolean {
  return explicitlyDefinedModels.has(model)
}

const nonCacheableModels = [
  models.openrouter_grok_4,
] satisfies string[] as string[]
export function supportsCacheControl(model: Model): boolean {
  if (model.startsWith('openai/')) {
    return true
  }
  if (model.startsWith('anthropic/')) {
    return true
  }
  if (!isExplicitlyDefinedModel(model)) {
    // Default to no cache control for unknown models
    return false
  }
  return !nonCacheableModels.includes(model)
}

/**
 * Claude 4.6+ (including Fable) rejects requests whose final message is an
 * assistant message ("This model does not support assistant message prefill"),
 * e.g. when routed through Amazon Bedrock. Older Claude models and other
 * providers accept a trailing assistant message as a prefill to continue from.
 */
export function supportsAssistantPrefill(model: Model): boolean {
  const match = model.match(/claude-(?:[a-z]+-)?(\d+(?:[.-]\d+)?)/)
  if (!match) {
    return true
  }
  const version = parseFloat(match[1].replace('-', '.'))
  return version < 4.6
}

/**
 * Token budget a model's conversation may reach before context-pruner
 * summarizes it, compared against `agentState.contextTokenCount`.
 *
 * 400k by default: every model we serve has roughly a 1M window, which leaves
 * ample headroom — including for the estimator being a GPT-4o count applied to
 * models with their own tokenizers, so it can run under the provider's real
 * number.
 *
 * The one exception is the 262,144-token Kimi K2.7 Code below, confirmed by a
 * provider rejection quoted in freebuff-models.ts. It gets 250k, the value it
 * has been running on in prod. That margin is thin for exactly the estimator
 * reason above, so it is the number to revisit if this model starts hitting
 * context rejections. (The HY3 and Ling 3.0 Flash entries that used to sit
 * alongside it went with those models on 2026-08-07. Kimi K3 Eco is NOT an
 * exception: CrofAI serves it at a 1M context.)
 *
 * MiniMax M3 is deliberately NOT an exception: its real enforced limit is
 * 524,288, not the 1,048,576 OpenRouter advertises (Fireworks rejects with
 * "model maximum context length: 524287"), but 400k is still under it.
 *
 * The return type names the two tiers rather than `number` so a third tier is
 * a deliberate addition here. Serialized generators receive the result as
 * `AgentStepContext.contextPruning.maxContextLength`.
 */
const SMALL_CONTEXT_MODELS: ReadonlySet<string> = new Set([
  moonshotModels.kimiK27Code,
])

export function contextPrunerBudgetForModel(model: Model): 250_000 | 400_000 {
  return SMALL_CONTEXT_MODELS.has(model) ? 250_000 : 400_000
}

export function getModelFromShortName(
  modelName: string | undefined,
): Model | undefined {
  if (!modelName) return undefined
  if (modelName && !(modelName in shortModelNames)) {
    throw new Error(
      `Unknown model: ${modelName}. Please use a valid model. Valid models are: ${Object.keys(
        shortModelNames,
      ).join(', ')}`,
    )
  }

  return shortModelNames[modelName as keyof typeof shortModelNames]
}

export const providerDomains = {
  google: 'google.com',
  anthropic: 'anthropic.com',
  openai: 'chatgpt.com',
  deepseek: 'deepseek.com',
  minimax: 'minimax.io',
  mimo: 'xiaomi.com',
  tencent: 'tencent.com',
  xai: 'x.ai',
} as const

export function getLogoForModel(modelName: string): string | undefined {
  let domain: string | undefined

  if (Object.values(openaiModels).includes(modelName as OpenAIModel))
    domain = providerDomains.openai
  else if (Object.values(deepseekModels).includes(modelName as DeepseekModel))
    domain = providerDomains.deepseek
  else if (Object.values(minimaxModels).includes(modelName as MiniMaxModel))
    domain = providerDomains.minimax
  else if (Object.values(mimoModels).includes(modelName as MimoModel))
    domain = providerDomains.mimo
  else if (modelName.startsWith('tencent/')) domain = providerDomains.tencent
  else if (modelName.includes('claude')) domain = providerDomains.anthropic
  else if (modelName.includes('grok')) domain = providerDomains.xai

  return domain
    ? `https://www.google.com/s2/favicons?domain=${domain}&sz=256`
    : undefined
}
