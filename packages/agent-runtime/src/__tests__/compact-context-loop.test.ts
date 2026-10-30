/**
 * End-to-end cover for the `compactContext` flag: conversation-summary.test.ts
 * proves the pieces, and this proves the loop makes summaries at the right
 * time and that the history the model sees is the one it should.
 */

import * as analytics from '@codebuff/common/analytics'
import { BYOK_RUN_ID_PREFIX } from '@codebuff/common/constants/byok'
import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { createTestAgentRuntimeParams } from '@codebuff/common/testing/fixtures/agent-runtime'
import { clearMockedModules } from '@codebuff/common/testing/mock-modules'
import {
  createMockDbOperations,
  setupDbSpies,
} from '@codebuff/common/testing/mocks/database'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { promptSuccess } from '@codebuff/common/util/error'
import { assistantMessage, userMessage } from '@codebuff/common/util/messages'
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'

import {
  conversationSummaries,
  messageFingerprint,
  resetConversationSummariesForTest,
} from '../conversation-summary'
import { loopAgentSteps, USER_PROMPT_REFUSED_NOTE } from '../run-agent-step'
import { clearAgentGeneratorCache } from '../run-programmatic-step'
import { countTokensMessages } from '../util/token-counter'
import { createToolCallChunk, mockFileContext } from './test-utils'

import type { AgentTemplate } from '../templates/types'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type {
  AgentState,
  ConversationSummary,
} from '@codebuff/common/types/session-state'
import type { DbSpies } from '@codebuff/common/testing/mocks/database'

const MINUTE = 60 * 1000
const SUMMARY_TEXT = `## Objective\n- MODEL SUMMARY of the work so far ${'detail '.repeat(60)}`

const textOf = (message: Message): string =>
  Array.isArray(message.content)
    ? message.content
        .map((part) => ('text' in part ? part.text : ''))
        .join('\n')
    : String(message.content ?? '')

const joined = (messages: Message[]) => messages.map(textOf).join('\n')

