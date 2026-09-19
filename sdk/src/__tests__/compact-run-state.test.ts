// The host-facing compaction seam: a stored RunState in, a smaller one out.
//
// What matters here is not the summarizer — that is pinned in the runtime's own
// suites — but the boundary around it. A host persists this object and resumes
// from it, so the pass must leave the object it was handed alone, must carry
// forward everything on it that is not history, and must leave behind a
// `contextTokenCount` that describes the history now stored beside it, fixed
// half included. A number that describes a history the thread does not have is
// exactly the bug `adjustContextTokenCountForHistoryEdit` exists to prevent.

import {
  countTokens,
  countTokensJson,
  countTokensMessages,
} from '@codebuff/agent-runtime/util/token-counter'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { getStubProjectFileContext } from '@codebuff/common/util/file'
import { describe, expect, test } from 'bun:test'

import { compactRunState } from '../compact-run-state'

import type { RunState } from '../run-state'
import type { JSONValue } from '@codebuff/common/types/json'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'

const SYSTEM_PROMPT = 'You are a coding agent. '.repeat(200)
const TOOL_DEFINITIONS = {
  read_files: { description: 'Read files', inputSchema: {} },
  run_terminal_command: { description: 'Run a command', inputSchema: {} },
}
const FIXED_TOKENS =
  countTokens(SYSTEM_PROMPT) + countTokensJson(TOOL_DEFINITIONS)

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
const call = (id: string, paths: string[]): Message => ({
  role: 'assistant',
  content: [
    { type: 'tool-call', toolCallId: id, toolName: 'read_files', input: { paths } },
  ],
})
const read = (id: string, content: string, path: string): Message => ({
  role: 'tool',
  toolCallId: id,
  toolName: 'read_files',
  content: [
    { type: 'json', value: [{ path, content, referencedBy: {} }] as JSONValue },
  ],
})

const history = (): Message[] => [
  user('Add a retry to the uploader.'),
  call('a', ['uploader.ts']),
  read('a', 'export const upload = () => {}\n'.repeat(400), 'uploader.ts'),
  assistant('Added the retry.'),
  user('Now document it.'),
  call('b', ['README.md']),
  read('b', '# docs\n'.repeat(400), 'README.md'),
  assistant('Documented.'),
]

function runStateWith(messageHistory: Message[]): RunState {
  const sessionState = getInitialSessionState(getStubProjectFileContext())
  sessionState.mainAgentState.messageHistory = messageHistory
  sessionState.mainAgentState.systemPrompt = SYSTEM_PROMPT
  sessionState.mainAgentState.toolDefinitions = TOOL_DEFINITIONS
  sessionState.mainAgentState.contextTokenCount =
    countTokensMessages(messageHistory) + FIXED_TOKENS
  return {
    sessionState,
    output: { type: 'lastMessage', value: [] },
    traceSessionId: 'trace-1',
    inference: { source: 'codebuff' },
  }
}

const compact = (runState: RunState, maxContextLength = 400_000) =>
  compactRunState({ runState, maxContextLength })

describe('compactRunState', () => {
  test('rewrites the history and recounts the context it now describes', () => {
    const before = runStateWith(history())
    const result = compact(before)!
    expect(result).not.toBeNull()

    const next = result.runState.sessionState!.mainAgentState
    expect(next.messageHistory.length).toBeLessThan(
      before.sessionState!.mainAgentState.messageHistory.length,
    )
    expect(next.contextTokenCount).toBe(
      countTokensMessages(next.messageHistory) + FIXED_TOKENS,
    )
    expect(next.contextTokenCount).toBeLessThan(
      before.sessionState!.mainAgentState.contextTokenCount,
    )
  })

  test('reports both counts on the same basis as the stored one', () => {
    const before = runStateWith(history())
    const result = compact(before)!
    expect(result.previousTokens).toBe(
      before.sessionState!.mainAgentState.contextTokenCount,
    )
    expect(result.nextTokens).toBe(
      result.runState.sessionState!.mainAgentState.contextTokenCount,
    )
    expect(result.nextTokens).toBeLessThan(result.previousTokens)
  })

  test('leaves the run state it was handed untouched', () => {
    const before = runStateWith(history())
    const snapshot = JSON.stringify(before)
    compact(before)
    expect(JSON.stringify(before)).toBe(snapshot)
  })

  test('carries the identity a resumed run is pinned to', () => {
    const before = runStateWith(history())
    const result = compact(before)!
    expect(result.runState.traceSessionId).toBe('trace-1')
    expect(result.runState.inference).toEqual({ source: 'codebuff' })
    expect(result.runState.sessionState!.fileContext).toEqual(
      before.sessionState!.fileContext,
    )
  })

  test('fits the budget it is given, fixed overhead included', () => {
    const before = runStateWith(history())
    const result = compact(before, FIXED_TOKENS + 4_000)!
    expect(result.nextTokens).toBeLessThanOrEqual(FIXED_TOKENS + 4_000)
  })

  test('answers null when there is nothing older to condense', () => {
    expect(compact(runStateWith([user('Hello.')]))).toBeNull()
  })

  test('answers null for an empty history', () => {
    expect(compact(runStateWith([]))).toBeNull()
  })

  test('answers null when the state carries no session at all', () => {
    expect(
      compact({ output: { type: 'lastMessage', value: [] }, traceSessionId: 't' }),
    ).toBeNull()
  })
})
