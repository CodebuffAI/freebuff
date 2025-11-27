import * as bigquery from '@codebuff/bigquery'
import * as analytics from '@codebuff/common/analytics'
import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getToolCallString } from '@codebuff/common/tools/utils'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'

import { disableLiveUserInputCheck } from '../live-user-inputs'
import { mockFileContext } from './test-utils'
import researcherAgent from '../../../../.agents/researcher/researcher'
import * as webApi from '../llm-api/codebuff-web-api'
import { runAgentStep } from '../run-agent-step'
import { assembleLocalAgentTemplates } from '../templates/agent-registry'

import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
} from '@codebuff/common/types/contracts/agent-runtime'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'

let agentRuntimeImpl: AgentRuntimeDeps & AgentRuntimeScopedDeps
let runAgentStepBaseParams: ParamsExcluding<
  typeof runAgentStep,
  'fileContext' | 'localAgentTemplates' | 'agentState' | 'prompt'
>

function mockAgentStream(content: string | string[]) {
  const mockPromptAiSdkStream = async function* ({}) {
    if (typeof content === 'string') {
      content = [content]
    }
    for (const chunk of content) {
      yield { type: 'text' as const, text: chunk }
    }
    return 'mock-message-id'
  }
  agentRuntimeImpl.promptAiSdkStream = mockPromptAiSdkStream
  runAgentStepBaseParams.promptAiSdkStream = mockPromptAiSdkStream
}

