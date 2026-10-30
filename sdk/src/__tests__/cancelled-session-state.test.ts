import { countTokensMessages } from '@codebuff/agent-runtime/util/token-counter'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { getStubProjectFileContext } from '@codebuff/common/util/file'
import { describe, expect, test } from 'bun:test'

import { buildCancelledSessionState } from '../run'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { SessionState } from '@codebuff/common/types/session-state'

/**
 * The state a cancelled or errored turn persists is built HERE, after the
 * runtime's own end-of-turn recount has already run. This function then drops
 * unanswered tool calls and appends one or two more messages — so whatever it
 * does to the history, it owes the count the same edit. Otherwise the number
 * the composer draws describes a history the thread does not have.
 *
 * The count covers history + system prompt + tool schemas, and only the first
 * of those is in scope here, which is why every assertion below is written as
 * "the count still equals this history plus the same constant".
 */

/** Tokens the system prompt and tool schemas contribute — untouchable from
 *  here, and therefore the part that must survive every edit unchanged. */
const SYSTEM_AND_TOOLS = 9_000

const text = (role: 'user' | 'assistant', body: string) =>
  ({ role, content: [{ type: 'text', text: body }] }) as unknown as Message

const toolCall = (toolCallId: string) =>
  ({
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId,
        toolName: 'read_files',
        input: { paths: ['a.ts', 'b.ts', 'c.ts'] },
      },
    ],
  }) as unknown as Message

function sessionStateWith(messageHistory: Message[]): SessionState {
  const state = getInitialSessionState(getStubProjectFileContext())
  state.mainAgentState.messageHistory = messageHistory
  state.mainAgentState.contextTokenCount =
    countTokensMessages(messageHistory) + SYSTEM_AND_TOOLS
  return state
}

describe('buildCancelledSessionState', () => {
  test('the count describes the history it persists', () => {
    // The turn ended, the runtime recounted, and THEN this appended the
    // cancellation message. Leaving the count alone persists a number that is
    // short by exactly the messages the user will resume from.
    const history = [
      text('user', 'refactor the run loop'.repeat(40)),
      text('assistant', 'done'.repeat(400)),
    ]
    const state = buildCancelledSessionState({
      sessionState: sessionStateWith(history),
      runtimeMadeProgress: true,
      message: 'Run cancelled by user.',
    })

    expect(state.mainAgentState.messageHistory.length).toBe(history.length + 1)
    expect(state.mainAgentState.contextTokenCount).toBe(
      countTokensMessages(state.mainAgentState.messageHistory) +
        SYSTEM_AND_TOOLS,
    )
  })

  test('the count follows the user prompt that gets restored', () => {
    // Nothing ran, so the prompt is added back here rather than by the runtime
    // — two appends past the last recount instead of one.
    const history = [text('assistant', 'earlier turn'.repeat(200))]
    const prompt = text('user', 'refactor the run loop'.repeat(40))
    const state = buildCancelledSessionState({
      sessionState: sessionStateWith(history),
      runtimeMadeProgress: false,
      promptMessage: prompt,
      message: 'Run cancelled by user.',
    })

    expect(state.mainAgentState.messageHistory.length).toBe(history.length + 2)
    expect(state.mainAgentState.contextTokenCount).toBe(
      countTokensMessages(state.mainAgentState.messageHistory) +
        SYSTEM_AND_TOOLS,
    )
  })

  test('the count follows a dropped half-step', () => {
    // dropUnansweredToolCalls removes an assistant tool call whose result never
    // arrived — the one edit here that makes the history SMALLER, and on a
    // multi-file read a large one.
    const history = [
      text('user', 'read the runner'.repeat(40)),
      toolCall('call-1'),
    ]
    const state = buildCancelledSessionState({
      sessionState: sessionStateWith(history),
      runtimeMadeProgress: true,
      message: 'Run cancelled by user.',
    })

    const persisted = state.mainAgentState.messageHistory
    expect(persisted.some((m) => m.role === 'assistant')).toBe(false)
    expect(state.mainAgentState.contextTokenCount).toBe(
      countTokensMessages(persisted) + SYSTEM_AND_TOOLS,
    )
  })

  test('does not disturb the live session', () => {
    // Same contract cloneSessionState exists for: the run is still unwinding
    // and the caller keeps using the original.
    const history = [text('user', 'hello')]
    const live = sessionStateWith(history)
    const before = live.mainAgentState.contextTokenCount
    buildCancelledSessionState({
      sessionState: live,
      runtimeMadeProgress: true,
      message: 'Run cancelled by user.',
    })
    expect(live.mainAgentState.messageHistory.length).toBe(1)
    expect(live.mainAgentState.contextTokenCount).toBe(before)
  })
})
