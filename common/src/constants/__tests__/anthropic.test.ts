import { describe, expect, test } from 'bun:test'

import { toAnthropicModelId } from '../anthropic'

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