describe('compactContext in loopAgentSteps', () => {
  let dbSpies: DbSpies
  let seenMessages: Message[][]
  let summaryRequests: Message[][]
  let summaryFails: boolean
  let order: string[]
  let runtimeImpl: any

  const baseTemplate: AgentTemplate = {
    id: 'test-agent',
    displayName: 'Test Agent',
    spawnerPrompt: 'Testing',
    model: 'claude-3-5-sonnet-20241022',
    inputSchema: {},
    outputMode: 'last_message',
    includeMessageHistory: true,
    inheritParentSystemPrompt: false,
    mcpServers: {},
    toolNames: ['end_turn'],
    spawnableAgents: [],
    systemPrompt: 'Test system prompt',
    instructionsPrompt: '',
    stepPrompt: '',
    handleSteps: undefined,
  } satisfies AgentTemplate as AgentTemplate

  const optedIn = { ...baseTemplate, compactContext: true } as AgentTemplate

  /** An old read whose result is most of the history (~53k tokens). */
  const bulkyRead = (body = 'BULKY FILE BODY '): Message[] => [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'old-read',
          toolName: 'read_files',
          input: { paths: ['big.ts'] },
        },
      ],
      sentAt: 1_000_000,
    },
    {
      role: 'tool',
      toolName: 'read_files',
      toolCallId: 'old-read',
      content: [
        {
          type: 'json',
          value: [{ path: 'big.ts', content: body.repeat(10_000) }],
        },
      ],
    },
  ]

  /** The last assistant message landed `gapMinutes` before the live prompt. */
  const idleHistory = (gapMinutes: number): Message[] => [
    { ...userMessage('the first request'), sentAt: 1_000_000 },
    ...bulkyRead(),
    {
      ...assistantMessage('DISTINCTIVE PRIOR ANSWER '.repeat(100)),
      sentAt: 1_000_000,
    },
    {
      ...userMessage('the live question'),
      tags: ['USER_PROMPT'],
      sentAt: 1_000_000 + gapMinutes * MINUTE,
    },
  ]

  /** The provider's count for the last response, as the saved state holds it. */
  const measured = (tokens: number) => ({
    contextTokenBaseline: {
      model: baseTemplate.model,
      tokens,
      estimatedTokens: tokens,
      scale: 1,
    },
  })

  /** A summary covering everything before the live question. */
  const readySummary = (history: Message[]): ConversationSummary => ({
    id: 'ready-summary',
    text: SUMMARY_TEXT,
    coveredMessages: history.length - 1,
    anchor: messageFingerprint(history[history.length - 2]),
    contextTokens: 55_000,
    createdAt: 1,
  })

  const runLoop = async (
    template: AgentTemplate,
    messageHistory: Message[],
    options: {
      prompt?: string
      logged?: unknown[]
      runtimeOverrides?: Record<string, unknown>
      state?: Partial<AgentState>
      /** The chunks of one agent step; defaults to "ok" and end_turn. */
      step?: () => unknown[]
      /** Input tokens the provider reports; null reports no usage. */
      reportedInput?: number | null
    } = {},
  ) => {
    const {
      agentTemplate: _,
      localAgentTemplates: __,
      ...baseRuntimeParams
    } = createTestAgentRuntimeParams()

    runtimeImpl = { ...baseRuntimeParams, ...options.runtimeOverrides }
    if (options.logged) {
      const logged = options.logged
      runtimeImpl.logger = {
        ...baseRuntimeParams.logger,
        info: (data: unknown) => logged.push(data),
      }
    }
    runtimeImpl.promptAiSdkStream = mock(async function* (params: any) {
      if (params.extraCodebuffMetadata?.compaction_summary === '1') {
        summaryRequests.push(params.messages)
        order.push('summary')
        if (summaryFails) {
          yield { type: 'error' as const, message: 'provider down' }
        } else {
          yield { type: 'text' as const, text: SUMMARY_TEXT }
        }
        return promptSuccess('summary-id')
      }
      seenMessages.push(params.messages)
      order.push('agent')
      // The provider's usage receipt: summary decisions read only this.
      const inputTokens =
        options.reportedInput ?? countTokensMessages(params.messages)
      if (options.reportedInput !== null)
        params.onUsageReceived?.({
          inputTokens,
          outputTokens: 10,
          cachedInputTokens: 0,
          totalTokens: inputTokens + 10,
        })
      const chunks = options.step?.() ?? [
        { type: 'text' as const, text: 'ok' },
        createToolCallChunk('end_turn', {}),
      ]
      for (const chunk of chunks) yield chunk as any
      return promptSuccess('mock-message-id')
    })

    const sessionState = getInitialSessionState(mockFileContext)
    return loopAgentSteps({
      ...runtimeImpl,
      agentType: template.id,
      localAgentTemplates: { [template.id]: template },
      repoId: undefined,
      repoUrl: undefined,
      userInputId: 'test-user-input',
      agentState: {
        ...sessionState.mainAgentState,
        agentId: 'test-agent-id',
        messageHistory,
        output: undefined,
        stepsRemaining: 5,
        ...options.state,
      },
      prompt: options.prompt,
      spawnParams: undefined,
      fingerprintId: 'test-fingerprint',
      fileContext: mockFileContext,
      userId: TEST_USER_ID,
      clientSessionId: 'test-session',
      ancestorRunIds: [],
      extraCodebuffMetadata: {
        trace_session_id: 'thread-1',
        ...runtimeImpl.extraCodebuffMetadata,
      },
      onResponseChunk: () => {},
      signal: new AbortController().signal,
    } as any)
  }

  it('links the applied summary, wait, follow-up and first request', async () => {
    const history = idleHistory(6)
    const logged: any[] = []
    await runLoop(optedIn, history, {
      logged,
      state: { compactionSummary: readySummary(history) },
      reportedInput: 1000,
    })
    const attempt = logged.find(
      (row) => row.axiomEvent === 'context_compaction.attempt',
    )
    expect(attempt).toMatchObject({
      outcome: 'applied',
      summary_id: 'ready-summary',
      compaction_version: 'summary-v1',
      ready_summary: true,
      waited_for_pending: false,
    })
    expect(attempt.duration_ms).toBeGreaterThanOrEqual(0)
    const request =
      runtimeImpl.promptAiSdkStream.mock.calls[0][0].extraCodebuffMetadata
    expect(request).toMatchObject({
      compaction_request_group: 'first_after_compaction',
      compaction_id: attempt.compaction_id,
      compaction_summary_id: 'ready-summary',
      compaction_root_version: 'summary-v1',
      compaction_version: 'summary-v1',
    })
    expect(request.compaction_request_id).toBeTruthy()
    expect(
      logged.find(
        (row) => row.axiomEvent === 'context_compaction.first_output',
      ),
    ).toMatchObject({ idle_return: true, agent_run_id: attempt.agent_run_id })
    expect(
      logged.find((row) => row.axiomEvent === 'context_compaction.followup'),
    ).toMatchObject({ compaction_id: attempt.compaction_id })
  })

  it('labels small runs too, without inheriting a parent request group', async () => {
    await runLoop(baseTemplate, [userMessage('small')], {
      reportedInput: 100,
      state: { parentId: 'parent' },
      runtimeOverrides: {
        extraCodebuffMetadata: {
          compaction_root_version: 'summary-v1',
          compaction_root_run_id: 'root',
          compaction_id: 'parent-swap',
          compaction_summary: '1',
          compaction_request_group: 'first_after_compaction',
        },
      },
    })
    const request =
      runtimeImpl.promptAiSdkStream.mock.calls[0][0].extraCodebuffMetadata
    expect(request).toMatchObject({
      compaction_version: 'not-enabled',
      compaction_root_version: 'summary-v1',
      compaction_root_run_id: 'root',
      compaction_request_group: 'other',
    })
    expect(request.compaction_id).toBeUndefined()
    expect(request.compaction_summary).toBeUndefined()
  })

  /** Lets background summaries settle. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

  beforeEach(() => {
    seenMessages = []
    summaryRequests = []
    summaryFails = false
    order = []
    resetConversationSummariesForTest()
    dbSpies = setupDbSpies(createMockDbOperations())
    spyOn(analytics, 'trackEvent').mockImplementation(() => {})
  })

  afterEach(() => {
    if (runtimeImpl) clearAgentGeneratorCache(runtimeImpl)
    dbSpies.restore()
    mock.restore()
  })

  afterAll(() => {
    clearMockedModules()
  })

  it('leaves the history alone when the agent has not opted in', async () => {
    await runLoop(baseTemplate, idleHistory(120))
    await settle()
    expect(joined(seenMessages[0])).toContain('DISTINCTIVE PRIOR ANSWER')
    expect(summaryRequests).toHaveLength(0)
  })

  describe('making summaries', () => {
    it('summarizes in the background with the same prefix the agent sends', async () => {
      const logged: unknown[] = []
      const history = idleHistory(0)
      const result = await runLoop(optedIn, history, { logged })
      await settle()

      // The agent's own request still carries the full history.
      expect(joined(seenMessages[0])).toContain('DISTINCTIVE PRIOR ANSWER')
      expect(summaryRequests).toHaveLength(1)
      // Checked after the step's response, never before its request.
      expect(order).toEqual(['agent', 'summary'])
      const request = summaryRequests[0]
      // The step's request byte for byte, then its response, then the
      // instruction: the provider reads the request part from its cache.
      expect(request.slice(0, seenMessages[0].length)).toEqual(seenMessages[0])
      expect(joined(request.slice(seenMessages[0].length))).toContain('ok')
      expect(textOf(request.at(-1)!)).toContain(
        'Write a structured summary of this whole conversation.',
      )
      // It finishes after the run returned, so it waits in the store.
      expect(
        conversationSummaries('thread-1:test-agent-id').latest(
          undefined,
          result.agentState.messageHistory,
        )?.text,
      ).toBe(SUMMARY_TEXT.trim())
      expect(logged).toContainEqual(
        expect.objectContaining({
          axiomEvent: 'compaction_summary',
          outcome: 'completed',
          mode: 'background',
        }),
      )
    })

    it('hands the finished summary to the host to save', async () => {
      const saved: unknown[] = []
      const result = await runLoop(optedIn, idleHistory(0), {
        runtimeOverrides: {
          onCompactionSummary: (summary: unknown) => saved.push(summary),
        },
      })
      // The run returned before the summary finished.
      expect(result.agentState.compactionSummary).toBeUndefined()
      await settle()
      expect(saved).toEqual([
        expect.objectContaining({ text: SUMMARY_TEXT.trim() }),
      ])
    })

    it('sizes the context from the provider, never from the text', async () => {
      // The text estimate of this history is over 40k; the provider says 30k.
      await runLoop(optedIn, idleHistory(0), { reportedInput: 30_000 })
      await settle()
      expect(summaryRequests).toHaveLength(0)

      // No usage receipt: no decision.
      await runLoop(optedIn, idleHistory(0), { reportedInput: null })
      await settle()
      expect(summaryRequests).toHaveLength(0)
    })

    it('makes no summary for a small conversation', async () => {
      await runLoop(optedIn, [{ ...userMessage('hi'), tags: ['USER_PROMPT'] }])
      await settle()
      expect(summaryRequests).toHaveLength(0)
    })

    it('makes no new summary until the context grows enough', async () => {
      const history = idleHistory(0)
      await runLoop(optedIn, history, {
        state: { compactionSummary: readySummary(history) },
      })
      await settle()
      expect(summaryRequests).toHaveLength(0)
    })

    it('makes a new summary after the context grows by 30k tokens', async () => {
      const history = idleHistory(0)
      await runLoop(optedIn, history, {
        state: {
          compactionSummary: {
            ...readySummary(history),
            contextTokens: 20_000,
          },
        },
      })
      await settle()
      expect(summaryRequests).toHaveLength(1)
    })

    it('waits for a cold cache to warm before summarizing', async () => {
      // An idle return with no summary: the full history goes once, and the
      // summary is made at the turn's end, when the cache is warm again.
      await runLoop(optedIn, idleHistory(120))
      expect(joined(seenMessages[0])).toContain('DISTINCTIVE PRIOR ANSWER')
      await settle()
      expect(summaryRequests).toHaveLength(1)
      expect(joined(summaryRequests[0])).toContain('ok')
    })
  })

  describe('using summaries', () => {
    it('keeps sending the full history while the cache is warm', async () => {
      const history = idleHistory(4)
      await runLoop(optedIn, history, {
        state: { compactionSummary: readySummary(history) },
      })
      expect(joined(seenMessages[0])).toContain('DISTINCTIVE PRIOR ANSWER')
      expect(joined(seenMessages[0])).not.toContain('MODEL SUMMARY')
    })

    it('swaps in the summary when the user returns after the cache expired', async () => {
      const logged: unknown[] = []
      const history = idleHistory(6)
      const result = await runLoop(optedIn, history, {
        logged,
        state: { compactionSummary: readySummary(history) },
      })

      expect(summaryRequests).toHaveLength(0)
      const sent = joined(seenMessages[0])
      expect(sent).toContain('<conversation_summary>')
      expect(sent).toContain('MODEL SUMMARY')
      expect(sent).toContain('the live question')
      expect(sent).not.toContain('BULKY FILE BODY')
      expect(sent).not.toContain('DISTINCTIVE PRIOR ANSWER')
      expect(joined(result.agentState.messageHistory)).toContain(
        'MODEL SUMMARY',
      )
      expect(logged).toContainEqual(
        expect.objectContaining({
          axiomEvent: 'context_compaction_completed',
          trigger_reason: 'cache_expiry',
        }),
      )
    })

    it('sends the full history after an idle gap when no summary exists', async () => {
      await runLoop(optedIn, idleHistory(120))
      expect(joined(seenMessages[0])).toContain('DISTINCTIVE PRIOR ANSWER')
    })

    it('swaps once, not on every step of the turn', async () => {
      let call = 0
      const template = {
        ...optedIn,
        toolNames: ['read_files', 'end_turn'],
      } as AgentTemplate
      const history = idleHistory(120)
      await runLoop(template, history, {
        state: { compactionSummary: readySummary(history) },
        step: () => {
          call++
          return [
            { type: 'text' as const, text: `STEP ${call} OUTPUT` },
            call >= 3
              ? createToolCallChunk('end_turn', {})
              : createToolCallChunk('read_files', {
                  paths: [`file${call}.txt`],
                }),
          ]
        },
      })

      expect(seenMessages.length).toBe(3)
      const summaryCounts = seenMessages.map(
        (messages) =>
          messages.filter((m) => textOf(m).includes('<conversation_summary>'))
            .length,
      )
      expect(summaryCounts).toEqual([1, 1, 1])
      const lastStep = joined(seenMessages[2])
      expect(lastStep).toContain('STEP 1 OUTPUT')
      expect(lastStep).toContain('STEP 2 OUTPUT')
      expect(lastStep).toContain('the live question')
    })

    it('drops a summary whose covered messages an edit removed', async () => {
      const history = idleHistory(120)
      const summary = {
        ...readySummary(history),
        anchor: messageFingerprint(
          assistantMessage('a message the edit removed'),
        ),
      }
      const result = await runLoop(optedIn, history, {
        state: { compactionSummary: summary },
      })
      expect(joined(seenMessages[0])).toContain('DISTINCTIVE PRIOR ANSWER')
      expect(result.agentState.compactionSummary?.anchor).not.toBe(
        summary.anchor,
      )
    })

    it('reaches the next turn when it finishes after its run ended', async () => {
      const first = await runLoop(optedIn, idleHistory(0))
      await settle()
      expect(summaryRequests).toHaveLength(1)

      // The host persisted the state before the summary finished.
      const persisted: Message[] = JSON.parse(
        JSON.stringify(first.agentState.messageHistory),
      )
      const lastAssistant = persisted.findLast((m) => m.role === 'assistant')!
      seenMessages = []
      await runLoop(optedIn, [
        ...persisted,
        {
          ...userMessage('a question an hour later'),
          tags: ['USER_PROMPT'],
          sentAt: (lastAssistant.sentAt ?? 0) + 60 * MINUTE,
        },
      ])
      const sent = joined(seenMessages[0])
      expect(sent).toContain('MODEL SUMMARY')
      expect(sent).toContain('a question an hour later')
      expect(sent).not.toContain('BULKY FILE BODY')
    })
  })

  describe('at the context limit', () => {
    const smallBudget = {
      ...baseTemplate,
      compactContext: { maxContextLength: 4096 },
    } as AgentTemplate

    it('makes a summary now when none is ready, then swaps it in', async () => {
      const result = await runLoop(smallBudget, idleHistory(0), {
        state: measured(60_000),
      })
      expect(result.output.type).not.toBe('error')
      expect(summaryRequests).toHaveLength(1)
      // It summarized the full history...
      expect(JSON.stringify(summaryRequests[0])).toContain('BULKY FILE BODY')
      // ...and the agent's request carries only the summary.
      const sent = joined(seenMessages[0])
      expect(sent).toContain('MODEL SUMMARY')
      expect(sent).not.toContain('BULKY FILE BODY')
    })

    it("keeps the turn's own request after a summary made for it", async () => {
      // Without this, the request lived only inside the summary, and an edit
      // of it later could not find it and cleared the whole chat.
      const result = await runLoop(smallBudget, idleHistory(0).slice(0, -1), {
        prompt: 'THE NEW REQUEST',
        state: measured(60_000),
      })
      expect(summaryRequests).toHaveLength(1)
      expect(JSON.stringify(summaryRequests[0])).toContain('THE NEW REQUEST')
      const sent = seenMessages[0]
      expect(textOf(sent[1])).toContain('<conversation_summary>')
      expect(textOf(sent[2])).toBe('THE NEW REQUEST')
      expect(
        result.agentState.messageHistory.filter((m) =>
          m.tags?.includes('USER_PROMPT'),
        ),
      ).toHaveLength(1)
    })

    it('decides on the provider count only, never a text estimate', async () => {
      // ~55k of text and no count for it: no decision until a response.
      await runLoop(smallBudget, idleHistory(0), { reportedInput: null })
      await settle()
      expect(summaryRequests).toHaveLength(0)
      expect(JSON.stringify(seenMessages[0])).toContain('BULKY FILE BODY')
    })

    it('uses a ready summary while a newer one is still in progress', async () => {
      // The newer summary never finishes: waiting for it would hang the run.
      conversationSummaries('thread-1:test-agent-id').start(
        70_000,
        () => new Promise(() => {}),
      )
      const history = idleHistory(0)
      const budget = {
        ...baseTemplate,
        compactContext: { maxContextLength: 60_000 },
      } as AgentTemplate
      await runLoop(budget, history, {
        state: {
          compactionSummary: readySummary(history),
          ...measured(55_000),
        },
      })
      const sent = joined(seenMessages[0])
      expect(sent).toContain('MODEL SUMMARY')
      expect(sent).toContain('the live question')
    })

    it('uses a ready summary without waiting for a new one', async () => {
      const history = idleHistory(0)
      const budget = {
        ...baseTemplate,
        compactContext: { maxContextLength: 60_000 },
      } as AgentTemplate
      await runLoop(budget, history, {
        state: {
          compactionSummary: readySummary(history),
          ...measured(55_000),
        },
      })
      expect(summaryRequests).toHaveLength(0)
      const sent = joined(seenMessages[0])
      expect(sent).toContain('MODEL SUMMARY')
      expect(sent).toContain('the live question')
    })

    describe('when no summary can be made', () => {
      const firstLine = (output: { type: string; message?: string }) =>
        output.message?.split('\n')[0]

      it('points a hosted run at a larger-context model', async () => {
        summaryFails = true
        const logged: any[] = []
        const result = await runLoop(smallBudget, idleHistory(0), {
          logged,
          state: measured(60_000),
        })
        expect(seenMessages).toHaveLength(0)
        const summary = logged.find(
          (row) => row.axiomEvent === 'compaction_summary',
        )
        expect(summary).toMatchObject({ outcome: 'failed' })
        expect(
          logged.find((row) => row.axiomEvent === 'context_compaction.attempt'),
        ).toMatchObject({
          outcome: 'failed',
          summary_id: summary.summary_id,
          generated_foreground: true,
        })
        expect(firstLine(result.output)).toBe(
          "Agent run error: Compaction could not bring this conversation under the model's 4,096-token context budget. History has been preserved. Start a new thread, or switch to a model with a larger context window.",
        )
      })

      it('keeps the context window hint for a BYOK run', async () => {
        summaryFails = true
        const result = await runLoop(smallBudget, idleHistory(0), {
          state: measured(60_000),
          runtimeOverrides: {
            startAgentRun: async () => `${BYOK_RUN_ID_PREFIX}test-run`,
          },
        })
        expect(firstLine(result.output)).toBe(
          "Agent run error: Compaction could not bring this conversation under the model's 4,096-token context budget. History has been preserved. Start a new thread, or give a BYOK connection a larger context window if its model supports one.",
        )
      })
    })

    it('keeps no message the size guard refused', async () => {
      const first = await runLoop(smallBudget, [], {
        prompt: 'REFUSED PROMPT BODY '.repeat(2_000),
      })
      expect(seenMessages).toHaveLength(0)
      expect(first.agentState.messageHistory).toHaveLength(1)
      expect(textOf(first.agentState.messageHistory[0])).toContain(
        USER_PROMPT_REFUSED_NOTE,
      )
    })

    it('gives a refused mid-turn steering message the refusal note', async () => {
      const result = await runLoop(smallBudget, [], {
        prompt: 'hello',
        runtimeOverrides: {
          drainSteeringMessages: async () => [
            'REFUSED STEERING '.repeat(2_000),
          ],
        },
      })
      const history = result.agentState.messageHistory
      expect(textOf(history.at(-1)!)).toContain(USER_PROMPT_REFUSED_NOTE)
      expect(JSON.stringify(history)).not.toContain('REFUSED STEERING')
    })
  })

  describe('manual /compact', () => {
    it('uses the latest summary', async () => {
      const history = idleHistory(0)
      const result = await runLoop(optedIn, history, {
        prompt: '/compact',
        state: { compactionSummary: readySummary(history) },
      })
      expect(result.output.type).not.toBe('error')
      expect(summaryRequests).toHaveLength(0)
      expect(seenMessages).toHaveLength(0)
      const kept = joined(result.agentState.messageHistory)
      expect(kept).toContain('MODEL SUMMARY')
      expect(kept).toContain('the live question')
      expect(kept).not.toContain('/compact')
    })

    it('reports no size until the provider counts the next request', async () => {
      const history = idleHistory(0)
      const receipts: Array<{ preTokens?: number; postTokens?: number }> = []
      const compacted = await runLoop(optedIn, history, {
        prompt: '/compact',
        state: { compactionSummary: readySummary(history) },
        runtimeOverrides: {
          onCompaction: (receipt: { postTokens?: number }) =>
            receipts.push(receipt),
        },
      })
      expect(receipts).toHaveLength(1)
      expect(receipts[0].postTokens).toBeUndefined()
      expect(compacted.agentState.compactionSummary?.contextTokens).toBe(
        undefined,
      )

      // The next turn, in another run: its first response sets the size.
      const next = await runLoop(
        optedIn,
        [
          ...compacted.agentState.messageHistory,
          { ...userMessage('next question'), tags: ['USER_PROMPT'] },
        ],
        {
          reportedInput: 9_000,
          state: {
            compactionSummary: compacted.agentState.compactionSummary,
            pendingCompactionTelemetry: JSON.parse(
              JSON.stringify(compacted.agentState.pendingCompactionTelemetry),
            ),
          },
        },
      )
      expect(next.agentState.compactionSummary?.contextTokens).toBe(9_010)
      expect(
        runtimeImpl.promptAiSdkStream.mock.calls[0][0].extraCodebuffMetadata,
      ).toMatchObject({
        compaction_request_group: 'first_after_compaction',
        compaction_id: compacted.agentState.pendingCompactionTelemetry!.id,
      })
      expect(next.agentState.pendingCompactionTelemetry).toBeUndefined()
    })

    it('makes a summary now when none exists', async () => {
      const result = await runLoop(optedIn, idleHistory(0), {
        prompt: '/compact',
      })
      expect(summaryRequests).toHaveLength(1)
      expect(seenMessages).toHaveLength(0)
      expect(joined(result.agentState.messageHistory)).toContain(
        'MODEL SUMMARY',
      )
    })
  })

  // Desktop BYOK, 2026-09-24..27 ("compacts every 3-5 turns"): a 32k-default
  // connection's budget is 25,804 tokens and its threshold 20,643, while the
  // prompt and tool catalog take ~15k.
  describe('a small window under a large fixed prompt', () => {
    const smallWindow = {
      ...baseTemplate,
      systemPrompt: 'Follow the project conventions carefully. '.repeat(1_100),
      compactContext: { maxContextLength: 25_804 },
    } as AgentTemplate
    const withReads = (count: number): Message[] => {
      const history: Message[] = [
        { ...userMessage('review the files'), tags: ['USER_PROMPT'] },
      ]
      for (let i = 0; i < count; i++) {
        history.push(
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: `read-${i}`,
                toolName: 'read_files',
                input: { paths: [`file${i}.ts`] },
              },
            ],
          },
          {
            role: 'tool',
            toolName: 'read_files',
            toolCallId: `read-${i}`,
            content: [
              {
                type: 'json',
                value: [
                  {
                    path: `file${i}.ts`,
                    content: `READ ${i} BODY `.repeat(400),
                  },
                ],
              },
            ],
          },
        )
      }
      return history
    }

    it('keeps working past the threshold instead of compacting futilely', async () => {
      const result = await runLoop(smallWindow, withReads(4), {
        state: measured(21_000),
      })
      const sent = JSON.stringify(seenMessages[0])
      expect(sent.includes('<conversation_summary>')).toBe(false)
      expect(sent.includes('READ 0 BODY')).toBe(true)
      expect(result.output.type).not.toBe('error')
    })

    it('still compacts at the hard budget', async () => {
      const result = await runLoop(smallWindow, withReads(8), {
        state: measured(30_000),
      })
      const sent = JSON.stringify(seenMessages[0])
      expect(sent.includes('READ 0 BODY')).toBe(false)
      expect(sent.includes('MODEL SUMMARY')).toBe(true)
      expect(result.output.type).not.toBe('error')
    })
  })

  it('survives agent-definition validation, which strips unknown keys', async () => {
    const { validateSingleAgent } =
      await import('@codebuff/common/templates/agent-validation')
    const definition = {
      id: 'validated-agent',
      displayName: 'Validated',
      model: 'anthropic/claude-opus-5',
      inputSchema: {},
      compactContext: { cacheExpiryMs: 10 * MINUTE, cacheExpiryMinTokens: 5 },
    }

    const result = validateSingleAgent({ template: definition })
    expect(result.error).toBeUndefined()
    expect(result.agentTemplate?.compactContext).toEqual({
      cacheExpiryMs: 10 * MINUTE,
      cacheExpiryMinTokens: 5,
    })
    expect(
      validateSingleAgent({
        template: { ...definition, compactContext: true },
      }).agentTemplate?.compactContext,
    ).toBe(true)
    expect(
      validateSingleAgent({
        template: { ...definition, compactContext: { cacheExpiry: 1000 } },
      }).success,
    ).toBe(false)
  })
})
