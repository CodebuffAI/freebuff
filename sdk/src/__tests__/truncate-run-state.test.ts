import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { getStubProjectFileContext } from '@codebuff/common/util/file'
import { describe, expect, test } from 'bun:test'

import { truncateRunStateAtUserTurn } from '../compact-run-state'

import type { RunState } from '../run-state'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'

const user = (text: string): Message => ({
  role: 'user',
  tags: ['USER_PROMPT'],
  content: [{ type: 'text', text }],
})
const assistant = (text: string): Message => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  sentAt: Date.now(),
})

function runStateWith(messageHistory: Message[]): RunState {
  const sessionState = getInitialSessionState(getStubProjectFileContext())
  sessionState.mainAgentState.messageHistory = messageHistory
  return { sessionState } as RunState
}

const texts = (state: RunState | null) =>
  (state?.sessionState?.mainAgentState?.messageHistory ?? []).map((m) =>
    m.content
      .map((p) => ('text' in p ? p.text : ''))
      .join('')
      .trim(),
  )

/** Three user turns, each answered. Editing the Nth must keep the first N. */
const threeTurns = () => [
  user('one'),
  assistant('answered one'),
  user('two'),
  assistant('answered two'),
  user('three'),
  assistant('answered three'),
]

describe('truncateRunStateAtUserTurn', () => {
  test('editing the second message keeps the first turn and its answer', () => {
    // The bug this exists for: Desktop cleared the whole state here, so the
    // user kept seeing turn one on screen while the model had never seen it.
    const next = truncateRunStateAtUserTurn({
      runState: runStateWith(threeTurns()),
      keepUserTurns: 1,
    })
    expect(texts(next)).toEqual(['one', 'answered one'])
  })

  test('editing the third keeps both earlier turns', () => {
    const next = truncateRunStateAtUserTurn({
      runState: runStateWith(threeTurns()),
      keepUserTurns: 2,
    })
    expect(texts(next)).toEqual(['one', 'answered one', 'two', 'answered two'])
  })

  test('never leaves a message the edit removed', () => {
    const next = truncateRunStateAtUserTurn({
      runState: runStateWith(threeTurns()),
      keepUserTurns: 1,
    })
    // Remembering deleted turns is the opposite failure and is worse than
    // forgetting: the model would act on text the user cannot see.
    expect(texts(next)).not.toContain('two')
    expect(texts(next)).not.toContain('three')
  })

  test('editing the first message answers null, which means clear', () => {
    // Nothing survives, so there is no truncated state to write; the caller
    // clears, which is what it already did.
    expect(
      truncateRunStateAtUserTurn({
        runState: runStateWith(threeTurns()),
        keepUserTurns: 0,
      }),
    ).toBeNull()
  })

  test('answers null rather than guessing when the history is short', () => {
    // The host's user rows and this history are two representations that a
    // host may have desynchronised. Fall back to clearing instead of cutting
    // at the wrong place — a state that disagrees with the transcript is worse
    // than amnesia.
    expect(
      truncateRunStateAtUserTurn({
        runState: runStateWith([user('one'), assistant('answered one')]),
        keepUserTurns: 3,
      }),
    ).toBeNull()
  })

  test('leaves the original state untouched', () => {
    const original = threeTurns()
    const state = runStateWith(original)
    truncateRunStateAtUserTurn({ runState: state, keepUserTurns: 1 })
    expect(state.sessionState?.mainAgentState?.messageHistory).toHaveLength(6)
    expect(original).toHaveLength(6)
  })

  test('tolerates empty and missing history', () => {
    expect(
      truncateRunStateAtUserTurn({
        runState: runStateWith([]),
        keepUserTurns: 1,
      }),
    ).toBeNull()
    expect(
      truncateRunStateAtUserTurn({
        runState: {} as RunState,
        keepUserTurns: 1,
      }),
    ).toBeNull()
  })
})
