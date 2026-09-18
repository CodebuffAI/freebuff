/**
 * OpenRouter → Anthropic model ID mapping. Used by the token-count API to
 * route Anthropic-family requests to Anthropic's native counting endpoint.
 */

const OPENROUTER_TO_ANTHROPIC_MODEL_MAP: Record<string, string> = {
  // Claude 3.x Haiku models
  'anthropic/claude-3.5-haiku-20241022': 'claude-3-5-haiku-20241022',
  'anthropic/claude-3.5-haiku': 'claude-3-5-haiku-20241022',
  'anthropic/claude-3-5-haiku': 'claude-3-5-haiku-20241022',
  'anthropic/claude-3-5-haiku-20241022': 'claude-3-5-haiku-20241022',
  'anthropic/claude-3-haiku': 'claude-3-haiku-20240307',

  // Claude 3.x Sonnet models
  'anthropic/claude-3.5-sonnet': 'claude-3-5-sonnet-20241022',
  'anthropic/claude-3-5-sonnet': 'claude-3-5-sonnet-20241022',
  'anthropic/claude-3-5-sonnet-20241022': 'claude-3-5-sonnet-20241022',
  'anthropic/claude-3-5-sonnet-20240620': 'claude-3-5-sonnet-20240620',
  'anthropic/claude-3-sonnet': 'claude-3-sonnet-20240229',

  // Claude 3.x Opus models
  'anthropic/claude-3-opus': 'claude-3-opus-20240229',
  'anthropic/claude-3-opus-20240229': 'claude-3-opus-20240229',

  // Claude 4.x Haiku models
  'anthropic/claude-haiku-4.5': 'claude-haiku-4-5-20251001',
  'anthropic/claude-haiku-4': 'claude-haiku-4-20250514',

  // Claude 4.x Sonnet models
  'anthropic/claude-sonnet-4.6': 'claude-sonnet-4-6',
  'anthropic/claude-sonnet-4.5': 'claude-sonnet-4-5-20250929',
  'anthropic/claude-sonnet-4': 'claude-sonnet-4-20250514',
  'anthropic/claude-4-sonnet-20250522': 'claude-sonnet-4-20250514',
  'anthropic/claude-4-sonnet': 'claude-sonnet-4-20250514',

  // Claude 5.x models
  'anthropic/claude-fable-5': 'claude-fable-5',
  'anthropic/claude-fable-5.1': 'claude-fable-5-1',
  'anthropic/claude-opus-5': 'claude-opus-5',

  // Claude 4.x Opus models
  'anthropic/claude-opus-4.8': 'claude-opus-4-8',
  'anthropic/claude-opus-4.7': 'claude-opus-4-7',
  'anthropic/claude-opus-4.6': 'claude-opus-4-6',
  'anthropic/claude-opus-4.5': 'claude-opus-4-5-20251101',
  'anthropic/claude-opus-4.1': 'claude-opus-4-1-20250805',
  'anthropic/claude-opus-4': 'claude-opus-4-1-20250805',
}

export function isClaudeModel(model: string): boolean {
  return model.startsWith('anthropic/') || model.startsWith('claude-')
}

/**
 * Convert an OpenRouter model ID to an Anthropic model ID.
 * Throws if the model has a non-anthropic provider prefix.
 */
export function toAnthropicModelId(openrouterModel: string): string {
  // Already an Anthropic model ID (no provider prefix)
  if (!openrouterModel.includes('/')) {
    return openrouterModel
  }

  if (!openrouterModel.startsWith('anthropic/')) {
    throw new Error(
      `Cannot convert non-Anthropic model to Anthropic model ID: ${openrouterModel}`,
    )
  }

  return (
    OPENROUTER_TO_ANTHROPIC_MODEL_MAP[openrouterModel] ??
    openrouterModel.replace('anthropic/', '')
  )
}
