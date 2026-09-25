import { afterEach, describe, expect, test } from 'bun:test'

import { useChatStore } from '../chat-store'

import type { RunState } from '@codebuff/sdk'

const SESSION = '11111111-2222-4333-8444-555555555555'
const COMPLETED_RUN = '66666666-7777-4888-9999-aaaaaaaaaaaa'
const INTERRUPTED_RUN = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'

const stateWithRun = (runId: string | undefined): RunState =>
  ({
    traceSessionId: SESSION,
    sessionState: { mainAgentState: { runId } },
    output: { type: 'lastMessage', value: [] },
  }) as unknown as RunState

afterEach(() => useChatStore.getState().reset())

describe('chat store ad trace pointer', () => {
  test('follows the adopted run state', () => {
    useChatStore.getState().setRunState(stateWithRun(COMPLETED_RUN))
    expect(useChatStore.getState().adTraceContext).toEqual({
      traceSessionId: SESSION,
      previousRunId: COMPLETED_RUN,
    })
    useChatStore.getState().setRunState(null)
    expect(useChatStore.getState().adTraceContext).toBeNull()
  })

  test('moves past an interrupted run the run state never adopted', () => {
    const store = useChatStore.getState()
    store.setRunState(stateWithRun(COMPLETED_RUN))
    // Esc: the run is not adopted, but the server created its root run, so
    // the next prompt's run comes after it, not after the completed one.
    store.noteFinishedRunForAdTrace(stateWithRun(INTERRUPTED_RUN))
    expect(useChatStore.getState().runState).toEqual(
      stateWithRun(COMPLETED_RUN),
    )
    expect(useChatStore.getState().adTraceContext).toEqual({
      traceSessionId: SESSION,
      previousRunId: INTERRUPTED_RUN,
    })
  })

  test('an interrupted state with no usable trace keeps the pointer it had', () => {
    const store = useChatStore.getState()
    store.setRunState(stateWithRun(COMPLETED_RUN))
    store.noteFinishedRunForAdTrace({
      traceSessionId: 'not-a-uuid',
    } as unknown as RunState)
    expect(useChatStore.getState().adTraceContext?.previousRunId).toBe(
      COMPLETED_RUN,
    )
  })

  test('a new chat forgets the pointer', () => {
    useChatStore.getState().setRunState(stateWithRun(COMPLETED_RUN))
    useChatStore.getState().reset()
    expect(useChatStore.getState().adTraceContext).toBeNull()
  })
})
