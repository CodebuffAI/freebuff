import { describe, expect, test } from 'bun:test'

import {
  FREEBUFF_MODELS,
  FREEBUFF_PAUSED_FREE_MODEL_IDS,
  FREEBUFF_SPACE_BUNNY_ALPHA_MODEL_ID,
  freebuffRetiredModelMessage,
  getFreebuffModelsForAccessTier,
  isFreebuffModelId,
  isFreebuffRetiredModelId,
  SUPPORTED_FREEBUFF_MODELS,
} from '../freebuff-models'

describe('retired free models', () => {
  test('recognised retired ids are retired; every listed model is not', () => {
    for (const id of [
      'minimax/minimax-m3',
      'minimax/minimax-m3-20260211',
      'z-ai/glm-5.2',
      'stealth/ox-alpha',
    ])
      expect(isFreebuffRetiredModelId(id)).toBe(true)
    for (const model of FREEBUFF_MODELS)
      expect(isFreebuffRetiredModelId(model.id)).toBe(false)
    expect(isFreebuffRetiredModelId('some/unknown-model')).toBe(false)
    // Paused but still served through compatibility paths: not retired here.
    expect(isFreebuffRetiredModelId('deepseek/deepseek-v4-pro')).toBe(false)
    expect(isFreebuffRetiredModelId('openai/gpt-5.6-luna')).toBe(false)
    expect(isFreebuffRetiredModelId(null)).toBe(false)
  })

  test('the message names the model and how to update', () => {
    const message = freebuffRetiredModelMessage('minimax/minimax-m3')
    expect(message).toContain('MiniMax M3 is no longer available')
    expect(message).toContain('npm install -g freebuff@latest')
    expect(message).toContain('Freebuff Desktop')
  })
})

test('Space Bunny Alpha is withdrawn: in no picker at any tier, still recognised', () => {
  for (const tier of ['full', 'limited'] as const) {
    expect(
      getFreebuffModelsForAccessTier(tier).map((m) => m.id),
    ).not.toContain(FREEBUFF_SPACE_BUNNY_ALPHA_MODEL_ID)
  }
  expect(FREEBUFF_PAUSED_FREE_MODEL_IDS).toContain(
    FREEBUFF_SPACE_BUNNY_ALPHA_MODEL_ID,
  )
  expect(isFreebuffModelId(FREEBUFF_SPACE_BUNNY_ALPHA_MODEL_ID)).toBe(false)
  expect(
    SUPPORTED_FREEBUFF_MODELS.some(
      (m) => m.id === FREEBUFF_SPACE_BUNNY_ALPHA_MODEL_ID,
    ),
  ).toBe(true)
})
