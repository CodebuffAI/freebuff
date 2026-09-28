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
  let capturedSubAgentPrompt: string | undefined

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
      capturedSubAgentPrompt = options.prompt
      return {
        agentState: {
          ...options.agentState,
          messageHistory: [
            ...options.agentState.messageHistory,
            assistantMessage('Mock agent response'),
          ],
        },
        output: {
          type: 'lastMessage',
          value: [assistantMessage('Mock agent response')],
        },
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
      tools: {},
      userId: TEST_USER_ID,
      userInputId: 'test-input',
      writeToClient: () => {},
    }
  })

  afterEach(() => {
    mock.restore()
    capturedSubAgentState = undefined
    capturedSubAgentPrompt = undefined
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
      } as unknown as AgentTemplate['inputSchema']['prompt'],
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

    // The streamed spawn path has not added its tool call to parent history yet,
    // so the complete existing transcript is inherited unchanged.
    expect(capturedSubAgentState.messageHistory).toHaveLength(4)

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

    // The spawn prompt is handed to loopAgentSteps, which appends it as a
    // normal USER_PROMPT message. No synthetic spawn announcement is inherited.
    expect(capturedSubAgentPrompt).toBe('test prompt')
    expect(
      capturedSubAgentState.messageHistory.some((msg: any) =>
        msg.tags?.includes('SUBAGENT_SPAWN'),
      ),
    ).toBe(false)
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

    expect(capturedSubAgentState.messageHistory).toHaveLength(0)
    expect(capturedSubAgentPrompt).toBe('test prompt')
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

    expect(capturedSubAgentState.messageHistory).toHaveLength(2)
    const systemMessages = capturedSubAgentState.messageHistory.filter(
      (msg: any) => msg.role === 'system',
    )
    expect(systemMessages).toHaveLength(2)
  })

  it('includes the streamed assistant snapshot immediately before the spawn', async () => {
    const parentAgent = createMockAgent('parent', true)
    const childAgent = createMockAgent('child-agent', true)
    const sessionState = getInitialSessionState(mockFileContext)
    const toolCall = createSpawnToolCall('child-agent', 'Review the changes')
    const currentAssistantMessages = [
      assistantMessage({
        type: 'reasoning',
        text: 'I checked the edge cases.',
      }),
      assistantMessage('The implementation is ready for review.'),
    ]

    sessionState.mainAgentState.messageHistory = [
      userMessage('Implement the feature'),
    ]

    await handleSpawnAgents({
      ...handleSpawnAgentsBaseParams,
      agentState: sessionState.mainAgentState,
      agentTemplate: parentAgent,
      currentAssistantMessages,
      localAgentTemplates: { 'child-agent': childAgent },
      toolCall,
    })

    expect(capturedSubAgentState.messageHistory).toEqual([
      ...sessionState.mainAgentState.messageHistory,
      ...currentAssistantMessages,
    ])
    expect(capturedSubAgentPrompt).toBe('Review the changes')
  })

  it('does not propagate synthetic spawn messages from legacy sessions', async () => {
    const parentAgent = createMockAgent('parent', true)
    const childAgent = createMockAgent('child-agent', true)
    const sessionState = getInitialSessionState(mockFileContext)
    const toolCall = createSpawnToolCall('child-agent')
    const userRequest = userMessage('Continue the existing task')

    sessionState.mainAgentState.messageHistory = [
      userRequest,
      userMessage({
        content: '<system>Subagent old-agent has been spawned.</system>',
        tags: ['SUBAGENT_SPAWN'],
      }),
    ]

    await handleSpawnAgents({
      ...handleSpawnAgentsBaseParams,
      agentState: sessionState.mainAgentState,
      agentTemplate: parentAgent,
      localAgentTemplates: { 'child-agent': childAgent },
      toolCall,
    })

    expect(capturedSubAgentState.messageHistory).toEqual([userRequest])
  })

  it('should cut programmatic agent history immediately before the matching spawn call', async () => {
    const parentAgent = createMockAgent('parent', true)
    const childAgent = createMockAgent('child-agent', true)
    const sessionState = getInitialSessionState(mockFileContext)
    const toolCall = createSpawnToolCall('child-agent', 'Review the changes')
    const userRequest = userMessage('Implement the feature')
    const parentResponse = assistantMessage('I updated the implementation.')
    const interruptedToolCall = assistantMessage({
      type: 'tool-call',
      toolCallId: 'unfinished-tool-call',
      toolName: 'read_files',
      input: { paths: ['src/feature.ts'] },
    })
    const spawnMessage = assistantMessage([
      { type: 'text', text: 'The implementation is ready for review.' },
      {
        type: 'tool-call',
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        input: toolCall.input,
      },
      { type: 'text', text: 'This content follows the spawn call.' },
    ])

    sessionState.mainAgentState.messageHistory = [
      userRequest,
      parentResponse,
      interruptedToolCall,
      spawnMessage,
      assistantMessage('This message must not leak past the spawn boundary.'),
    ]

    await handleSpawnAgents({
      ...handleSpawnAgentsBaseParams,
      agentState: sessionState.mainAgentState,
      agentTemplate: parentAgent,
      localAgentTemplates: { 'child-agent': childAgent },
      toolCall,
    })

    expect(capturedSubAgentState.messageHistory).toEqual([
      userRequest,
      parentResponse,
      { ...spawnMessage, content: spawnMessage.content.slice(0, 1) },
    ])
    expect(capturedSubAgentPrompt).toBe('Review the changes')
  })

  /** Spawns a child whose last turn is `lastTurn`; returns what the parent receives. */
  const spawnReturning = async (
    lastTurn: ReturnType<typeof assistantMessage>[],
  ) => {
    mockLoopAgentSteps.mockImplementation(async (options: any) => ({
      agentState: options.agentState,
      output: { type: 'lastMessage', value: lastTurn },
    }))
    const { output } = await handleSpawnAgents({
      ...handleSpawnAgentsBaseParams,
      agentState: getInitialSessionState(mockFileContext).mainAgentState,
      agentTemplate: createMockAgent('parent'),
      localAgentTemplates: { 'child-agent': createMockAgent('child-agent') },
      toolCall: createSpawnToolCall('child-agent'),
    })
    return (output[0] as any).value[0].value
  }

  it("hands the parent the child's answer as plain text", async () => {
    const received = await spawnReturning([
      assistantMessage({
        type: 'reasoning',
        text: 'Weighing the sources.',
        providerOptions: {
          codebuff: { reasoning_details: [{ type: 'reasoning.encrypted' }] },
        },
      }),
      assistantMessage([
        { type: 'reasoning', text: 'One more check.' },
        { type: 'text', text: '<think>Scaffolding.</think>The answer.' },
      ]),
    ])

    expect(received).toBe('The answer.')
  })

  it('reports a last turn of only reasoning as no response', async () => {
    const received = await spawnReturning([
      assistantMessage({
        type: 'reasoning',
        text: 'Thinking, never answering.',
      }),
    ])

    expect(received).toEqual({
      type: 'error',
      message: 'No response from agent',
    })
  })

  it('reads an answer that set_messages stored as a bare string', async () => {
    const received = await spawnReturning([
      { role: 'assistant', content: 'The answer.' } as any,
    ])

    expect(received).toBe('The answer.')
  })
})
