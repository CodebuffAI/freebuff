import { describe, expect, test } from 'bun:test'

import {
  adjustContextTokenCountForHistoryEdit,
  estimateContextTokens,
  recordContextUsage,
  recountContextTokens,
} from '../context-token-count'
import { countTokensMessages } from '../token-counter'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { AgentState } from '@codebuff/common/types/session-state'
import type { ModelUsageData } from '@codebuff/common/types/contracts/llm'

const text = (role: 'user' | 'assistant', body: string) =>
  ({ role, content: [{ type: 'text', text: body }] }) as unknown as Message

const HISTORY: Message[] = [
  text('user', 'find every caller of loopAgentSteps'.repeat(50)),
  text('assistant', 'here they are'.repeat(200)),
]

const SYSTEM = 'you are a coding agent'.repeat(100)
const TOOLS = { read_files: { description: 'read', inputSchema: {} } }

describe('provider-anchored context size', () => {
  const receipt: ModelUsageData = {
    inputTokens: 12_000,
    outputTokens: 500,
    totalTokens: 12_500,
    cachedInputTokens: 10_000,
  }
  const setup = () => {
    const agentState: Pick<
      AgentState,
      'messageHistory' | 'contextTokenCount' | 'contextTokenBaseline'
    > = {
      messageHistory: [...HISTORY],
      contextTokenCount: 0,
    }
    const params = {
      agentState,
      model: 'test-model',
      systemPrompt: SYSTEM,
      toolsForTokenCount: TOOLS,
    }
    const estimatedInputTokens = estimateContextTokens(params)
    const output = text('assistant', 'done')
    agentState.messageHistory.push(output)
    recordContextUsage({
      agentState,
      model: params.model,
      usage: receipt,
      estimatedInputTokens,
      estimatedOutputTokens: countTokensMessages([output]),
    })
    return params
  }

  test('uses actual input + output, without adding cached input twice', () => {
    expect(estimateContextTokens(setup())).toBe(12_500)
  })

  test('adds fresh tool output and survives persistence and cancellation edits', () => {
    const params = setup()
    const result: Message = {
      role: 'tool',
      toolName: 'read_files',
      toolCallId: 'r',
      content: [
        { type: 'json', value: { content: 'const x = 1;\n'.repeat(1000) } },
      ],
    }
    const previousHistory = [...params.agentState.messageHistory]
    params.agentState.messageHistory.push(result)
    const expected = 12_500 + countTokensMessages([result])
    expect(estimateContextTokens(params)).toBe(expected)
    const persisted = JSON.parse(JSON.stringify(params.agentState))
    expect(estimateContextTokens({ ...params, agentState: persisted })).toBe(
      expected,
    )
    expect(
      adjustContextTokenCountForHistoryEdit({
        contextTokenCount: 12_500,
        previousHistory,
        nextHistory: persisted.messageHistory,
      }),
    ).toBe(expected)
  })

  test('does not use a different model’s receipt and forgets it after compaction', () => {
    const params = setup()
    const fallback = estimateContextTokens({
      ...params,
      model: 'another-model',
    })
    expect(fallback).not.toBe(12_500)
    params.agentState.contextTokenBaseline = undefined
    expect(estimateContextTokens(params)).toBe(fallback)
  })

  test('missing, zero, negative and non-finite receipts do not erase a valid anchor', () => {
    const params = setup()
    for (const inputTokens of [0, -1, NaN, Infinity]) {
      recordContextUsage({
        agentState: params.agentState,
        model: params.model,
        usage: { ...receipt, inputTokens },
        estimatedInputTokens: 1,
        estimatedOutputTokens: 1,
      })
      expect(estimateContextTokens(params)).toBe(12_500)
    }
  })
})

describe('recountContextTokens', () => {
  test('counts the history, the system prompt and the tool schemas', () => {
    const agentState = {
      messageHistory: HISTORY,
      contextTokenCount: 1,
    }
    const counted = recountContextTokens({
      agentState,
      systemPrompt: SYSTEM,
      toolsForTokenCount: TOOLS,
    })
    // Strictly larger than the history alone: the system prompt and tool
    // schemas are in every request and the compaction budget is enforced
    // against the total.
    expect(counted).toBeGreaterThan(countTokensMessages(HISTORY))
  })

  test("leaves a subagent's count alone instead of paying to recompute it", () => {
    // Only the ROOT agent's count is ever read — the host reads
    // sessionState.mainAgentState. Every spawned agent (file-picker, thinker,
    // context-pruner, …) otherwise pays a full countTokensMessages over its
    // whole history at the end of its run for a number that is discarded with
    // it, which on a one-step subagent roughly doubles its tokenizer cost.
    //
    // The stale sentinel is the assertion: a recount of this history cannot
    // produce 7 by accident.
    const agentState = {
      parentId: 'parent-run-id',
      messageHistory: HISTORY,
      contextTokenCount: 7,
    }
    expect(
      recountContextTokens({
        agentState,
        systemPrompt: SYSTEM,
        toolsForTokenCount: TOOLS,
      }),
    ).toBe(7)
  })
})

describe('adjustContextTokenCountForHistoryEdit', () => {
  // The count covers history + system + tools, and an edit at the persistence
  // boundary can only change the history half. Carrying the difference keeps
  // the other half — which the editor has no way to recompute, having neither
  // the system prompt nor the tool schemas in scope.
  const SYSTEM_AND_TOOLS = 9_000

  test('follows an appended message', () => {
    const nextHistory = [...HISTORY, text('user', 'run cancelled by user')]
    const adjusted = adjustContextTokenCountForHistoryEdit({
      contextTokenCount: countTokensMessages(HISTORY) + SYSTEM_AND_TOOLS,
      previousHistory: HISTORY,
      nextHistory,
    })
    expect(adjusted).toBe(countTokensMessages(nextHistory) + SYSTEM_AND_TOOLS)
    expect(adjusted).toBeGreaterThan(
      countTokensMessages(HISTORY) + SYSTEM_AND_TOOLS,
    )
  })

  test('follows a dropped message', () => {
    // dropUnansweredToolCalls can remove a large assistant tool call at the
    // same boundary, which moves the number the other way.
    const nextHistory = [HISTORY[0]]
    expect(
      adjustContextTokenCountForHistoryEdit({
        contextTokenCount: countTokensMessages(HISTORY) + SYSTEM_AND_TOOLS,
        previousHistory: HISTORY,
        nextHistory,
      }),
    ).toBe(countTokensMessages(nextHistory) + SYSTEM_AND_TOOLS)
  })

  test('never goes negative', () => {
    // A count from before this shipped can be 0 or unrelated to the history it
    // is paired with; a negative token count would render as a negative chip.
    expect(
      adjustContextTokenCountForHistoryEdit({
        contextTokenCount: 0,
        previousHistory: HISTORY,
        nextHistory: [],
      }),
    ).toBe(0)
  })
})
