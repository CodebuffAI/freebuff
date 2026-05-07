import { describe, expect, test } from 'bun:test'

import { FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID } from '@codebuff/common/constants/freebuff-models'

import { createBase2 } from '../base2/base2'

describe('base2 free reviewer selection', () => {
  test('uses the DeepSeek reviewer when free mode uses DeepSeek V4 Pro', () => {
    const base2 = createBase2('free', {
      model: FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
    })

    expect(base2.spawnableAgents).toContain('code-reviewer-deepseek')
    expect(base2.spawnableAgents).not.toContain('code-reviewer-lite')
    expect(base2.instructionsPrompt).toContain('code-reviewer-deepseek')
    expect(base2.stepPrompt).toContain('code-reviewer-deepseek')
  })

  test('keeps the lite reviewer for other free-mode models', () => {
    const base2 = createBase2('free', {
      model: 'moonshotai/kimi-k2.6',
    })

    expect(base2.spawnableAgents).toContain('code-reviewer-lite')
    expect(base2.spawnableAgents).not.toContain('code-reviewer-deepseek')
    expect(base2.instructionsPrompt).toContain('code-reviewer-lite')
    expect(base2.stepPrompt).toContain('code-reviewer-lite')
  })
})
