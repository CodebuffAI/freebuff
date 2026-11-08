import { describe, expect, it } from 'bun:test'

import {
  STATE_SNAPSHOT_INTERRUPTION_MESSAGE,
  toUserInterruptedRunState,
} from '../run'
import { USER_INTERRUPTED_MESSAGE } from '@codebuff/agent-runtime/util/messages'

import type { RunState } from '../run-state'

const text = (role: 'user' | 'assistant', value: string) => ({
  role,
  content: [{ type: 'text', text: value }],
})
const system = (value: string) => text('user', `<system>${value}</system>`)

const stateWith = (
  history: unknown[],
  output: RunState['output'],
): RunState =>
  ({
    traceSessionId: 'trace',
    sessionState: { mainAgentState: { messageHistory: history } },
    output,
  }) as unknown as RunState

const texts = (state: RunState | undefined) =>
  state!.sessionState!.mainAgentState.messageHistory.map(
    (message: any) => message.content[0].text,
  )

describe('toUserInterruptedRunState', () => {
  it('swaps a snapshot\'s "session ended" message for the user-interrupted one', () => {
    const snapshot = stateWith(
      [
        text('user', 'fix it'),
        text('assistant', 'On it.'),
        system(STATE_SNAPSHOT_INTERRUPTION_MESSAGE),
      ],
      { type: 'error', message: STATE_SNAPSHOT_INTERRUPTION_MESSAGE },
    )
    const result = toUserInterruptedRunState(snapshot)
    expect(texts(result)).toEqual([
      'fix it',
      'On it.',
      `<system>${USER_INTERRUPTED_MESSAGE}</system>`,
    ])
    expect(result!.output).toEqual({
      type: 'error',
      message: USER_INTERRUPTED_MESSAGE,
    })
    // The snapshot itself is untouched: the host may still hold it.
    expect(texts(snapshot)).toHaveLength(3)
  })

  it('swaps an early "Run cancelled by user." and keeps the prompt', () => {
    const result = toUserInterruptedRunState(
      stateWith([text('user', 'fix it'), system('Run cancelled by user.')], {
        type: 'error',
        message: 'Run cancelled by user.',
      }),
    )
    expect(texts(result)).toEqual([
      'fix it',
      `<system>${USER_INTERRUPTED_MESSAGE}</system>`,
    ])
  })

  it('returns the runtime\'s own abort state as-is', () => {
    const own = stateWith(
      [text('user', 'fix it'), system(USER_INTERRUPTED_MESSAGE)],
      { type: 'error', message: 'Run cancelled by user' },
    )
    expect(toUserInterruptedRunState(own)).toBe(own)
  })

  it('does not add the interrupted message twice', () => {
    const result = toUserInterruptedRunState(
      stateWith(
        [
          text('user', 'fix it'),
          system(USER_INTERRUPTED_MESSAGE),
          system('Aborted'),
        ],
        { type: 'error', message: 'Aborted' },
      ),
    )
    expect(texts(result)).toEqual([
      'fix it',
      `<system>${USER_INTERRUPTED_MESSAGE}</system>`,
    ])
  })

  it('leaves a state that does not end in an SDK cancellation message alone', () => {
    const completed = stateWith(
      [text('user', 'fix it'), text('assistant', 'Done.')],
      { type: 'lastMessage', value: [] },
    )
    expect(toUserInterruptedRunState(completed)).toBe(completed)
  })

  it('returns undefined without a session state', () => {
    expect(
      toUserInterruptedRunState({
        traceSessionId: 'trace',
        output: { type: 'error', message: 'Aborted' },
      } as RunState),
    ).toBeUndefined()
  })
})
