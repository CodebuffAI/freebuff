import { describe, expect, test } from 'bun:test'

import { convertToAdMessages } from '../ad-request'

import type { Message } from '@codebuff/sdk'

const text = (value: string) => [{ type: 'text' as const, text: value }]

describe('convertToAdMessages source tags (COD-692)', () => {
  test('a messageHistory with STEP_PROMPT and TOOL_CALL_ERROR forwards those tags, so none reads as typed', () => {
    const history = [
      {
        role: 'user',
        content: text('<user_message>add auth</user_message>'),
        tags: ['USER_PROMPT'],
      },
      { role: 'assistant', content: text('On it.') },
      {
        role: 'user',
        content: text('Continue with the next step.'),
        tags: ['STEP_PROMPT'],
      },
      {
        role: 'user',
        content: text('<system>Error during tool call: nope.</system>'),
        tags: ['TOOL_CALL_ERROR', 'SOMETHING_ELSE'],
      },
      {
        role: 'user',
        content: text('instructions'),
        tags: ['INSTRUCTIONS_PROMPT'],
      },
      { role: 'user', content: text('no tags at all') },
    ] as unknown as Message[]

    expect(convertToAdMessages(history)).toEqual([
      {
        role: 'user',
        content: '<user_message>add auth</user_message>',
        tags: ['USER_PROMPT'],
      },
      { role: 'assistant', content: 'On it.' },
      {
        role: 'user',
        content: 'Continue with the next step.',
        tags: ['STEP_PROMPT'],
      },
      {
        role: 'user',
        content: '<system>Error during tool call: nope.</system>',
        tags: ['TOOL_CALL_ERROR'],
      },
      { role: 'user', content: 'no tags at all' },
    ])
  })

  test('assistant messages never carry tags', () => {
    const history = [
      { role: 'assistant', content: text('x'), tags: ['STEP_PROMPT'] },
    ] as unknown as Message[]
    expect(convertToAdMessages(history)).toEqual([
      { role: 'assistant', content: 'x' },
    ])
  })
})
