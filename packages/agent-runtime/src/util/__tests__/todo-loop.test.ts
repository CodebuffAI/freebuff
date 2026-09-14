import { assistantMessage, userMessage } from '@codebuff/common/util/messages'
import { describe, expect, it } from 'bun:test'

import {
  TODO_LOOP_RECOVERY_TAG,
  trailingIdenticalTodoCalls,
} from '../todo-loop'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

function exchange(
  id: string,
  todos: unknown = [{ task: 'x', completed: false }],
  toolName = 'write_todos',
): Message[] {
  return [
    assistantMessage({
      type: 'tool-call',
      toolCallId: id,
      toolName,
      input: { todos },
    }),
    { role: 'tool', toolCallId: id, toolName, content: [] },
  ]
}

describe('trailingIdenticalTodoCalls', () => {
  it('counts completed calls across reasoning, prose, step prompts and recovery notes', () => {
    expect(
      trailingIdenticalTodoCalls([
        userMessage('Implement the plan'),
        ...exchange('a'),
        assistantMessage({
          type: 'reasoning',
          text: 'I should stop repeating.',
        }),
        userMessage({ content: 'Continue', tags: ['STEP_PROMPT'] }),
        ...exchange('b', [{ completed: false, task: 'x' }]),
        userMessage({
          content: 'Stop repeating',
          tags: [TODO_LOOP_RECOVERY_TAG],
        }),
        assistantMessage('Executing now.'),
        ...exchange('c'),
      ]),
    ).toBe(3)
  })

  it('counts batched calls with results grouped after the assistant message', () => {
    const [call1, result1] = exchange('a')
    const [call2, result2] = exchange('b')
    expect(
      trailingIdenticalTodoCalls([call1!, call2!, result1!, result2!]),
    ).toBe(2)
  })

  it.each([
    ['user steering', [userMessage('Do something else')]],
    ['another tool', exchange('read', [], 'read_files')],
    [
      'a different task',
      exchange('different', [{ task: 'y', completed: false }]),
    ],
    ['a completion update', exchange('done', [{ task: 'x', completed: true }])],
    ['a malformed historical list', exchange('bad', [null])],
    ['an unmatched call', exchange('orphan').slice(0, 1)],
  ] satisfies [string, Message[]][])('resets at %s', (_, boundary) => {
    expect(
      trailingIdenticalTodoCalls([
        ...exchange('old1'),
        ...exchange('old2'),
        ...boundary,
        ...exchange('new'),
      ]),
    ).toBe(1)
  })
})
