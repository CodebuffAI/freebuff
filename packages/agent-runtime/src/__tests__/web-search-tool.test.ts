import * as bigquery from '@codebuff/bigquery'
import * as analytics from '@codebuff/common/analytics'
import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getToolCallString } from '@codebuff/common/tools/utils'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { success } from '@codebuff/common/util/error'
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
  'localAgentTemplates' | 'agentState' | 'prompt'
>
function mockAgentStream(content: string | string[]) {
  runAgentStepBaseParams.promptAiSdkStream = async function* ({}) {
    if (typeof content === 'string') {
      content = [content]
    }
    for (const chunk of content) {
      yield { type: 'text' as const, text: chunk }
    }
    return 'mock-message-id'
  }
}

describe('web_search tool with researcher agent (via web API facade)', () => {
  beforeAll(() => {
    disableLiveUserInputCheck()
  })

  beforeEach(() => {
    agentRuntimeImpl = {
      ...TEST_AGENT_RUNTIME_IMPL,
      consumeCreditsWithFallback: async () => {
        return success({ chargedToOrganization: false })
      },
    }
    runAgentStepBaseParams = {
      ...agentRuntimeImpl,

      additionalToolDefinitions: () => Promise.resolve({}),
      agentType: 'researcher',
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: mockFileContext,
      fingerprintId: 'test-fingerprint',
      onResponseChunk: () => {},
      repoId: undefined,
      repoUrl: undefined,
      runId: 'test-run-id',
      signal: new AbortController().signal,
      spawnParams: undefined,
      system: 'Test system prompt',
      tools: {},
      userId: TEST_USER_ID,
      userInputId: 'test-input',
    }

    // Mock analytics and tracing
    spyOn(analytics, 'initAnalytics').mockImplementation(() => {})
    analytics.initAnalytics(runAgentStepBaseParams)
    spyOn(analytics, 'trackEvent').mockImplementation(() => {})
    spyOn(bigquery, 'insertTrace').mockImplementation(() =>
      Promise.resolve(true),
    )

    // Mock websocket actions
    runAgentStepBaseParams.requestFiles = async () => ({})
    runAgentStepBaseParams.requestOptionalFile = async () => null
    runAgentStepBaseParams.requestToolCall = async () => ({
      output: [{ type: 'json', value: 'Tool call success' }],
    })

    // Mock LLM APIs
    runAgentStepBaseParams.promptAiSdk = async function () {
      return 'Test response'
    }
  })

  afterEach(() => {
    mock.restore()
  })

  const mockFileContextWithAgents = {
    ...mockFileContext,
    agentTemplates: { researcher: researcherAgent },
  }

  test('should call web facade when web_search tool is used', async () => {
    const mockSearchResult = 'Test search result'
    const spy = spyOn(webApi, 'callWebSearchAPI').mockResolvedValue({
      result: mockSearchResult,
    })

    const mockResponse =
      getToolCallString('web_search', { query: 'test query' }) +
      getToolCallString('end_turn', {})

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
      localAgentTemplates: agentTemplates,
      agentState,
      prompt: 'Search for test',
    })

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'test query', depth: 'standard' }),
    )
  })

  test('should successfully perform web search with basic query', async () => {
    const mockSearchResult =
      'Next.js 15 introduces features and React 19 support.'
    spyOn(webApi, 'callWebSearchAPI').mockResolvedValue({
      result: mockSearchResult,
    })

    const mockResponse =
      getToolCallString('web_search', { query: 'Next.js 15 new features' }) +
      getToolCallString('end_turn', {})

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
      localAgentTemplates: agentTemplates,
      agentState,
      prompt: 'Search for Next.js 15 new features',
    })

    const toolMsgs = newAgentState.messageHistory.filter(
      (m) => m.role === 'tool' && m.toolName === 'web_search',
    )
    expect(toolMsgs.length).toBeGreaterThan(0)
    expect(JSON.stringify(toolMsgs[toolMsgs.length - 1].content)).toContain(
      mockSearchResult,
    )
  })

  test('should handle custom depth parameter', async () => {
    spyOn(webApi, 'callWebSearchAPI').mockResolvedValue({
      result: 'Deep result',
    })

    const mockResponse =
      getToolCallString('web_search', {
        query: 'RSC tutorial',
        depth: 'deep',
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
      localAgentTemplates: agentTemplates,
      agentState,
      prompt: 'Search deep',
    })

    expect(webApi.callWebSearchAPI).toHaveBeenCalledWith(
      expect.objectContaining({ depth: 'deep' }),
    )
  })

  test('should surface no-results as error in tool output', async () => {
    const msg = 'No search results found for "very obscure"'
    spyOn(webApi, 'callWebSearchAPI').mockResolvedValue({ error: msg })

    const mockResponse =
      getToolCallString('web_search', { query: 'very obscure' }) +
      getToolCallString('end_turn', {})

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
      localAgentTemplates: agentTemplates,
      agentState,
      prompt: 'Search nothing',
    })

    const toolMsgs = newAgentState.messageHistory.filter(
      (m) => m.role === 'tool' && m.toolName === 'web_search',
    )
    expect(toolMsgs.length).toBeGreaterThan(0)
    const last = JSON.stringify(toolMsgs[toolMsgs.length - 1].content)
    expect(last).toContain('error')
    expect(last).toContain('No search results')
  })

  test('should handle API errors gracefully', async () => {
    spyOn(webApi, 'callWebSearchAPI').mockResolvedValue({
      error: 'Linkup API timeout',
    })

    const mockResponse =
      getToolCallString('web_search', { query: 'test query' }) +
      getToolCallString('end_turn', {})

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
      localAgentTemplates: agentTemplates,
      agentState,
      prompt: 'Search for something',
    })

    const toolMsgs = newAgentState.messageHistory.filter(
      (m) => m.role === 'tool' && m.toolName === 'web_search',
    )
    expect(toolMsgs.length).toBeGreaterThan(0)
    const last = JSON.stringify(toolMsgs[toolMsgs.length - 1].content)
    expect(last).toContain('errorMessage')
    expect(last).toContain('Linkup API timeout')
  })

  test('should handle non-Error exceptions from facade', async () => {
    spyOn(webApi, 'callWebSearchAPI').mockImplementation(async () => {
      throw 'String error'
    })

    const mockResponse =
      getToolCallString('web_search', { query: 'test query' }) +
      getToolCallString('end_turn', {})

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
      localAgentTemplates: agentTemplates,
      agentState,
      prompt: 'Search for something',
    })

    const toolMsgs = newAgentState.messageHistory.filter(
      (m) => m.role === 'tool' && m.toolName === 'web_search',
    )
    expect(toolMsgs.length).toBeGreaterThan(0)
    const last = JSON.stringify(toolMsgs[toolMsgs.length - 1].content)
    expect(last).toContain('Error performing web search')
    expect(last).toContain('Unknown error')
  })

  test('should format search results correctly', async () => {
    const mockSearchResult = 'This is the first search result content.'
    spyOn(webApi, 'callWebSearchAPI').mockResolvedValue({
      result: mockSearchResult,
    })

    const mockResponse =
      getToolCallString('web_search', { query: 'test formatting' }) +
      getToolCallString('end_turn', {})

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
      localAgentTemplates: agentTemplates,
      agentState,
      prompt: 'Test search result formatting',
    })

    const toolMsgs = newAgentState.messageHistory.filter(
      (m) => m.role === 'tool' && m.toolName === 'web_search',
    )
    expect(toolMsgs.length).toBeGreaterThan(0)
    expect(JSON.stringify(toolMsgs[toolMsgs.length - 1].content)).toContain(
      mockSearchResult,
    )
  })

  test('should track credits used from web search API in agent state', async () => {
    const mockSearchResult = 'Search result content'
    const mockCreditsUsed = 2 // Standard search with profit margin
    spyOn(webApi, 'callWebSearchAPI').mockResolvedValue({
      result: mockSearchResult,
      creditsUsed: mockCreditsUsed,
    })

    const mockResponse =
      getToolCallString('web_search', { query: 'test query' }) +
      getToolCallString('end_turn', {})

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
      localAgentTemplates: agentTemplates,
      agentState,
      prompt: 'Search for test',
    })

    // Verify that the credits from the web search API were added to agent state
    expect(newAgentState.creditsUsed).toBeGreaterThanOrEqual(
      initialCredits + mockCreditsUsed,
    )
    expect(newAgentState.directCreditsUsed).toBeGreaterThanOrEqual(
      mockCreditsUsed,
    )
  })
})
