/**
 * Batching puts many reads in one response. Adjacent reads run side by side,
 * while anything that can change the workspace still waits for them, and
 * results reach the history in call order.
 */
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { describe, expect, it } from 'bun:test'

import { mockFileContext } from './test-utils'
import { MAX_CONCURRENT_READS, processStream } from '../tools/stream-parser'

import type { AgentTemplate } from '../templates/types'
import type { StreamChunk } from '@codebuff/common/types/contracts/llm'
import type { PromptResult } from '@codebuff/common/util/error'

const template: AgentTemplate = {
  id: 'test-agent',
  displayName: 'Test Agent',
  spawnerPrompt: 'Test agent',
  model: 'deepseek/deepseek-v4-flash',
  inputSchema: {},
  outputMode: 'structured_output',
  includeMessageHistory: true,
  inheritParentSystemPrompt: false,
  mcpServers: {},
  toolNames: ['code_search', 'list_directory', 'run_terminal_command'],
  spawnableAgents: [],
  systemPrompt: 'Test system prompt',
  instructionsPrompt: 'Test instructions',
  stepPrompt: '',
}

const search = (id: string): StreamChunk => ({
  type: 'tool-call',
  toolCallId: id,
  toolName: 'code_search',
  input: { pattern: id },
})
const terminal = (id: string): StreamChunk => ({
  type: 'tool-call',
  toolCallId: id,
  toolName: 'run_terminal_command',
  input: { command: 'true' },
})

type Request = { toolName: string; input: { pattern?: string } }
const nameOf = (request: Request) => request.input.pattern ?? 't'

async function run(
  chunks: StreamChunk[],
  requestToolCall: (request: Request) => Promise<void>,
) {
  async function* stream(): AsyncGenerator<
    StreamChunk,
    PromptResult<string | null>
  > {
    for (const chunk of chunks) yield chunk
    return { aborted: false, value: 'msg-id' }
  }
  const agentState = getInitialSessionState(mockFileContext).mainAgentState
  agentState.messageHistory = []
  await processStream({
    ...TEST_AGENT_RUNTIME_IMPL,
    sendAction: () => {},
    agentContext: {},
    agentState,
    agentStepId: 'test-step-id',
    agentTemplate: template,
    ancestorRunIds: [],
    clientSessionId: 'test-session',
    fileContext: mockFileContext,
    fingerprintId: 'test-fingerprint',
    fullResponse: '',
    localAgentTemplates: { 'test-agent': template },
    messages: agentState.messageHistory,
    prompt: 'test prompt',
    repoId: undefined,
    repoUrl: undefined,
    runId: 'test-run-id',
    signal: new AbortController().signal,
    stream: stream(),
    system: 'test system',
    tools: {},
    userId: 'test-user',
    userInputId: 'test-input-id',
    streamFinishReason: () => 'tool_calls',
    onCostCalculated: async () => {},
    onResponseChunk: () => {},
    requestToolCall: async (request: Request) => {
      await requestToolCall(request)
      return {
        output: [{ type: 'json', value: { id: nameOf(request) } }],
      }
    },
  } as never)
  return agentState.messageHistory
    .filter((message) => message.role === 'tool')
    .map((message) => JSON.stringify(message.content))
    .map((content) => /"id":"([^"]+)"/.exec(content)?.[1])
}

describe('processStream — concurrent reads', () => {
  it('runs adjacent reads at once and keeps their results in call order', async () => {
    let releaseFirst!: () => void
    const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve))
    const results = await run([search('a'), search('b')], async (request) => {
      // Finishes only once the second read has started.
      if (nameOf(request) === 'a') await firstHeld
      else releaseFirst()
    })
    expect(results).toEqual(['a', 'b'])
  })

  it('keeps a terminal command behind the reads before it and ahead of those after', async () => {
    const events: string[] = []
    const results = await run(
      [search('a'), terminal('t'), search('b')],
      async (request) => {
        events.push(`start ${nameOf(request)}`)
        await Promise.resolve()
        events.push(`end ${nameOf(request)}`)
      },
    )
    expect(events).toEqual([
      'start a',
      'end a',
      'start t',
      'end t',
      'start b',
      'end b',
    ])
    expect(results).toEqual(['a', 't', 'b'])
  })

  it('caps how many reads run at once', async () => {
    let running = 0
    let peak = 0
    const ids = Array.from(
      { length: MAX_CONCURRENT_READS * 2 + 1 },
      (_, i) => `r${i}`,
    )
    const results = await run(ids.map(search), async () => {
      peak = Math.max(peak, ++running)
      await new Promise((resolve) => setTimeout(resolve, 1))
      running--
    })
    expect(peak).toBe(MAX_CONCURRENT_READS)
    expect(results).toEqual(ids)
  })
})
