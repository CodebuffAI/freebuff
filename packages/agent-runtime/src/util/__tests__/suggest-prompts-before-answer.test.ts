import { assistantMessage, userMessage } from '@codebuff/common/util/messages'
import { describe, expect, it } from 'bun:test'

import { MAX_FOLLOWUP_SUGGESTION_CALLS_PER_RESPONSE } from '../../tools/stream-parser'
import { endsOnSuggestPromptsBeforeAnswer } from '../suggest-prompts-before-answer'

const prompt = () => userMessage({ content: 'Plan it', tags: ['USER_PROMPT'] })
const card = (id: string) =>
  assistantMessage({
    type: 'tool-call',
    toolCallId: id,
    toolName: 'suggest_prompts',
    input: { prompts: [] },
  })
const followupCard = (id: string) =>
  assistantMessage({
    type: 'tool-call',
    toolCallId: id,
    toolName: 'suggest_followups',
    input: { followups: [] },
  })
const cards = (n: number) =>
  Array.from({ length: n }, () => ({ toolName: 'suggest_prompts' }))
const leadIn = "Here's the plan."

describe('endsOnSuggestPromptsBeforeAnswer', () => {
  it('continues a step of cards with only a lead-in, however many cards', () => {
    expect(
      endsOnSuggestPromptsBeforeAnswer(cards(1), leadIn, [prompt(), card('a')]),
    ).toBe(true)
    expect(
      endsOnSuggestPromptsBeforeAnswer(cards(2), leadIn, [
        prompt(),
        card('a'),
        card('b'),
      ]),
    ).toBe(true)
  })

  it('ends on cards beside a real answer', () => {
    expect(
      endsOnSuggestPromptsBeforeAnswer(cards(1), 'x'.repeat(300), [
        prompt(),
        card('a'),
      ]),
    ).toBe(false)
  })

  it('ends when the step called anything besides suggest_prompts', () => {
    expect(
      endsOnSuggestPromptsBeforeAnswer(
        [...cards(1), { toolName: 'render_ui' }],
        leadIn,
        [prompt(), card('a')],
      ),
    ).toBe(false)
  })

  it('ends a runaway at the suggestion cap', () => {
    const n = MAX_FOLLOWUP_SUGGESTION_CALLS_PER_RESPONSE
    const history = [prompt(), ...cards(n).map((_, i) => card(`c${i}`))]
    expect(endsOnSuggestPromptsBeforeAnswer(cards(n), leadIn, history)).toBe(
      false,
    )
  })

  it('continues once per prompt', () => {
    expect(
      endsOnSuggestPromptsBeforeAnswer(cards(1), leadIn, [
        prompt(),
        card('earlier'),
        card('now'),
      ]),
    ).toBe(false)
    expect(
      endsOnSuggestPromptsBeforeAnswer(cards(1), leadIn, [
        card('earlier'),
        prompt(),
        card('now'),
      ]),
    ).toBe(true)
  })

  it("treats the CLI's suggest_followups like suggest_prompts", () => {
    const followups = [{ toolName: 'suggest_followups' }]
    expect(
      endsOnSuggestPromptsBeforeAnswer(followups, '', [
        prompt(),
        followupCard('a'),
      ]),
    ).toBe(true)
    expect(
      endsOnSuggestPromptsBeforeAnswer(followups, 'x'.repeat(300), [
        prompt(),
        followupCard('a'),
      ]),
    ).toBe(false)
    // Either tool counts toward once per prompt.
    expect(
      endsOnSuggestPromptsBeforeAnswer(followups, leadIn, [
        prompt(),
        card('earlier'),
        followupCard('now'),
      ]),
    ).toBe(false)
  })
})
