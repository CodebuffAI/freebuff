import { describe, expect, test } from 'bun:test'

import { anchorOf, applyRewind, lastUserMessageIndex } from '../undo-rewind'

import type { ChatMessage } from '../../types/chat'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { RunState } from '@codebuff/sdk'

const message = (variant: 'user' | 'ai', content = 'x'): ChatMessage =>
  ({
    id: `${variant}-${content}`,
    variant,
    content,
    timestamp: '2026-01-01T00:00:00.000Z',
  }) as ChatMessage

/** A message-shaped stand-in: only its identity matters to these helpers. */
const fakeMessage = (id: string): Message => ({ id }) as unknown as Message

/** Only the part of a run state these helpers read is real. */
const runStateWithHistory = (ids: string[]): RunState =>
  ({
    output: { type: 'allMessages', value: ids },
    traceSessionId: 'trace-1',
    sessionState: {
      mainAgentState: { messageHistory: ids.map(fakeMessage) },
    },
  }) as unknown as RunState

describe('lastUserMessageIndex', () => {
  test('finds the prompt a turn started from, not the newest ai reply', () => {
    const messages = [
      message('user', 'one'),
      message('ai', 'reply'),
      message('user', 'two'),
      message('ai', 'reply'),
      message('ai', 'still streaming'),
    ]
    expect(lastUserMessageIndex(messages)).toBe(2)
  })

  test('is -1 when the transcript holds no prompt yet', () => {
    expect(lastUserMessageIndex([])).toBe(-1)
    expect(lastUserMessageIndex([message('ai', 'hello')])).toBe(-1)
  })
})

describe('anchorOf', () => {
  test('reads an anchor a record carries', () => {
    expect(anchorOf({ anchor: { historyLength: 4, transcriptIndex: 2 } })).toEqual(
      { historyLength: 4, transcriptIndex: 2 },
    )
  })

  test('an entry recorded before the anchor existed has none', () => {
    expect(anchorOf({})).toBeNull()
  })

  test('refuses a nonsense anchor instead of cutting at a guess', () => {
    expect(anchorOf({ anchor: { historyLength: -1, transcriptIndex: 0 } })).toBeNull()
    expect(anchorOf({ anchor: { historyLength: 1.5, transcriptIndex: 0 } })).toBeNull()
    expect(anchorOf({ anchor: { historyLength: 3, transcriptIndex: -2 } })).toBeNull()
    expect(
      anchorOf({
        anchor: { historyLength: 3, transcriptIndex: Number.NaN },
      }),
    ).toBeNull()
  })
})

describe('applyRewind', () => {
  const original = runStateWithHistory(['m1', 'm2', 'm3', 'm4'])

  test('cuts the model history back to where the turn started', () => {
    const rewound = applyRewind(original, 2)
    expect(rewound?.sessionState?.mainAgentState.messageHistory).toEqual([
      fakeMessage('m1'),
      fakeMessage('m2'),
    ])
  })

  test('leaves the caller the full history it still persists', () => {
    // The full state lives in a ref and is written to disk; a cut that mutated
    // it would make /redo impossible even though nothing was ever deleted.
    applyRewind(original, 1)
    expect(original.sessionState?.mainAgentState.messageHistory).toHaveLength(4)
  })

  test('is a no-op, same reference, when there is nothing to cut', () => {
    expect(applyRewind(original, null)).toBe(original)
    expect(applyRewind(original, 4)).toBe(original)
    expect(applyRewind(original, 9)).toBe(original)
    expect(applyRewind(null, 2)).toBeNull()
  })

  test('an unstarted chat cuts to an empty history rather than throwing', () => {
    // historyLength 0 is the first turn of a chat: everything the model had is
    // that turn, so the cut leaves it with nothing to remember.
    expect(
      applyRewind(original, 0)?.sessionState?.mainAgentState.messageHistory,
    ).toEqual([])
  })

  test('leaves a state with no history alone', () => {
    const bare = { output: { type: 'allMessages', value: [] } } as unknown as RunState
    expect(applyRewind(bare, 0)).toBe(bare)
  })
})
