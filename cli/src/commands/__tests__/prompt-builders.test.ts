import { describe, expect, test } from 'bun:test'

import {
  buildBtwPrompt,
  buildPlanPrompt,
  buildReviewPrompt,
  buildReviewPromptFromArgs,
} from '../prompt-builders'

describe('prompt-builders base prompts', () => {
  test('/btw keeps the note and removes command whitespace', () => {
    expect(buildBtwPrompt('  remember to run tests  ')).toBe(
      'The user has an additional thought for the current task. Consider it without abandoning the original request:\n\nremember to run tests',
    )
  })

  // These used to branch on whether the user had connected a ChatGPT account,
  // delegating the deep-thinking step to @thinker-gpt if so. That integration
  // is gone, so there is one branch: the user's selected model does the work.
  test('/plan runs on the selected model', () => {
    const prompt = buildPlanPrompt('add OAuth login')
    expect(prompt).not.toContain('@thinker-gpt')
    expect(prompt).toContain('think carefully about how to implement')
    expect(prompt).toContain('add OAuth login')
  })

  test('/review runs on the selected model', () => {
    expect(buildReviewPrompt('uncommitted')).not.toContain('@thinker-gpt')
    expect(buildReviewPrompt('uncommitted')).toContain('carefully review')
    expect(buildReviewPromptFromArgs('the parser')).not.toContain(
      '@thinker-gpt',
    )
    expect(buildReviewPromptFromArgs('the parser')).toContain('the parser')
  })
})
