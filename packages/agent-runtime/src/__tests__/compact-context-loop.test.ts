/**
 * End-to-end cover for the `compactContext` flag: compact-history.test.ts
 * proves the algorithm, and this proves the runtime actually reaches it and
 * that the rewritten history is what the model sees.
 */

import * as analytics from '@codebuff/common/analytics'
import { usesDeterministicCompaction } from '@codebuff/common/constants/compaction-policy'
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

import { loopAgentSteps } from '../run-agent-step'
import { clearAgentGeneratorCache } from '../run-programmatic-step'
import { createToolCallChunk, mockFileContext } from './test-utils'

import type { AgentTemplate } from '../templates/types'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { DbSpies } from '@codebuff/common/testing/mocks/database'

const MINUTE = 60 * 1000

const textOf = (message: Message): string =>
  Array.isArray(message.content)
    ? message.content
        .map((part) => ('text' in part ? part.text : ''))
        .join('\n')
    : String(message.content ?? '')

describe('compactContext in loopAgentSteps', () => {
  let dbSpies: DbSpies
  let seenMessages: Message[][]
  let runtimeImpl: any
  const defaultCompactionInput: unknown = {
    summary:
      'the first request: DISTINCTIVE PRIOR ANSWER. Continue with the live question.',
  }
  /** What the summarizer's `complete_compaction` call carries, or a throw. */
  let compactionInput: unknown | (() => never) = defaultCompactionInput

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

  /** An old read whose result is most of the history: what a mechanical pass
   * reclaims. Without it the history is too small to shrink. At ~53k tokens
   * it is over the 40k working-set limit, so it comes back as a stub. */
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

  /**
   * A conversation whose last assistant message landed `gapMinutes` before the
   * live user prompt — i.e. the prompt cache has had that long to expire.
   */
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

  const runLoop = async (
    template: AgentTemplate,
    messageHistory: Message[],
    prompt?: string,
    logged?: unknown[],
    userId: string = TEST_USER_ID,
  ) => {
    const {
      agentTemplate: _,
      localAgentTemplates: __,
      ...baseRuntimeParams
    } = createTestAgentRuntimeParams()

    runtimeImpl = { ...baseRuntimeParams }
    if (logged)
      runtimeImpl.logger = {
        ...baseRuntimeParams.logger,
        info: (data: unknown) => logged.push(data),
      }
    runtimeImpl.promptAiSdkStream = mock(async function* (params: any) {
      if (params.tools.complete_compaction) {
        expect(Object.keys(params.tools)).toEqual(['complete_compaction'])
        expect(params.model).toBe(baseTemplate.model)
        if (typeof compactionInput === 'function') compactionInput()
        yield {
          ...createToolCallChunk('complete_compaction', {}),
          input: compactionInput,
        } as ReturnType<typeof createToolCallChunk>
        return promptSuccess('compaction-message-id')
      }
      seenMessages.push(params.messages)
      yield { type: 'text' as const, text: 'ok' }
      yield createToolCallChunk('end_turn', {})
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
      },
      prompt,
      spawnParams: undefined,
      fingerprintId: 'test-fingerprint',
      fileContext: mockFileContext,
      userId,
      clientSessionId: 'test-session',
      ancestorRunIds: [],
      onResponseChunk: () => {},
      signal: new AbortController().signal,
    } as any)
  }

  beforeEach(() => {
    seenMessages = []
    compactionInput = defaultCompactionInput
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

  /** A user `usesDeterministicCompaction` puts on the mechanical pass. */
  const cohortUser = () => {
    let userId = ''
    for (let i = 0; !usesDeterministicCompaction(userId); i++)
      userId = `cohort-user-${i}`
    return userId
  }

  it('runs the model handoff for the test user, who is in the model cohort', () => {
    // Every model-path case below depends on this; at 100% the handoff is gone.
    expect(usesDeterministicCompaction(TEST_USER_ID)).toBe(false)
  })

  it('compacts mechanically at the context limit for the deterministic cohort', async () => {
    const userId = cohortUser()
    const logged: unknown[] = []
    const result = await runLoop(
      overBudget,
      idleHistory(0),
      undefined,
      logged,
      userId,
    )
    expect(result.output.type).not.toBe('error')
    // The turn's own request only: no `complete_compaction` call.
    expect(runtimeImpl.promptAiSdkStream).toHaveBeenCalledTimes(1)
    const sent = seenMessages[0].map(textOf).join('\n')
    expect(sent).toContain('<conversation_summary>')
    expect(sent).toContain('the live question')
    expect(
      logged.filter(
        (data) =>
          (data as { axiomEvent?: string }).axiomEvent ===
          'context_compaction.followup',
      ),
    ).toEqual([
      expect.objectContaining({
        mode: 'mechanical',
        trigger_reason: 'context_limit',
      }),
    ])
  })

  it('leaves the history alone when the agent has not opted in', async () => {
    await runLoop(baseTemplate, idleHistory(120))

    const sent = seenMessages[0].map(textOf).join('\n')
    expect(sent).toContain('DISTINCTIVE PRIOR ANSWER')
    expect(sent).not.toContain('<conversation_summary>')
  })

  it('manual compaction ends after its dedicated tool and preserves the live request', async () => {
    const result = await runLoop(baseTemplate, idleHistory(0), '/compact')
    expect(result.output.type).not.toBe('error')
    expect(seenMessages).toHaveLength(0)
    expect(runtimeImpl.promptAiSdkStream).toHaveBeenCalledTimes(1)
    const history = result.agentState.messageHistory.map(textOf).join('\n')
    expect(history).toContain('the live question')
    expect(history).toContain('<conversation_summary>')
    expect(history).not.toContain('/compact')
  })

  // Regression: on 2026-09-23 a Freebuff Cloud run failed with
  // `Agent run error: [{"expected":"object","code":"invalid_type",...}] ZodError
  // at compactWithModel`. An argument object that fails the tool schema reaches
  // the runtime as a STRING (the AI SDK's `invalid` tool call), and a strict
  // `.parse` on it threw straight out of the agent loop.
  it('accepts a double-encoded compaction summary instead of failing the run', async () => {
    // What the AI SDK hands over for a model that double-encoded its
    // arguments: the outer layer parsed, the object still a JSON string.
    compactionInput = JSON.stringify({
      summary: 'DOUBLE ENCODED HANDOFF for the live question.',
    })
    const result = await runLoop(baseTemplate, idleHistory(0), '/compact')
    expect(result.output.type).not.toBe('error')
    const history = result.agentState.messageHistory.map(textOf).join('\n')
    expect(history).toContain('DOUBLE ENCODED HANDOFF')
    expect(history).toContain('the live question')
  })

  // The idle trigger is mechanical, so these two reach the summarizer through
  // the context limit: a 4k window under a ~21k-token history.
  const overBudget = {
    ...baseTemplate,
    compactContext: { maxContextLength: 4096, cacheExpiryMs: null },
  }

  it('falls back to mechanical compaction when the summary is unusable', async () => {
    // Arguments cut off by the output cap: JSON that never closes.
    compactionInput = '{"summary": "the first request was about'
    const result = await runLoop(overBudget, idleHistory(0))
    expect(result.output.type).not.toBe('error')
    expect(runtimeImpl.promptAiSdkStream).toHaveBeenCalledTimes(2)
    const sent = seenMessages[0].map(textOf).join('\n')
    expect(sent).toContain('<conversation_summary>')
    expect(sent).toContain('the live question')
    expect(sent).not.toContain('the first request was about')
    expect(JSON.stringify(seenMessages[0])).not.toContain(
      'BULKY FILE BODY '.repeat(50),
    )
  })

  it('compacts mechanically on the idle trigger in the cohort: no summarizer request', async () => {
    const logged: unknown[] = []
    const result = await runLoop(
      { ...baseTemplate, compactContext: { cacheExpiryMinTokens: null } },
      idleHistory(120),
      undefined,
      logged,
      cohortUser(),
    )
    expect(result.output.type).not.toBe('error')
    // One request, the turn itself; never a `complete_compaction` call.
    expect(runtimeImpl.promptAiSdkStream).toHaveBeenCalledTimes(1)
    const sent = seenMessages[0].map(textOf).join('\n')
    expect(sent).toContain('<conversation_summary>')
    expect(sent).toContain('inspected files: big.ts')
    expect(JSON.stringify(seenMessages[0])).not.toContain(
      'BULKY FILE BODY '.repeat(50),
    )
    const events = (name: string) =>
      logged.filter(
        (data) => (data as { axiomEvent?: string }).axiomEvent === name,
      )
    expect(events('model_compaction.completed')).toEqual([])
    expect(events('context_compaction_completed')).toEqual([
      expect.objectContaining({ trigger_reason: 'cache_expiry' }),
    ])
    expect(events('context_compaction.followup')).toEqual([
      expect.objectContaining({
        mode: 'mechanical',
        trigger_reason: 'cache_expiry',
        ended_by: 'run_end',
        elided_read_paths: 1,
        read_calls_after: 0,
        reread_paths: 0,
        tool_calls_after: 1,
      }),
    ])
  })

  it('a summarizer that throws never fails the turn', async () => {
    compactionInput = () => {
      throw new Error('provider exploded mid-compaction')
    }
    const result = await runLoop(overBudget, idleHistory(0))
    expect(result.output.type).not.toBe('error')
    expect(seenMessages).toHaveLength(1)
    expect(seenMessages[0].map(textOf).join('\n')).toContain(
      'the live question',
    )
  })

  it('leaves a small conversation alone however cold the cache is', async () => {
    // The default size floor: compaction always costs detail, and there is
    // nothing here worth reclaiming.
    await runLoop({ ...baseTemplate, compactContext: true }, idleHistory(600))

    const sent = seenMessages[0].map(textOf).join('\n')
    expect(sent).toContain('DISTINCTIVE PRIOR ANSWER')
    expect(sent).not.toContain('<conversation_summary>')
  })

  it('leaves the history alone while the cache is still warm', async () => {
    await runLoop(
      { ...baseTemplate, compactContext: { cacheExpiryMinTokens: null } },
      idleHistory(5),
    )

    const sent = seenMessages[0].map(textOf).join('\n')
    expect(sent).toContain('DISTINCTIVE PRIOR ANSWER')
    expect(sent).not.toContain('<conversation_summary>')
  })

  it('compacts before the model call once the cache has gone cold', async () => {
    const result = await runLoop(
      { ...baseTemplate, compactContext: { cacheExpiryMinTokens: null } },
      idleHistory(120),
    )

    // The model must see the rewritten history, not the original.
    const sent = seenMessages[0].map(textOf).join('\n')
    expect(sent).toContain('<conversation_summary>')
    expect(sent).toContain('the first request')
    expect(sent).toContain('the live question')

    // ...and the state the caller gets back is the compacted one.
    const history = result.agentState.messageHistory.map(textOf).join('\n')
    expect(history).toContain('<conversation_summary>')
  })

  it('uses a custom model input budget rather than the hosted model default', async () => {
    const history = idleHistory(0)
    history.splice(1, 0, {
      ...assistantMessage('old context '.repeat(2000)),
      sentAt: 1_000_000,
    })
    await runLoop(
      {
        ...baseTemplate,
        compactContext: { maxContextLength: 4096, cacheExpiryMs: null },
      },
      history,
    )
    expect(seenMessages[0].map(textOf).join('\n')).toContain(
      '<conversation_summary>',
    )
    expect(seenMessages[0].map(textOf).join('\n')).toContain(
      'the live question',
    )
  })

  it('honours a per-agent cache TTL', async () => {
    await runLoop(
      {
        ...baseTemplate,
        compactContext: {
          cacheExpiryMs: 60 * MINUTE,
          cacheExpiryMinTokens: null,
        },
      },
      idleHistory(30),
    )
    expect(seenMessages[0].map(textOf).join('\n')).not.toContain(
      '<conversation_summary>',
    )

    seenMessages = []
    await runLoop(
      {
        ...baseTemplate,
        compactContext: {
          cacheExpiryMs: 10 * MINUTE,
          cacheExpiryMinTokens: null,
        },
      },
      idleHistory(30),
    )
    expect(seenMessages[0].map(textOf).join('\n')).toContain(
      '<conversation_summary>',
    )
  })

  it('compacts once, not on every step of the turn', async () => {
    // A cache-expiry compaction that re-fired each step would throw away the
    // work the agent did in the step before it. Compaction restamps the live
    // prompt and drops the assistant messages ahead of it, which is what makes
    // the gap unmeasurable afterwards — prove it against the real loop.
    let call = 0
    const template = {
      ...baseTemplate,
      toolNames: ['read_files', 'end_turn'],
      compactContext: { cacheExpiryMinTokens: null },
    } as AgentTemplate

    const {
      agentTemplate: _,
      localAgentTemplates: __,
      ...baseRuntimeParams
    } = createTestAgentRuntimeParams()
    runtimeImpl = { ...baseRuntimeParams }
    runtimeImpl.promptAiSdkStream = mock(async function* (params: any) {
      if (params.tools.complete_compaction) {
        yield createToolCallChunk('complete_compaction', {
          summary: 'the first request: DISTINCTIVE PRIOR ANSWER.',
        })
        return promptSuccess('compaction-message-id')
      }
      seenMessages.push(params.messages)
      call++
      yield { type: 'text' as const, text: `STEP ${call} OUTPUT` }
      // A real tool call keeps the loop going; end the turn on the third pass.
      yield call >= 3
        ? createToolCallChunk('end_turn', {})
        : createToolCallChunk('read_files', { paths: [`file${call}.txt`] })
      return promptSuccess('mock-message-id')
    })

    const sessionState = getInitialSessionState(mockFileContext)
    await loopAgentSteps({
      ...runtimeImpl,
      agentType: template.id,
      localAgentTemplates: { [template.id]: template },
      repoId: undefined,
      repoUrl: undefined,
      userInputId: 'test-user-input',
      agentState: {
        ...sessionState.mainAgentState,
        agentId: 'test-agent-id',
        messageHistory: idleHistory(120),
        output: undefined,
        stepsRemaining: 5,
      },
      prompt: undefined,
      spawnParams: undefined,
      fingerprintId: 'test-fingerprint',
      fileContext: mockFileContext,
      userId: TEST_USER_ID,
      clientSessionId: 'test-session',
      ancestorRunIds: [],
      onResponseChunk: () => {},
      signal: new AbortController().signal,
    } as any)

    expect(seenMessages.length).toBeGreaterThanOrEqual(3)

    // Exactly one compaction: the summary appears from step 1 on, and each
    // later step still carries the earlier steps' output rather than a fresh
    // memory blob that swallowed them.
    const summaryCounts = seenMessages.map(
      (messages) =>
        messages.filter((message) =>
          textOf(message).includes('<conversation_summary>'),
        ).length,
    )
    expect(summaryCounts.every((count) => count === 1)).toBe(true)

    const lastStep = seenMessages[seenMessages.length - 1]
      .map(textOf)
      .join('\n')
    expect(lastStep).toContain('STEP 1 OUTPUT')
    expect(lastStep).toContain('STEP 2 OUTPUT')
    // The live prompt is still a real message, never folded into the memory.
    expect(lastStep).toContain('the live question')
  })

  it('survives agent-definition validation, which strips unknown keys', async () => {
    // DynamicAgentDefinitionSchema is a non-passthrough z.object, so a field
    // missing from it is silently dropped and the flag never reaches here.
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

    // The boolean form and the opt-out both round-trip too.
    expect(
      validateSingleAgent({
        template: { ...definition, compactContext: true },
      }).agentTemplate?.compactContext,
    ).toBe(true)
    expect(
      validateSingleAgent({
        template: { ...definition, compactContext: { cacheExpiryMs: null } },
      }).agentTemplate?.compactContext,
    ).toEqual({ cacheExpiryMs: null })

    // A typo in the option name is rejected rather than silently ignored.
    expect(
      validateSingleAgent({
        template: { ...definition, compactContext: { cacheExpiry: 1000 } },
      }).success,
    ).toBe(false)
  })

  // Desktop BYOK, 2026-09-24..27 ("compacts every 3-5 turns"): a 32k-default
  // connection's budget is 25,804 tokens and its threshold 20,643, while the
  // prompt and tool catalog take ~15k. Compacting at the threshold landed
  // right back under it, so the next read or two compacted again.
  describe('a small window under a large fixed prompt', () => {
    const smallWindow = {
      ...baseTemplate,
      systemPrompt: 'Follow the project conventions carefully. '.repeat(1_100),
      compactContext: { maxContextLength: 25_804, cacheExpiryMs: null },
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
      // ~15k fixed + ~6k of reads: over the 20,643 threshold, under the budget.
      const result = await runLoop(smallWindow, withReads(4))
      expect(runtimeImpl.promptAiSdkStream).toHaveBeenCalledTimes(1)
      const sent = JSON.stringify(seenMessages[0])
      expect(sent.includes('<conversation_summary>')).toBe(false)
      expect(sent.includes('READ 0 BODY')).toBe(true)
      expect(result.output.type).not.toBe('error')
    })

    it('still compacts at the hard budget', async () => {
      const result = await runLoop(smallWindow, withReads(8))
      const sent = JSON.stringify(seenMessages[0])
      expect(sent.includes('<conversation_summary>')).toBe(true)
      expect(sent.includes('review the files')).toBe(true)
      expect(result.output.type).not.toBe('error')
    })
  })

  it('a null TTL opts out of the opportunistic trigger', async () => {
    await runLoop(
      { ...baseTemplate, compactContext: { cacheExpiryMs: null } },
      idleHistory(600),
    )
    expect(seenMessages[0].map(textOf).join('\n')).not.toContain(
      '<conversation_summary>',
    )
  })
})
