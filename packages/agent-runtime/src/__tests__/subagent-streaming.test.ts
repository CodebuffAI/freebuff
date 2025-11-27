import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { assistantMessage } from '@codebuff/common/util/messages'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'

import * as runAgentStep from '../run-agent-step'
import { mockFileContext } from './test-utils'
import { assembleLocalAgentTemplates } from '../templates/agent-registry'
import { handleSpawnAgents } from '../tools/handlers/tool/spawn-agents'

import type { AgentTemplate } from '../templates/types'
import type { SendSubagentChunk } from '../tools/handlers/tool/spawn-agents'
import type { CodebuffToolCall } from '@codebuff/common/tools/list'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type { Mock } from 'bun:test'

describe('Subagent Streaming', () => {
  let mockSendSubagentChunk: Mock<SendSubagentChunk>
  let mockLoopAgentSteps: Mock<(typeof runAgentStep)['loopAgentSteps']>
  let mockAgentTemplate: any
  let mockWriteToClient: Mock<
    Parameters<typeof handleSpawnAgents>[0]['writeToClient']
  >
  let handleSpawnAgentsBaseParams: ParamsExcluding<
    typeof handleSpawnAgents,
    'agentState' | 'agentTemplate' | 'localAgentTemplates' | 'toolCall'
  >

  beforeEach(() => {
    // Setup common mock agent template
    mockAgentTemplate = {
      id: 'thinker',
      displayName: 'Thinker',
      outputMode: 'last_message',
      inputSchema: {
        prompt: {
          safeParse: () => ({ success: true }),
        } as any,
      },
      spawnerPrompt: '',
      model: '',
      includeMessageHistory: true,
      inheritParentSystemPrompt: false,
      toolNames: [],
      spawnableAgents: [],
      systemPrompt: '',
      instructionsPrompt: '',
      stepPrompt: '',
    }

    handleSpawnAgentsBaseParams = {
      ...TEST_AGENT_RUNTIME_IMPL,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: mockFileContext,
      fingerprintId: 'test-fingerprint',
      previousToolCallFinished: Promise.resolve(),
      repoId: undefined,
      repoUrl: undefined,
      sendSubagentChunk: mockSendSubagentChunk,
      signal: new AbortController().signal,
      system: 'Test system prompt',
      userId: TEST_USER_ID,
      userInputId: 'test-input',
      writeToClient: mockWriteToClient,
    }
  })

  beforeAll(() => {
    // Mock sendSubagentChunk function to capture streaming messages
    mockSendSubagentChunk = mock(() => {})

    // Mock loopAgentSteps to simulate subagent execution with streaming
    mockLoopAgentSteps = spyOn(
      runAgentStep,
      'loopAgentSteps',
    ).mockImplementation(async (options) => {
      // Simulate streaming chunks by calling the callback
      if (options.onResponseChunk) {
        options.onResponseChunk('Thinking about the problem...')
        options.onResponseChunk('Found a solution!')
      }

      return {
        agentState: {
          ...options.agentState,
          messageHistory: [assistantMessage('Test response from subagent')],
        },
        output: { type: 'lastMessage', value: [assistantMessage('Test response from subagent')] },
      }
    })

    mockWriteToClient = mock(() => {})

    // Mock assembleLocalAgentTemplates
    spyOn(
      { assembleLocalAgentTemplates },
      'assembleLocalAgentTemplates',
    ).mockImplementation(() => ({
      agentTemplates: {
        [mockAgentTemplate.id]: mockAgentTemplate,
      },
      validationErrors: [],
    }))
  })

  beforeEach(() => {
    mockSendSubagentChunk.mockClear()
    mockLoopAgentSteps.mockClear()
  })

  afterAll(() => {
    mock.restore()
  })

  it('should send subagent-response-chunk messages during agent execution', async () => {
    const sessionState = getInitialSessionState(mockFileContext)
    const agentState = sessionState.mainAgentState

    // Mock parent agent template that can spawn thinker
    const parentTemplate = {
      id: 'base',
      spawnableAgents: ['thinker'],
    } as unknown as AgentTemplate

    const toolCall: CodebuffToolCall<'spawn_agents'> = {
      toolName: 'spawn_agents' as const,
      toolCallId: 'test-tool-call-id',
      input: {
        agents: [
          {
            agent_type: 'thinker',
            prompt: 'Think about this problem',
          },
        ],
      },
    }

    await handleSpawnAgents({
      ...handleSpawnAgentsBaseParams,
      agentState,
      agentTemplate: parentTemplate,
      localAgentTemplates: {
        [mockAgentTemplate.id]: mockAgentTemplate,
      },
      toolCall,
    })

    // Verify that subagent streaming messages were sent
    expect(mockWriteToClient).toHaveBeenCalledTimes(2)

    // First call is subagent_start
    expect(mockWriteToClient).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: 'subagent_start' }),
    )

    // Second call is subagent_finish
    expect(mockWriteToClient).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: 'subagent_finish' }),
    )
    return
  })

  it('should include correct agentId and agentType in streaming messages', async () => {
    const sessionState = getInitialSessionState(mockFileContext)
    const agentState = sessionState.mainAgentState

    const parentTemplate = {
      id: 'base',
      spawnableAgents: ['thinker'],
    } as unknown as AgentTemplate

    const toolCall: CodebuffToolCall<'spawn_agents'> = {
      toolName: 'spawn_agents' as const,
      toolCallId: 'test-tool-call-id-2',
      input: {
        agents: [
          {
            agent_type: 'thinker',
            prompt: 'Test prompt',
          },
        ],
      },
    }

    await handleSpawnAgents({
      ...handleSpawnAgentsBaseParams,
      agentState,
      agentTemplate: parentTemplate,
      localAgentTemplates: {
        [mockAgentTemplate.id]: mockAgentTemplate,
      },
      toolCall,
    })

    // Verify the streaming messages have consistent agentId and correct agentType
    expect(mockSendSubagentChunk.mock.calls.length).toBeGreaterThanOrEqual(2)
    const calls = mockSendSubagentChunk.mock.calls as Array<
      [
        {
          userInputId: string
          agentId: string
          agentType: string
          chunk: string
          prompt?: string
        },
      ]
    >
    const firstCall = calls[0][0]
    const secondCall = calls[1][0]

    expect(firstCall.agentId).toBe(secondCall.agentId) // Same agent ID
    expect(firstCall.agentType).toBe('thinker')
    expect(secondCall.agentType).toBe('thinker')
    expect(firstCall.userInputId).toBe('test-input')
    expect(secondCall.userInputId).toBe('test-input')
  })
})
