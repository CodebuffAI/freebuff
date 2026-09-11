/**
 * End-to-end cover for the `compactContext` flag: compact-history.test.ts
 * proves the algorithm, and this proves the runtime actually reaches it and
 * that the rewritten history is what the model sees.
 */

import * as analytics from '@codebuff/common/analytics'
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

  /**
   * A conversation whose last assistant message landed `gapMinutes` before the
   * live user prompt — i.e. the prompt cache has had that long to expire.
   */
  const idleHistory = (gapMinutes: number): Message[] => [
    { ...userMessage('the first request'), sentAt: 1_000_000 },
    {
      ...assistantMessage('DISTINCTIVE PRIOR ANSWER'),
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
  ) => {
    const {
      agentTemplate: _,
      localAgentTemplates: __,
      ...baseRuntimeParams
    } = createTestAgentRuntimeParams()

    runtimeImpl = { ...baseRuntimeParams }
    runtimeImpl.promptAiSdkStream = mock(async function* (params: any) {
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
  }

  beforeEach(() => {
    seenMessages = []
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

    const sent = seenMessages[0].map(textOf).join('\n')
    expect(sent).toContain('DISTINCTIVE PRIOR ANSWER')
    expect(sent).not.toContain('<conversation_summary>')
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
        compactContext: { maxContextLength: 1024, cacheExpiryMs: null },
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
