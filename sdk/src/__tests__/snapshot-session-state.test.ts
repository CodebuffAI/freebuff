import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { getStubProjectFileContext } from '@codebuff/common/util/file'
import { describe, expect, it } from 'bun:test'

import { snapshotSessionState } from '../run'

import type { SessionState } from '@codebuff/common/types/session-state'

const text = (role: 'user' | 'assistant', body: string) =>
  ({ role, content: [{ type: 'text', text: body }] }) as any

function makeSession(): SessionState {
  const state = getInitialSessionState(getStubProjectFileContext())
  state.mainAgentState.messageHistory = [
    text('user', 'hello'),
    text('assistant', 'world'),
  ]
  state.mainAgentState.agentContext = {
    goal: { objective: 'ship it', logs: ['started'] },
  }
  return state
}

describe('snapshotSessionState', () => {
  it('copies the containers a run mutates, so a snapshot stays put', () => {
    const live = makeSession()
    const snapshot = snapshotSessionState(live)

    // The mutations the run actually makes: push a message, replace the array,
    // append a subgoal log, record a spawned child.
    snapshot.mainAgentState.messageHistory.push(text('user', 'interrupted'))
    live.mainAgentState.messageHistory.push(text('assistant', 'more'))
    ;(snapshot.mainAgentState.agentContext.goal.logs as string[]).push('note')
    live.mainAgentState.childRunIds.push('child-run')

    expect(snapshot.mainAgentState.messageHistory).toHaveLength(3)
    expect(live.mainAgentState.messageHistory).toHaveLength(3)
    expect(live.mainAgentState.agentContext.goal.logs).toEqual(['started'])
    expect(snapshot.mainAgentState).not.toBe(live.mainAgentState)
    expect(snapshot.mainAgentState.messageHistory).not.toBe(
      live.mainAgentState.messageHistory,
    )
    // A spawn after the snapshot must not appear in the snapshot the host is
    // still about to serialize.
    expect(snapshot.mainAgentState.childRunIds).toEqual([])
  })

  it('shares message objects, which is what makes the delta cheap to find', () => {
    const live = makeSession()
    const first = snapshotSessionState(live)
    // The runtime appends a new message and replaces the array, as it does at a
    // step boundary.
    live.mainAgentState.messageHistory = [
      ...live.mainAgentState.messageHistory,
      text('assistant', 'step'),
    ]
    const second = snapshotSessionState(live)

    // A host can walk the two histories and find the append by identity,
    // instead of serializing both to compare them.
    expect(second.mainAgentState.messageHistory[0]).toBe(
      first.mainAgentState.messageHistory[0],
    )
    expect(second.mainAgentState.messageHistory[1]).toBe(
      first.mainAgentState.messageHistory[1],
    )
    expect(
      second.mainAgentState.messageHistory[first.mainAgentState.messageHistory.length],
    ).not.toBe(undefined)
  })

  it('copies subagent containers at every level', () => {
    const live = makeSession()
    const child = {
      ...getInitialSessionState(getStubProjectFileContext()).mainAgentState,
      agentId: 'child',
      messageHistory: [text('assistant', 'sub work')],
    }
    live.mainAgentState.subagents = [child]

    const snapshot = snapshotSessionState(live)

    expect(snapshot.mainAgentState.subagents[0]).not.toBe(child)
    expect(snapshot.mainAgentState.subagents[0].messageHistory).not.toBe(
      child.messageHistory,
    )
    // Entries are still shared; only the containers are copied.
    expect(snapshot.mainAgentState.subagents[0].messageHistory[0]).toBe(
      child.messageHistory[0],
    )
    snapshot.mainAgentState.subagents[0].messageHistory.push(text('user', 'x'))
    expect(child.messageHistory).toHaveLength(1)
  })

  it('shares fileContext, and does not fail on values JSON cannot clone', () => {
    const live = makeSession()
    ;(live.fileContext as any).customToolDefinitions = {
      mcpTool: { inputSchema: { parse: () => ({}), _def: {} } },
    }

    const snapshot = snapshotSessionState(live)

    expect(snapshot.fileContext).toBe(live.fileContext)
    expect(
      (snapshot.fileContext as any).customToolDefinitions.mcpTool,
    ).toBe((live.fileContext as any).customToolDefinitions.mcpTool)
  })

  it('is a structural copy of the live state, not a stale one', () => {
    const live = makeSession()
    live.mainAgentState.contextTokenCount = 123

    const snapshot = snapshotSessionState(live)

    expect(snapshot.mainAgentState.contextTokenCount).toBe(123)
    expect(snapshot.mainAgentState.stepsRemaining).toBe(
      live.mainAgentState.stepsRemaining,
    )
  })
})
