import { assistantMessage, userMessage } from '@codebuff/common/util/messages'
import { describe, expect, it } from 'bun:test'

import {
  FILE_EDIT_LOOP_RECOVERY_TAG,
  trailingIdenticalRejectedEdits,
} from '../file-edit-loop'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { ToolCallPart } from '@codebuff/common/types/messages/content-part'

const REJECTED = { file: 'a.ts', errorMessage: 'same as the old content' }
const ACCEPTED = { file: 'a.ts', message: 'File written' }

function call(
  id: string,
  input: Record<string, unknown> = { path: 'a.ts', content: 'x' },
  toolName = 'write_file',
): ToolCallPart {
  return { type: 'tool-call', toolCallId: id, toolName, input }
}

function result(
  id: string,
  value: Record<string, string> = REJECTED,
  toolName = 'write_file',
): Message {
  return {
    role: 'tool',
    toolCallId: id,
    toolName,
    content: [{ type: 'json', value }],
  }
}

function edit(
  id: string,
  input?: Record<string, unknown>,
  value: Record<string, string> = REJECTED,
  toolName = 'write_file',
): Message[] {
  return [
    assistantMessage(call(id, input, toolName)),
    result(id, value, toolName),
  ]
}

describe('trailingIdenticalRejectedEdits', () => {
  it('counts rejected identical steps across reasoning, prose, step prompts, recovery notes and instruction wording', () => {
    expect(
      trailingIdenticalRejectedEdits([
        userMessage('Write the file'),
        ...edit('a', { path: 'a.ts', content: 'x', instructions: 'first' }),
        assistantMessage({ type: 'reasoning', text: 'Retrying the write.' }),
        userMessage({ content: 'Continue', tags: ['STEP_PROMPT'] }),
        ...edit('b', { path: 'a.ts', content: 'x', instructions: 'second' }),
        userMessage({
          content: 'Stop repeating',
          tags: [FILE_EDIT_LOOP_RECOVERY_TAG],
        }),
        assistantMessage('Writing now.'),
        ...edit('c'),
      ]),
    ).toBe(3)
  })

  it('compares a whole step of edits, in any order', () => {
    const b = { path: 'b.ts', content: 'y' }
    expect(
      trailingIdenticalRejectedEdits([
        assistantMessage([call('a1'), call('b1', b)]),
        result('a1'),
        result('b1'),
        assistantMessage([call('b2', b), call('a2')]),
        result('b2'),
        result('a2'),
      ]),
    ).toBe(2)
  })

  it('counts a str_replace streak too', () => {
    const replace = (id: string) =>
      edit(
        id,
        { path: 'a.ts', replacements: [{ old: 'q', new: 'r' }] },
        { file: 'a.ts', errorMessage: 'old string not found' },
        'str_replace',
      )
    expect(
      trailingIdenticalRejectedEdits([...replace('a'), ...replace('b')]),
    ).toBe(2)
  })

  it.each([
    ['user steering', [userMessage('Do something else')]],
    ['another tool', edit('read', { paths: ['a.ts'] }, {}, 'read_files')],
    ['an accepted edit', edit('ok', undefined, ACCEPTED)],
    ['a different edit', edit('other', { path: 'a.ts', content: 'z' })],
    ['a different file', edit('other', { path: 'b.ts', content: 'x' })],
    ['an unmatched call', edit('orphan').slice(0, 1)],
  ] satisfies [string, Message[]][])('resets at %s', (_, boundary) => {
    expect(
      trailingIdenticalRejectedEdits([
        ...edit('old1'),
        ...edit('old2'),
        ...boundary,
        ...edit('new'),
      ]),
    ).toBe(1)
  })

  it('does not count a step that mixes an edit with another tool', () => {
    expect(
      trailingIdenticalRejectedEdits([
        ...edit('old'),
        assistantMessage([
          call('a'),
          call('r', { paths: ['a.ts'] }, 'read_files'),
        ]),
        result('a'),
        result('r', {}, 'read_files'),
      ]),
    ).toBe(0)
  })

  it('is zero with no edits', () => {
    expect(trailingIdenticalRejectedEdits([userMessage('hi')])).toBe(0)
  })
})
