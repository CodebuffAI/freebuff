import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import {
  assistantMessage,
  systemMessage,
  userMessage,
} from '@codebuff/common/util/messages'
import {
  describe,
  expect,
  it,
  beforeEach,
  afterEach,
  mock,
  spyOn,
} from 'bun:test'

import { mockFileContext } from './test-utils'
import * as runAgentStep from '../run-agent-step'
import { handleSpawnAgents } from '../tools/handlers/tool/spawn-agents'

import type { CodebuffToolCall } from '@codebuff/common/tools/list'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'

describe('Spawn Agents Message History', () => {
  let mockSendSubagentChunk: any
  let mockLoopAgentSteps: any
  let capturedSubAgentState: any

  let handleSpawnAgentsBaseParams: ParamsExcluding<
    typeof handleSpawnAgents,
    'agentState' | 'agentTemplate' | 'localAgentTemplates' | 'toolCall'
  >

  beforeEach(() => {
    // Mock sendSubagentChunk
    mockSendSubagentChunk = mock(() => {})

    // Mock loopAgentSteps to capture the subAgentState
    mockLoopAgentSteps = spyOn(
      runAgentStep,
      'loopAgentSteps',
    ).mockImplementation(async (options) => {
      capturedSubAgentState = options.agentState
      return {
        agentState: {
          ...options.agentState,
          messageHistory: [
            ...options.agentState.messageHistory,
            assistantMessage('Mock agent response'),
          ],
        },
        output: { type: 'lastMessage', value: [assistantMessage('Mock agent response')] },
      }
    })

    handleSpawnAgentsBaseParams = {
      ...TEST_AGENT_RUNTIME_IMPL,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fingerprintId: 'test-fingerprint',
      fileContext: mockFileContext,
      repoId: undefined,
      repoUrl: undefined,
      previousToolCallFinished: Promise.resolve(),
      sendSubagentChunk: mockSendSubagentChunk,
      signal: new AbortController().signal,
      system: 'Test system prompt',
      userId: TEST_USER_ID,
      userInputId: 'test-input',
      writeToClient: () => {},
    }
  })

  afterEach(() => {
    mock.restore()
    capturedSubAgentState = undefined
  })

  const createMockAgent = (
    id: string,
    includeMessageHistory = true,
  ): AgentTemplate => ({
    id,
    displayName: `Mock ${id}`,
    outputMode: 'last_message' as const,
    inputSchema: {
      prompt: {
        safeParse: () => ({ success: true }),
      } as any,
    },
    spawnerPrompt: '',
    model: '',
    includeMessageHistory,
    inheritParentSystemPrompt: false,
    mcpServers: {},
    toolNames: [],
    spawnableAgents: ['child-agent'],
    systemPrompt: '',
    instructionsPrompt: '',
    stepPrompt: '',
  })

  const createSpawnToolCall = (
    agentType: string,
    prompt = 'test prompt',
  ): CodebuffToolCall<'spawn_agents'> => ({
    toolName: 'spawn_agents' as const,
    toolCallId: 'test-tool-call-id',
    input: {
      agents: [{ agent_type: agentType, prompt }],
    },
  })

  it('should include all messages from conversation history when includeMessageHistory is true', async () => {
    const parentAgent = createMockAgent('parent', true)
    const childAgent = createMockAgent('child-agent', true)
    const sessionState = getInitialSessionState(mockFileContext)
    const toolCall = createSpawnToolCall('child-agent')

    // Create mock messages including system message
    sessionState.mainAgentState.messageHistory = [
      systemMessage('This is the parent system prompt that should be excluded'),
      userMessage('Hello'),
      assistantMessage('Hi there!'),
      userMessage('How are you?'),
    ]

    await handleSpawnAgents({
      ...handleSpawnAgentsBaseParams,
      agentState: sessionState.mainAgentState,
      agentTemplate: parentAgent,
      localAgentTemplates: { 'child-agent': childAgent },
      toolCall,
    })

    // Verify that the spawned agent was called
    expect(mockLoopAgentSteps).toHaveBeenCalledTimes(1)

    // Verify that the subagent's message history contains the filtered messages
    // expireMessages filters based on timeToLive property, not role
    // Since the system message doesn't have timeToLive, it will be included
    expect(capturedSubAgentState.messageHistory).toHaveLength(4) // System + user + assistant messages

    // Verify system message is included (because it has no timeToLive property)
    const systemMessages = capturedSubAgentState.messageHistory.filter(
      (msg: any) => msg.role === 'system',
    )
    expect(systemMessages).toHaveLength(1)
    expect(systemMessages[0].content).toEqual([
      {
        type: 'text',
        text: 'This is the parent system prompt that should be excluded',
      },
    ])

    // Verify user and assistant messages are included
    expect(
      capturedSubAgentState.messageHistory.find(
        (msg: any) => msg.content[0]?.text === 'Hello',
      ),
    ).toBeTruthy()
    expect(
      capturedSubAgentState.messageHistory.find(
        (msg: any) => msg.content[0]?.text === 'Hi there!',
      ),
    ).toBeTruthy()
    expect(
      capturedSubAgentState.messageHistory.find(
        (msg: any) => msg.content[0]?.text === 'How are you?',
      ),
    ).toBeTruthy()
  })

  it('should not include conversation history when includeMessageHistory is false', async () => {
    const parentAgent = createMockAgent('parent', true)
    const childAgent = createMockAgent('child-agent', false) // includeMessageHistory = false
    const sessionState = getInitialSessionState(mockFileContext)
    const toolCall = createSpawnToolCall('child-agent')

    sessionState.mainAgentState.messageHistory = [
      systemMessage('System prompt'),
      userMessage('Hello'),
      assistantMessage('Hi there!'),
    ]

    await handleSpawnAgents({
      ...handleSpawnAgentsBaseParams,
      agentState: sessionState.mainAgentState,
      agentTemplate: parentAgent,
      localAgentTemplates: { 'child-agent': childAgent },
      toolCall,
    })

    // Verify that the subagent's message history is empty when includeMessageHistory is false
    expect(capturedSubAgentState.messageHistory).toHaveLength(0)
  })

  it('should handle empty message history gracefully', async () => {
    const parentAgent = createMockAgent('parent', true)
    const childAgent = createMockAgent('child-agent', true)
    const sessionState = getInitialSessionState(mockFileContext)
    const toolCall = createSpawnToolCall('child-agent')

    sessionState.mainAgentState.messageHistory = [] // Empty message history

    await handleSpawnAgents({
      ...handleSpawnAgentsBaseParams,
      agentState: sessionState.mainAgentState,
      agentTemplate: parentAgent,
      localAgentTemplates: { 'child-agent': childAgent },
      toolCall,
    })

    // Verify that the subagent's message history is empty when there are no messages to pass
    expect(capturedSubAgentState.messageHistory).toHaveLength(0)
  })

  it('should handle message history with only system messages', async () => {
    const parentAgent = createMockAgent('parent', true)
    const childAgent = createMockAgent('child-agent', true)
    const sessionState = getInitialSessionState(mockFileContext)
    const toolCall = createSpawnToolCall('child-agent')

    sessionState.mainAgentState.messageHistory = [
      systemMessage('System prompt 1'),
      systemMessage('System prompt 2'),
    ]

    await handleSpawnAgents({
      ...handleSpawnAgentsBaseParams,
      agentState: sessionState.mainAgentState,
      agentTemplate: parentAgent,
      localAgentTemplates: { 'child-agent': childAgent },
      toolCall,
    })

    // Verify that system messages without timeToLive are included
    // expireMessages only filters messages with timeToLive='userPrompt'
    expect(capturedSubAgentState.messageHistory).toHaveLength(2)
    const systemMessages = capturedSubAgentState.messageHistory.filter(
      (msg: any) => msg.role === 'system',
    )
    expect(systemMessages).toHaveLength(2)
  })
})
