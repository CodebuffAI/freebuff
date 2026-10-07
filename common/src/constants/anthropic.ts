/** OpenRouter id of Claude Sonnet 4.6, which serves the retired Sonnet ids. */
export const CLAUDE_SONNET_4_6_MODEL_ID = 'anthropic/claude-sonnet-4.6'

/** OpenRouter id of Claude Haiku 4.5, which serves the retired Haiku ids. */
export const CLAUDE_HAIKU_4_5_MODEL_ID = 'anthropic/claude-haiku-4.5'

/** OpenRouter id of Claude Opus 4.6, which serves the retired Opus ids. */
export const CLAUDE_OPUS_4_6_MODEL_ID = 'anthropic/claude-opus-4.6'

/**
 * Retired Claude ids that clients still send, mapped to the OpenRouter id of
 * the model that serves them now. Anthropic retired claude-sonnet-4-20250514
 * on 2026-06-15 (404 not_found_error) and OpenRouter serves Sonnet 4 on
 * Amazon Bedrock alone, but published agents are immutable (an old
 * `codebuff/base` still names it). Sonnet 4.6 bills at the same $3/$15 per
 * million tokens.
 *
 * The Claude 3.x ids, Opus 4 and Opus 4.1 are retired too (Anthropic's model
 * deprecations page; Opus 4.1 went last, on 2026-08-05). OpenRouter has no
 * endpoint left for any of them except Opus 4.1, which it serves on Amazon
 * Bedrock alone. Each family lands on its current model: Haiku 4.5, Sonnet 4.6
 * and Opus 4.6. Opus 4.6 rather than 4.8 because 4.7 and later answer 400 to
 * a non-default `temperature`, which a client written for Opus 4.1 may send;
 * both bill $5/$25. `anthropic/claude-haiku-4` never named a real model.
 */
export const RETIRED_CLAUDE_MODEL_ALIASES: Readonly<Record<string, string>> = {
  'anthropic/claude-sonnet-4': CLAUDE_SONNET_4_6_MODEL_ID,
  'anthropic/claude-4-sonnet-20250522': CLAUDE_SONNET_4_6_MODEL_ID,
  'anthropic/claude-4-sonnet': CLAUDE_SONNET_4_6_MODEL_ID,
  'anthropic/claude-3.7-sonnet': CLAUDE_SONNET_4_6_MODEL_ID,
  'anthropic/claude-3.5-sonnet': CLAUDE_SONNET_4_6_MODEL_ID,
  'anthropic/claude-3.5-sonnet-20240620': CLAUDE_SONNET_4_6_MODEL_ID,
  'anthropic/claude-3-5-sonnet': CLAUDE_SONNET_4_6_MODEL_ID,
  'anthropic/claude-3-5-sonnet-20241022': CLAUDE_SONNET_4_6_MODEL_ID,
  'anthropic/claude-3-5-sonnet-20240620': CLAUDE_SONNET_4_6_MODEL_ID,
  'anthropic/claude-3-sonnet': CLAUDE_SONNET_4_6_MODEL_ID,

  'anthropic/claude-haiku-4': CLAUDE_HAIKU_4_5_MODEL_ID,
  'anthropic/claude-3.5-haiku': CLAUDE_HAIKU_4_5_MODEL_ID,
  'anthropic/claude-3.5-haiku-20241022': CLAUDE_HAIKU_4_5_MODEL_ID,
  'anthropic/claude-3-5-haiku': CLAUDE_HAIKU_4_5_MODEL_ID,
  'anthropic/claude-3-5-haiku-20241022': CLAUDE_HAIKU_4_5_MODEL_ID,
  'anthropic/claude-3-haiku': CLAUDE_HAIKU_4_5_MODEL_ID,

  'anthropic/claude-opus-4.1': CLAUDE_OPUS_4_6_MODEL_ID,
  'anthropic/claude-opus-4': CLAUDE_OPUS_4_6_MODEL_ID,
  'anthropic/claude-3-opus': CLAUDE_OPUS_4_6_MODEL_ID,
  'anthropic/claude-3-opus-20240229': CLAUDE_OPUS_4_6_MODEL_ID,
}

/** The model that serves `model`: its alias if retired, else `model` itself. */
export function resolveRetiredClaudeModel(model: string): string {
  return Object.hasOwn(RETIRED_CLAUDE_MODEL_ALIASES, model)
    ? RETIRED_CLAUDE_MODEL_ALIASES[model]
    : model
}

/**
 * OpenRouter → Anthropic model ID mapping. Used by the token-count API to
 * route Anthropic-family requests to Anthropic's native counting endpoint.
 */

const OPENROUTER_TO_ANTHROPIC_MODEL_MAP: Record<string, string> = {
  // Claude 4.x Haiku models
  'anthropic/claude-haiku-4.5': 'claude-haiku-4-5-20251001',

  // Claude 4.x Sonnet models
  'anthropic/claude-sonnet-4.6': 'claude-sonnet-4-6',
  'anthropic/claude-sonnet-4.5': 'claude-sonnet-4-5-20250929',

  // Claude 5.x models
  'anthropic/claude-fable-5': 'claude-fable-5',
  'anthropic/claude-fable-5.1': 'claude-fable-5-1',
  'anthropic/claude-opus-5.5': 'claude-opus-5-5',
  'anthropic/claude-opus-5': 'claude-opus-5',
  'anthropic/claude-sonnet-5': 'claude-sonnet-5',

  // Claude 4.x Opus models
  'anthropic/claude-opus-4.8': 'claude-opus-4-8',
  'anthropic/claude-opus-4.7': 'claude-opus-4-7',
  'anthropic/claude-opus-4.6': 'claude-opus-4-6',
  'anthropic/claude-opus-4.5': 'claude-opus-4-5-20251101',
}

export function isClaudeModel(model: string): boolean {
  return model.startsWith('anthropic/') || model.startsWith('claude-')
}

/**
 * Convert an OpenRouter model ID to an Anthropic model ID.
 * Throws if the model has a non-anthropic provider prefix.
 */
export function toAnthropicModelId(requestedModel: string): string {
  const openrouterModel = resolveRetiredClaudeModel(requestedModel)

  // Already an Anthropic model ID (no provider prefix)
  if (!openrouterModel.includes('/')) {
    return openrouterModel
  }

  if (!openrouterModel.startsWith('anthropic/')) {
    throw new Error(
      `Cannot convert non-Anthropic model to Anthropic model ID: ${openrouterModel}`,
    )
  }

  // Unmapped: Anthropic ids spell versions with hyphens where OpenRouter uses
  // dots. Stripping only the prefix sent `claude-opus-5.5`, which Anthropic
  // 404s: every Opus 5.5 token count failed from 2026-09-23 to 09-27.
  return (
    OPENROUTER_TO_ANTHROPIC_MODEL_MAP[openrouterModel] ??
    openrouterModel.replace('anthropic/', '').replaceAll('.', '-')
  )
}
