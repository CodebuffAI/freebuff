import { describe, expect, test } from 'bun:test'

import {
  contextPrunerBudgetForModel,
  getModelFromShortName,
  isExplicitlyDefinedModel,
  models,
  supportsAssistantPrefill,
} from '../constants/model-config'

describe('isExplicitlyDefinedModel', () => {
  test('distinguishes configured models from unknown model IDs', () => {
    expect(isExplicitlyDefinedModel(models.openrouter_gpt5)).toBe(true)
    expect(isExplicitlyDefinedModel('custom/unknown-model')).toBe(false)
  })

  // Adding one would switch the SDK's provider routing for its live traffic
  // (Sonnet 4.6: context-pruner) to a fixed order with no fallbacks.
  test('leaves the retired-Claude replacements unconfigured', () => {
    expect(isExplicitlyDefinedModel('anthropic/claude-sonnet-4.6')).toBe(false)
    expect(isExplicitlyDefinedModel('anthropic/claude-haiku-4.5')).toBe(false)
    expect(isExplicitlyDefinedModel('anthropic/claude-opus-4.6')).toBe(false)
  })
})

describe('getModelFromShortName', () => {
  test('serves the retired Sonnet short names on Sonnet 4.6', () => {
    for (const name of ['sonnet-4', 'sonnet-3.7', 'sonnet-3.6', 'sonnet-3.5']) {
      expect(getModelFromShortName(name)).toBe('anthropic/claude-sonnet-4.6')
    }
  })

  test('serves the retired Opus short name on Opus 4.6', () => {
    expect(getModelFromShortName('opus-4')).toBe('anthropic/claude-opus-4.6')
  })
})

describe('supportsAssistantPrefill', () => {
  test('rejects prefill for Claude 4.6+', () => {
    expect(supportsAssistantPrefill('anthropic/claude-opus-4.6')).toBe(false)
    expect(supportsAssistantPrefill('anthropic/claude-opus-4.7')).toBe(false)
    expect(supportsAssistantPrefill('anthropic/claude-sonnet-4.6')).toBe(false)
    expect(supportsAssistantPrefill('anthropic/claude-fable-5')).toBe(false)
  })

  test('allows prefill for Claude before 4.6', () => {
    expect(supportsAssistantPrefill('anthropic/claude-sonnet-4.5')).toBe(true)
    expect(supportsAssistantPrefill('anthropic/claude-opus-4')).toBe(true)
    expect(supportsAssistantPrefill('anthropic/claude-3-5-sonnet')).toBe(true)
    expect(
      supportsAssistantPrefill('anthropic/claude-haiku-4-5-20251001'),
    ).toBe(true)
  })

  test('allows prefill for non-Claude models', () => {
    expect(supportsAssistantPrefill('openai/gpt-5.1')).toBe(true)
    expect(supportsAssistantPrefill('deepseek/deepseek-v4-pro')).toBe(true)
    expect(supportsAssistantPrefill('moonshotai/kimi-k2.6')).toBe(true)
  })
})

describe('contextPrunerBudgetForModel', () => {
  test('defaults to 400k, which every ~1M-window model we serve can hold', () => {
    for (const model of [
      'anthropic/claude-opus-5',
      'anthropic/claude-sonnet-5',
      'openai/gpt-5.4',
      'openai/gpt-5.6-luna',
      'deepseek/deepseek-v4-flash',
      'deepseek/deepseek-v4-pro',
      'mimo/mimo-v2.5',
      'z-ai/glm-5.2',
      // MiniMax M3's real enforced limit is 524_288 (Fireworks rejects with
      // "model maximum context length: 524287"), not the 1M OpenRouter lists.
      // 400k is still comfortably under it.
      'minimax/minimax-m3',
      'some/model-we-have-never-shipped',
    ]) {
      expect(contextPrunerBudgetForModel(model)).toBe(400_000)
    }
  })

  test('drops to 250k for the 262,144-token models', () => {
    // Kimi K2.7 Code is the only remaining exception: the HY3 and Ling 3.0
    // Flash entries that shared its window went with those models on
    // 2026-08-07, so they now take the 400k default like anything unlisted.
    expect(contextPrunerBudgetForModel('moonshotai/kimi-k2.7-code')).toBe(
      250_000,
    )
    for (const removed of [
      'tencent/hy3',
      'tencent/hy3:free',
      'tencent/hy3-preview',
      'inclusionai/ling-3.0-flash:free',
    ]) {
      expect(contextPrunerBudgetForModel(removed)).toBe(400_000)
    }
  })

  test('every exception stays under its real window', () => {
    // The budget is compared against a GPT-4o-based estimate applied to other
    // tokenizers, so it must sit under the provider's limit with room to spare.
    expect(
      contextPrunerBudgetForModel('moonshotai/kimi-k2.7-code'),
    ).toBeLessThan(262_144)
    // Kimi K3 Eco is deliberately NOT an exception — CrofAI serves it at a 1M
    // context, so the 400k default is correct for it.
    expect(contextPrunerBudgetForModel('crof/kimi-k3-eco')).toBe(400_000)
  })
})
