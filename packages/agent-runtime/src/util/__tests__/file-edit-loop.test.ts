import { assistantMessage, userMessage } from '@codebuff/common/util/messages'
import { describe, expect, it } from 'bun:test'

import {
  FILE_EDIT_LOOP_RECOVERY_TAG,
  FILE_EDIT_LOOP_STOP_THRESHOLD,
  FILE_EDIT_LOOP_VARIED_STOP_THRESHOLD,
  trailingIdenticalRejectedEdits,
  trailingRejectedEditsToSameFiles,
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

  // The review-mode twin of str_replace: its handler builds the same
  // `{ file, errorMessage }` itself, so an identical failing proposal is the
  // same loop and must count the same.
  it('counts a propose_str_replace streak', () => {
    const propose = (id: string) =>
      edit(
        id,
        { path: 'a.ts', replacements: [{ old: 'q', new: 'r' }] },
        { file: 'a.ts', errorMessage: 'old string not found' },
        'propose_str_replace',
      )
    expect(
      trailingIdenticalRejectedEdits([
        ...propose('a'),
        ...propose('b'),
        ...propose('c'),
      ]),
    ).toBe(3)
  })

  // Pins the list against being "completed" from
  // `truncated-write-guard.ts`'s `FILE_MUTATING_TOOL_NAMES`: these two mutate
  // files but never answer with `errorMessage`, so in production this shape
  // cannot occur for them and counting them would only widen the guard's
  // precondition. The fixture supplies the shape anyway, so what is asserted
  // is the list membership itself.
  it.each(['apply_patch', 'propose_write_file'])(
    'leaves %s out of the loop tools',
    (toolName) => {
      expect(
        trailingIdenticalRejectedEdits([
          ...edit('a', { path: 'a.ts', content: 'x' }, undefined, toolName),
          ...edit('b', { path: 'a.ts', content: 'x' }, undefined, toolName),
        ]),
      ).toBe(0)
    },
  )

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

// The measurement counter. It must never change what stops a turn, so every
// case here is checked against the strict counter too: the point of each is a
// loop the strict counter scores below its threshold.
describe('trailingRejectedEditsToSameFiles', () => {
  const vary = (id: string, old: string) =>
    edit(
      id,
      { path: 'a.ts', replacements: [{ old, new: 'r' }] },
      { file: 'a.ts', errorMessage: 'old string not found' },
      'str_replace',
    )

  it('counts a same-file loop whose edit arguments vary each attempt', () => {
    const messages = [
      userMessage('Fix it'),
      ...vary('a', 'q'),
      ...vary('b', 'q '),
      ...vary('c', ' q'),
    ]
    // Hole #1: `editKey` is byte-exact, so the guard sees one attempt.
    expect(trailingIdenticalRejectedEdits(messages)).toBe(1)
    expect(trailingRejectedEditsToSameFiles(messages)).toEqual({
      consecutive: 3,
      varied: true,
      interleaved: false,
      mixedStep: false,
      toolName: 'str_replace',
    })
  })

  it('counts across a read between two attempts', () => {
    const messages = [
      ...edit('a'),
      ...edit('r', { paths: ['a.ts'] }, {}, 'read_files'),
      ...edit('b'),
    ]
    // Hole #2: one interleaved non-edit tool resets the guard.
    expect(trailingIdenticalRejectedEdits(messages)).toBe(1)
    expect(trailingRejectedEditsToSameFiles(messages)).toMatchObject({
      consecutive: 2,
      interleaved: true,
      varied: false,
      mixedStep: false,
    })
  })

  it('counts a step that batched the edit with a read', () => {
    const mixed = (id: string) => [
      assistantMessage([
        call(id),
        call(`${id}r`, { paths: ['a.ts'] }, 'read_files'),
      ]),
      result(id),
      result(`${id}r`, {}, 'read_files'),
    ]
    const messages = [...mixed('a'), ...mixed('b'), ...mixed('c')]
    // Hole #3: the guard's precondition excludes a mixed step, and the
    // counter breaks on one anyway.
    expect(trailingIdenticalRejectedEdits(messages)).toBe(0)
    expect(trailingRejectedEditsToSameFiles(messages)).toMatchObject({
      consecutive: 3,
      mixedStep: true,
    })
  })

  it('agrees with the guard on a plain identical streak', () => {
    const messages = [...edit('a'), ...edit('b'), ...edit('c')]
    expect(trailingIdenticalRejectedEdits(messages)).toBe(3)
    expect(trailingRejectedEditsToSameFiles(messages)).toMatchObject({
      consecutive: 3,
      varied: false,
      interleaved: false,
      mixedStep: false,
    })
  })

  it('stops counting at the guard stop threshold, or at the limit it is given', () => {
    const messages = Array.from({ length: 20 }, (_, i) => edit(`e${i}`)).flat()
    expect(trailingRejectedEditsToSameFiles(messages)?.consecutive).toBe(
      FILE_EDIT_LOOP_STOP_THRESHOLD,
    )
    expect(
      trailingRejectedEditsToSameFiles(
        messages,
        FILE_EDIT_LOOP_VARIED_STOP_THRESHOLD,
      )?.consecutive,
    ).toBe(FILE_EDIT_LOOP_VARIED_STOP_THRESHOLD)
  })

  it.each([
    ['user steering', [userMessage('Do something else')]],
    ['an accepted edit', edit('ok', undefined, ACCEPTED)],
    ['a different file', edit('other', { path: 'b.ts', content: 'x' })],
  ] satisfies [string, Message[]][])('still ends at %s', (_, boundary) => {
    expect(
      trailingRejectedEditsToSameFiles([
        ...edit('old1'),
        ...edit('old2'),
        ...boundary,
        ...edit('new'),
      ])?.consecutive,
    ).toBe(1)
  })

  it('gives up on a long stretch of other work between two failed edits', () => {
    const reads = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        edit(`r${i}`, { paths: ['a.ts'] }, {}, 'read_files'),
      ).flat()
    expect(
      trailingRejectedEditsToSameFiles([
        ...edit('a'),
        ...reads(2),
        ...edit('b'),
      ])?.consecutive,
    ).toBe(2)
    expect(
      trailingRejectedEditsToSameFiles([
        ...edit('a'),
        ...reads(3),
        ...edit('b'),
      ])?.consecutive,
    ).toBe(1)
  })

  it('is null when the turn is not sitting on a rejected edit', () => {
    expect(
      trailingRejectedEditsToSameFiles([
        ...edit('a'),
        ...edit('r', { paths: ['a.ts'] }, {}, 'read_files'),
      ]),
    ).toBeNull()
    expect(trailingRejectedEditsToSameFiles([userMessage('hi')])).toBeNull()
  })
})
