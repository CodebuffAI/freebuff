import { describe, expect, test } from 'bun:test'

import {
  CLAUDE_HAIKU_4_5_MODEL_ID,
  CLAUDE_OPUS_4_6_MODEL_ID,
  CLAUDE_SONNET_4_6_MODEL_ID,
  RETIRED_CLAUDE_MODEL_ALIASES,
  resolveRetiredClaudeModel,
  toAnthropicModelId,
} from '../anthropic'

describe('resolveRetiredClaudeModel', () => {
  test('serves every retired Sonnet 4 id as Sonnet 4.6', () => {
    for (const retired of [
      'anthropic/claude-sonnet-4',
      'anthropic/claude-4-sonnet-20250522',
      'anthropic/claude-4-sonnet',
    ]) {
      expect(resolveRetiredClaudeModel(retired)).toBe(
        CLAUDE_SONNET_4_6_MODEL_ID,
      )
      expect(toAnthropicModelId(retired)).toBe('claude-sonnet-4-6')
    }
  })

  test("serves each retired Claude 3.x and Opus 4.x id on its family's current model", () => {
    for (const [retired, target, anthropicId] of [
      [
        'anthropic/claude-3-haiku',
        CLAUDE_HAIKU_4_5_MODEL_ID,
        'claude-haiku-4-5-20251001',
      ],
      [
        'anthropic/claude-3.5-haiku-20241022',
        CLAUDE_HAIKU_4_5_MODEL_ID,
        'claude-haiku-4-5-20251001',
      ],
      [
        'anthropic/claude-haiku-4',
        CLAUDE_HAIKU_4_5_MODEL_ID,
        'claude-haiku-4-5-20251001',
      ],
      [
        'anthropic/claude-3-sonnet',
        CLAUDE_SONNET_4_6_MODEL_ID,
        'claude-sonnet-4-6',
      ],
      [
        'anthropic/claude-3.5-sonnet-20240620',
        CLAUDE_SONNET_4_6_MODEL_ID,
        'claude-sonnet-4-6',
      ],
      [
        'anthropic/claude-3.7-sonnet',
        CLAUDE_SONNET_4_6_MODEL_ID,
        'claude-sonnet-4-6',
      ],
      [
        'anthropic/claude-3-opus-20240229',
        CLAUDE_OPUS_4_6_MODEL_ID,
        'claude-opus-4-6',
      ],
      ['anthropic/claude-opus-4', CLAUDE_OPUS_4_6_MODEL_ID, 'claude-opus-4-6'],
      [
        'anthropic/claude-opus-4.1',
        CLAUDE_OPUS_4_6_MODEL_ID,
        'claude-opus-4-6',
      ],
    ]) {
      expect(resolveRetiredClaudeModel(retired)).toBe(target)
      expect(toAnthropicModelId(retired)).toBe(anthropicId)
    }
  })

  // Anthropic's model deprecations page lists each of these as retired, and
  // a token count for one 404s and is retried on the default model.
  test('no alias reaches a retired Anthropic id', () => {
    const retiredAnthropicIds = [
      /^claude-3-/,
      /^claude-sonnet-4-20250514$/,
      /^claude-opus-4-(20250514|1-)/,
      /^claude-haiku-4-2025/,
    ]
    for (const retired of Object.keys(RETIRED_CLAUDE_MODEL_ALIASES)) {
      const anthropicId = toAnthropicModelId(retired)
      for (const pattern of retiredAnthropicIds) {
        expect(anthropicId).not.toMatch(pattern)
      }
    }
  })

  test('leaves current models and inherited keys alone', () => {
    expect(resolveRetiredClaudeModel('anthropic/claude-sonnet-4.5')).toBe(
      'anthropic/claude-sonnet-4.5',
    )
    expect(resolveRetiredClaudeModel('toString')).toBe('toString')
  })

  test('no alias points at another alias', () => {
    for (const target of Object.values(RETIRED_CLAUDE_MODEL_ALIASES)) {
      expect(resolveRetiredClaudeModel(target)).toBe(target)
    }
  })
})

describe('toAnthropicModelId', () => {
  test('maps the Freebuff Claude models to ids Anthropic accepts', () => {
    expect(toAnthropicModelId('anthropic/claude-opus-5.5')).toBe(
      'claude-opus-5-5',
    )
    expect(toAnthropicModelId('anthropic/claude-sonnet-5')).toBe(
      'claude-sonnet-5',
    )
    expect(toAnthropicModelId('anthropic/claude-fable-5.1')).toBe(
      'claude-fable-5-1',
    )
  })

  // `claude-opus-5.5` reached Anthropic's count endpoint and 404'd on every
  // Opus 5.5 turn: an unmapped id must not keep OpenRouter's dots.
  test('an unmapped version is spelled with hyphens', () => {
    expect(toAnthropicModelId('anthropic/claude-opus-6.1')).toBe(
      'claude-opus-6-1',
    )
    expect(toAnthropicModelId('anthropic/claude-haiku-5')).toBe(
      'claude-haiku-5',
    )
  })

  test('passes a bare Anthropic id through and rejects other providers', () => {
    expect(toAnthropicModelId('claude-opus-4-6')).toBe('claude-opus-4-6')
    expect(() => toAnthropicModelId('openai/gpt-5.5')).toThrow()
  })
})
