import { describe, expect, test } from 'bun:test'

import {
  FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
  FREEBUFF_GEMINI_PRO_MODEL_ID,
} from '../constants/freebuff-models'
import { FREEBUFF_GEMINI_THINKER_AGENT_ID } from '../constants/freebuff-gemini-thinker'
import {
  isFreebuffGeminiThinkerAgent,
  isFreeModeAllowedAgentModel,
} from '../constants/free-agents'

describe('free mode agent model allowlist', () => {
  test('allows the browser-use subagent with its bundled model', () => {
    expect(
      isFreeModeAllowedAgentModel(
        'browser-use',
        'google/gemini-3.1-flash-lite-preview',
      ),
    ).toBe(true)
  })

  test('allows Gemini Pro for the thinker subagent but not the freebuff root', () => {
    expect(
      isFreeModeAllowedAgentModel('base2-free', FREEBUFF_GEMINI_PRO_MODEL_ID),
    ).toBe(false)
    expect(
      isFreeModeAllowedAgentModel(
        FREEBUFF_GEMINI_THINKER_AGENT_ID,
        FREEBUFF_GEMINI_PRO_MODEL_ID,
      ),
    ).toBe(true)
  })

  test('recognizes the Gemini thinker agent in free mode', () => {
    expect(isFreebuffGeminiThinkerAgent(FREEBUFF_GEMINI_THINKER_AGENT_ID)).toBe(
      true,
    )
    expect(
      isFreebuffGeminiThinkerAgent(
        `codebuff/${FREEBUFF_GEMINI_THINKER_AGENT_ID}@0.0.1`,
      ),
    ).toBe(true)
    expect(
      isFreebuffGeminiThinkerAgent(
        `other/${FREEBUFF_GEMINI_THINKER_AGENT_ID}@0.0.1`,
      ),
    ).toBe(false)
  })

  test('allows the DeepSeek reviewer only with DeepSeek V4 Pro', () => {
    expect(
      isFreeModeAllowedAgentModel(
        'code-reviewer-deepseek',
        FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
      ),
    ).toBe(true)
    expect(
      isFreeModeAllowedAgentModel(
        'code-reviewer-deepseek',
        FREEBUFF_GEMINI_PRO_MODEL_ID,
      ),
    ).toBe(false)
  })
})
