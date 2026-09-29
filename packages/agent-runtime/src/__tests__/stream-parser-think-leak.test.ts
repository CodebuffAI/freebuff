/**
 * End-to-end over processStream: a lane that puts a thinking model's chain of
 * thought in `content` instead of `reasoning_content` must not reach a surface
 * as prose, and must never reach one carrying a literal `</think>`.
 */
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { beforeEach, describe, expect, it } from 'bun:test'

import { mockFileContext } from './test-utils'
import { processStream } from '../tools/stream-parser'

import type { AgentTemplate } from '../templates/types'
import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
} from '@codebuff/common/types/contracts/agent-runtime'
import type { StreamChunk } from '@codebuff/common/types/contracts/llm'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { PromptResult } from '@codebuff/common/util/error'

const testAgentTemplate: AgentTemplate = {
  id: 'test-agent',
  displayName: 'Test Agent',
  spawnerPrompt: 'Test agent',
  model: 'deepseek/deepseek-v4-flash',
  inputSchema: {},
  outputMode: 'structured_output',
  includeMessageHistory: true,
  inheritParentSystemPrompt: false,
  mcpServers: {},
  toolNames: ['read_files', 'end_turn'],
  spawnableAgents: [],
  systemPrompt: 'Test system prompt',
  instructionsPrompt: 'Test instructions',
  stepPrompt: 'Test step prompt',
}

/** What a surface would render: streamed text, and the thinking box. */
interface Rendered {
  text: string
  reasoning: string
  fullResponse: string
}

describe('processStream — leaked think tags', () => {
  let agentRuntimeImpl: AgentRuntimeDeps & AgentRuntimeScopedDeps

  beforeEach(() => {
    agentRuntimeImpl = { ...TEST_AGENT_RUNTIME_IMPL, sendAction: () => {} }
  })

  async function render(
    chunks: StreamChunk[],
    priorHistory: Message[] = [],
    finishReason: string | undefined = 'stop',
  ): Promise<Rendered> {
    async function* stream(): AsyncGenerator<
      StreamChunk,
      PromptResult<string | null>
    > {
      for (const chunk of chunks) yield chunk
      return { aborted: false, value: 'msg-id' }
    }

    const sessionState = getInitialSessionState(mockFileContext)
    const agentState = sessionState.mainAgentState
    agentState.messageHistory = [...priorHistory]

    let text = ''
    let reasoning = ''
    const result = await processStream({
      ...agentRuntimeImpl,
      agentContext: {},
      agentState,
      agentStepId: 'test-step-id',
      agentTemplate: testAgentTemplate,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: mockFileContext,
      fingerprintId: 'test-fingerprint',
      fullResponse: '',
      localAgentTemplates: { 'test-agent': testAgentTemplate },
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
      streamFinishReason: () => finishReason,
      onCostCalculated: async () => {},
      onResponseChunk: (chunk: string | PrintModeEvent) => {
        if (typeof chunk === 'string') {
          text += chunk
        } else if (chunk.type === 'reasoning_delta') {
          reasoning += chunk.text
        }
      },
    })

    return { text, reasoning, fullResponse: result.fullResponse }
  }

  const textChunks = (...texts: string[]): StreamChunk[] =>
    texts.map((t) => ({ type: 'text' as const, text: t }))

  const leakedAssistantTurn: Message[] = [
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'earlier thought</think>earlier answer' }],
    } as Message,
  ]

  it('routes a paired block to the thinking box', async () => {
    const { text, reasoning } = await render(
      textChunks('<think>weigh the options</think>', 'The answer.'),
    )
    expect(reasoning).toBe('weigh the options')
    expect(text).toBe('The answer.')
  })

  it('never streams a bare close marker, even unarmed', async () => {
    const { text, reasoning } = await render(
      textChunks('Saw the anchor.', '</think>', 'Now the fix.'),
    )
    expect(text).toBe('Saw the anchor.Now the fix.')
    expect(text).not.toContain('</think>')
    expect(reasoning).toBe('')
  })

  it('reclassifies the head once a prior turn proved the lane leaks', async () => {
    const { text, reasoning } = await render(
      textChunks('Ключевая зацепка: ', 'the bundle knows.', '</think>Real answer.'),
      leakedAssistantTurn,
    )
    expect(reasoning).toBe('Ключевая зацепка: the bundle knows.')
    expect(text).toBe('Real answer.')
  })

  it('releases the head as text when the marker never comes', async () => {
    // The lossless guarantee: a wrong guess delays an answer, never hides it.
    const { text, reasoning } = await render(
      textChunks('A clean answer this time.'),
      leakedAssistantTurn,
    )
    expect(text).toBe('A clean answer this time.')
    expect(reasoning).toBe('')
  })

  it('stands down when the lane does populate native reasoning', async () => {
    const { text, reasoning } = await render(
      [
        { type: 'reasoning', text: 'native thought' },
        ...textChunks('The answer.'),
      ],
      leakedAssistantTurn,
    )
    expect(reasoning).toBe('native thought')
    expect(text).toBe('The answer.')
  })

  it('leaves fullResponse raw so the turn-end and arming signals survive', async () => {
    // isThinkOnlyResponse reads fullResponse to keep a thinking-only step from
    // ending the turn; historyLeaksThinkTags reads the history to arm the next.
    const { fullResponse } = await render(textChunks('thought', '</think>done'))
    expect(fullResponse).toBe('thought</think>done')
  })

  // CodebuffAI/freebuff#1155
  it('shows an unclosed head block as the reply when the model ended the step', async () => {
    const { text, reasoning, fullResponse } = await render(
      textChunks('<think>', 'Here is the answer.'),
    )
    expect(reasoning).toBe('Here is the answer.')
    expect(text).toBe('Here is the answer.')
    expect(fullResponse).toBe('<think>Here is the answer.')
  })

  it('keeps an unclosed head block as a thought when the output limit cut it', async () => {
    const { text, reasoning } = await render(
      textChunks('<think>', 'still weighing the'),
      [],
      'length',
    )
    expect(reasoning).toBe('still weighing the')
    expect(text).toBe('')
  })

  it('keeps an unclosed head block as a thought when the step called a tool', async () => {
    // Not replying yet: the thought led to a tool call, and the turn goes on.
    const { text, reasoning } = await render([
      ...textChunks('<think>', 'end the turn now'),
      { type: 'tool-call', toolCallId: 'c1', toolName: 'end_turn', input: {} },
    ])
    expect(reasoning).toBe('end the turn now')
    expect(text).toBe('')
  })

  it('keeps a <think> quoted mid-answer in the reply', async () => {
    const { text, reasoning } = await render(
      textChunks('Wrap it in a ', '<think>', ' tag, then summarize.'),
    )
    expect(text).toBe('Wrap it in a <think> tag, then summarize.')
    expect(reasoning).toBe('')
  })
})