describe('read_docs tool with researcher agent (via web API facade)', () => {
  beforeAll(() => {
    disableLiveUserInputCheck()
  })

  beforeEach(() => {
    agentRuntimeImpl = { ...TEST_AGENT_RUNTIME_IMPL, sendAction: () => {} }

    spyOn(analytics, 'initAnalytics').mockImplementation(() => {})
    analytics.initAnalytics(agentRuntimeImpl)
    spyOn(analytics, 'trackEvent').mockImplementation(() => {})
    spyOn(analytics, 'flushAnalytics').mockImplementation(() =>
      Promise.resolve(),
    )
    spyOn(bigquery, 'insertTrace').mockImplementation(() =>
      Promise.resolve(true),
    )

    agentRuntimeImpl.requestFiles = async () => ({})
    agentRuntimeImpl.requestOptionalFile = async () => null
    agentRuntimeImpl.requestToolCall = async () => ({
      output: [{ type: 'json', value: 'Tool call success' }],
    })

    runAgentStepBaseParams = {
      ...agentRuntimeImpl,
      additionalToolDefinitions: () => Promise.resolve({}),
      runId: 'test-run-id',
      ancestorRunIds: [],
      repoId: undefined,
      repoUrl: undefined,
      system: 'Test system prompt',
      userId: TEST_USER_ID,
      userInputId: 'test-input',
      clientSessionId: 'test-session',
      fingerprintId: 'test-fingerprint',
      onResponseChunk: () => {},
      agentType: 'researcher',
      spawnParams: undefined,
      signal: new AbortController().signal,
      tools: {},
    }
  })

  afterEach(() => {
    mock.restore()
  })

  const mockFileContextWithAgents = {
    ...mockFileContext,
    agentTemplates: { researcher: researcherAgent },
  }

  test('should successfully fetch documentation with basic query', async () => {
    const mockDocumentation =
      'React is a JavaScript library for building user interfaces...'
    const spy = spyOn(webApi, 'callDocsSearchAPI').mockResolvedValue({
      documentation: mockDocumentation,
    })

    const mockResponse =
      getToolCallString('read_docs', {
        libraryTitle: 'React',
        topic: 'hooks',
      }) + getToolCallString('end_turn', {})

    mockAgentStream(mockResponse)

    const sessionState = getInitialSessionState(mockFileContextWithAgents)
    const agentState = {
      ...sessionState.mainAgentState,
      agentType: 'researcher' as const,
    }
    const { agentTemplates } = assembleLocalAgentTemplates({
      ...agentRuntimeImpl,
      fileContext: mockFileContextWithAgents,
    })

    const { agentState: newAgentState } = await runAgentStep({
      ...runAgentStepBaseParams,
      fileContext: mockFileContextWithAgents,
      localAgentTemplates: agentTemplates,
      agentState,
      prompt: 'Get React documentation',
    })

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ libraryTitle: 'React', topic: 'hooks' }),
    )

    const toolMsgs = newAgentState.messageHistory.filter(
      (m) => m.role === 'tool' && m.toolName === 'read_docs',
    )
    expect(toolMsgs.length).toBeGreaterThan(0)
    expect(JSON.stringify(toolMsgs[toolMsgs.length - 1].content)).toContain(
      JSON.stringify(mockDocumentation).slice(1, -1),
    )
  }, 10000)

  test('should fetch documentation with topic and max_tokens', async () => {
    const mockDocumentation =
      'React hooks allow you to use state and other React features...'
    const spy = spyOn(webApi, 'callDocsSearchAPI').mockResolvedValue({
      documentation: mockDocumentation,
    })

    const mockResponse =
      getToolCallString('read_docs', {
        libraryTitle: 'React',
        topic: 'hooks',
        max_tokens: 5000,
      }) + getToolCallString('end_turn', {})

    mockAgentStream(mockResponse)

    const sessionState = getInitialSessionState(mockFileContextWithAgents)
    const agentState = {
      ...sessionState.mainAgentState,
      agentType: 'researcher' as const,
    }
    const { agentTemplates } = assembleLocalAgentTemplates({
      ...agentRuntimeImpl,
      fileContext: mockFileContextWithAgents,
    })

    await runAgentStep({
      ...runAgentStepBaseParams,
      fileContext: mockFileContextWithAgents,
      localAgentTemplates: agentTemplates,
      agentState,
      prompt: 'Get React hooks documentation',
    })

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        libraryTitle: 'React',
        topic: 'hooks',
        maxTokens: 5000,
      }),
    )
  }, 10000)

  test('should handle case when no documentation is found', async () => {
    const msg = 'No documentation found for "NonExistentLibrary"'
    spyOn(webApi, 'callDocsSearchAPI').mockResolvedValue({ error: msg })

    const mockResponse =
      getToolCallString('read_docs', {
        libraryTitle: 'NonExistentLibrary',
        topic: 'blah',
      }) + getToolCallString('end_turn', {})

    mockAgentStream(mockResponse)

    const sessionState = getInitialSessionState(mockFileContextWithAgents)
    const agentState = {
      ...sessionState.mainAgentState,
      agentType: 'researcher' as const,
    }
    const { agentTemplates } = assembleLocalAgentTemplates({
      ...agentRuntimeImpl,
      fileContext: mockFileContextWithAgents,
    })

    const { agentState: newAgentState } = await runAgentStep({
      ...runAgentStepBaseParams,
      fileContext: mockFileContextWithAgents,
      localAgentTemplates: agentTemplates,
      agentState,
      prompt: 'Get documentation for NonExistentLibrary',
    })

    const toolMsgs = newAgentState.messageHistory.filter(
      (m) => m.role === 'tool' && m.toolName === 'read_docs',
    )
    expect(toolMsgs.length).toBeGreaterThan(0)
    const last = JSON.stringify(toolMsgs[toolMsgs.length - 1].content)
    expect(last).toContain('No documentation found for')
  }, 10000)

  test('should handle API errors gracefully', async () => {
    spyOn(webApi, 'callDocsSearchAPI').mockResolvedValue({
      error: 'Network timeout',
    })

    const mockResponse =
      getToolCallString('read_docs', {
        libraryTitle: 'React',
        topic: 'hooks',
      }) + getToolCallString('end_turn', {})

    mockAgentStream(mockResponse)

    const sessionState = getInitialSessionState(mockFileContextWithAgents)
    const agentState = {
      ...sessionState.mainAgentState,
      agentType: 'researcher' as const,
    }
    const { agentTemplates } = assembleLocalAgentTemplates({
      ...agentRuntimeImpl,
      fileContext: mockFileContextWithAgents,
    })

    const { agentState: newAgentState } = await runAgentStep({
      ...runAgentStepBaseParams,
      fileContext: mockFileContextWithAgents,
      localAgentTemplates: agentTemplates,
      agentState,
      prompt: 'Get React documentation',
    })

    const toolMsgs = newAgentState.messageHistory.filter(
      (m) => m.role === 'tool' && m.toolName === 'read_docs',
    )
    expect(toolMsgs.length).toBeGreaterThan(0)
    const last = JSON.stringify(toolMsgs[toolMsgs.length - 1].content)
    expect(last).toContain('Error fetching documentation for')
    expect(last).toContain('Network timeout')
  }, 10000)

  test('should include topic in error message when specified', async () => {
    spyOn(webApi, 'callDocsSearchAPI').mockResolvedValue({ error: 'No docs' })

    const mockResponse =
      getToolCallString('read_docs', {
        libraryTitle: 'React',
        topic: 'server-components',
      }) + getToolCallString('end_turn', {})

    mockAgentStream(mockResponse)

    const sessionState = getInitialSessionState(mockFileContextWithAgents)
    const agentState = {
      ...sessionState.mainAgentState,
      agentType: 'researcher' as const,
    }
    const { agentTemplates } = assembleLocalAgentTemplates({
      ...agentRuntimeImpl,
      fileContext: mockFileContextWithAgents,
    })

    const { agentState: newAgentState } = await runAgentStep({
      ...runAgentStepBaseParams,
      fileContext: mockFileContextWithAgents,
      localAgentTemplates: agentTemplates,
      agentState,
      prompt: 'Get React server components documentation',
    })

    const toolMsgs = newAgentState.messageHistory.filter(
      (m) => m.role === 'tool' && m.toolName === 'read_docs',
    )
    expect(toolMsgs.length).toBeGreaterThan(0)
    const last = JSON.stringify(toolMsgs[toolMsgs.length - 1].content)
    expect(last).toContain('errorMessage')
    expect(last).toContain('No docs')
  }, 10000)

  test('should handle non-Error exceptions', async () => {
    spyOn(webApi, 'callDocsSearchAPI').mockImplementation(async () => {
      throw 'String error'
    })

    const mockResponse =
      getToolCallString('read_docs', {
        libraryTitle: 'React',
        topic: 'hooks',
      }) + getToolCallString('end_turn', {})

    mockAgentStream(mockResponse)

    const sessionState = getInitialSessionState(mockFileContextWithAgents)
    const agentState = {
      ...sessionState.mainAgentState,
      agentType: 'researcher' as const,
    }
    const { agentTemplates } = assembleLocalAgentTemplates({
      ...agentRuntimeImpl,
      fileContext: mockFileContextWithAgents,
    })

    const { agentState: newAgentState } = await runAgentStep({
      ...runAgentStepBaseParams,
      fileContext: mockFileContextWithAgents,
      localAgentTemplates: agentTemplates,
      agentState,
      prompt: 'Get React documentation',
    })

    const toolMsgs = newAgentState.messageHistory.filter(
      (m) => m.role === 'tool' && m.toolName === 'read_docs',
    )
    expect(toolMsgs.length).toBeGreaterThan(0)
    const last = JSON.stringify(toolMsgs[toolMsgs.length - 1].content)
    expect(last).toContain('Error fetching documentation for')
    expect(last).toContain('Unknown error')
  }, 10000)

  test('should track credits used from docs search API in agent state', async () => {
    const mockDocumentation = 'React documentation content'
    const mockCreditsUsed = 2 // Flat 1 credit + profit margin
    spyOn(webApi, 'callDocsSearchAPI').mockResolvedValue({
      documentation: mockDocumentation,
      creditsUsed: mockCreditsUsed,
    })

    const mockResponse =
      getToolCallString('read_docs', {
        libraryTitle: 'React',
        topic: 'hooks',
      }) + getToolCallString('end_turn', {})

    mockAgentStream(mockResponse)

    const sessionState = getInitialSessionState(mockFileContextWithAgents)
    const agentState = {
      ...sessionState.mainAgentState,
      agentType: 'researcher' as const,
    }
    const { agentTemplates } = assembleLocalAgentTemplates({
      ...agentRuntimeImpl,
      fileContext: mockFileContextWithAgents,
    })

    const initialCredits = agentState.creditsUsed

    const { agentState: newAgentState } = await runAgentStep({
      ...runAgentStepBaseParams,
      fileContext: mockFileContextWithAgents,
      localAgentTemplates: agentTemplates,
      agentState,
      prompt: 'Get React documentation',
    })

    // Verify that the credits from the docs search API were added to agent state
    expect(newAgentState.creditsUsed).toBeGreaterThanOrEqual(
      initialCredits + mockCreditsUsed,
    )
    expect(newAgentState.directCreditsUsed).toBeGreaterThanOrEqual(
      mockCreditsUsed,
    )
  }, 10000)
})
