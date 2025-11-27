import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import {
  getInitialAgentState,
  getInitialSessionState,
} from '@codebuff/common/types/session-state'
import { assistantMessage } from '@codebuff/common/util/messages'
import {
  spyOn,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  mock,
} from 'bun:test'

import * as agentRegistry from '../templates/agent-registry'
import * as spawnAgentUtils from '../tools/handlers/tool/spawn-agent-utils'
import { handleSpawnAgents } from '../tools/handlers/tool/spawn-agents'

import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type { AgentState } from '@codebuff/common/types/session-state'
import type { ProjectFileContext } from '@codebuff/common/util/file'

const mockFileContext: ProjectFileContext = {
  projectRoot: '/test',
  cwd: '/test',
  fileTree: [],
  fileTokenScores: {},
  knowledgeFiles: {},
  gitChanges: {
    status: '',
    diff: '',
    diffCached: '',
    lastCommitMessages: '',
  },
  changesSinceLastChat: {},
  shellConfigFiles: {},
  agentTemplates: {},
  customToolDefinitions: {},
  systemInfo: {
    platform: 'test',
    shell: 'test',
    nodeVersion: 'test',
    arch: 'test',
    homedir: '/home/test',
    cpus: 1,
  },
}

describe('Cost Aggregation System', () => {
  let mockAgentTemplate: any
  let mockLocalAgentTemplates: Record<string, any>
  let params: ParamsExcluding<
    typeof handleSpawnAgents,
    'agentState' | 'toolCall'
  >

  beforeEach(() => {
    // Setup mock agent template
    mockAgentTemplate = {
      id: 'test-agent',
      displayName: 'Test Agent',
      model: 'gpt-4o-mini',
      toolNames: ['write_file'],
      spawnableAgents: ['test-agent'],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test instructions',
      stepPrompt: 'Test step prompt',
      includeMessageHistory: true,
      inheritParentSystemPrompt: false,
      outputMode: 'last_message',
      inputSchema: {},
    }

    mockLocalAgentTemplates = {
      'test-agent': mockAgentTemplate,
    }

    params = {
      ...TEST_AGENT_RUNTIME_IMPL,
      agentTemplate: mockAgentTemplate,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: mockFileContext,
      fingerprintId: 'test-fingerprint',
      localAgentTemplates: mockLocalAgentTemplates,
      previousToolCallFinished: Promise.resolve(),
      repoId: undefined,
      repoUrl: undefined,
      signal: new AbortController().signal,
      system: 'Test system prompt',
      userId: 'test-user',
      userInputId: 'test-input',
      writeToClient: () => {},
    }

    // Mock getAgentTemplate to return our mock template
    spyOn(agentRegistry, 'getAgentTemplate').mockResolvedValue(
      mockAgentTemplate,
    )

    // Mock getMatchingSpawn to return the agent type for spawnable validation
    spyOn(spawnAgentUtils, 'getMatchingSpawn').mockReturnValue('test-agent')
  })

  afterEach(() => {
    mock.restore()
  })

  describe('Single Agent Cost Tracking', () => {
    it('should track credits used by a single agent', async () => {
      const sessionState = getInitialSessionState(mockFileContext)
      const agentState = sessionState.mainAgentState

      expect(agentState.creditsUsed).toBe(0)

      // Simulate adding credits directly to agent state
      agentState.creditsUsed += 100

      expect(agentState.creditsUsed).toBe(100)
    })

    it('should accumulate costs across multiple operations', async () => {
      const sessionState = getInitialSessionState(mockFileContext)
      const agentState = sessionState.mainAgentState

      // Simulate agent making multiple operations that incur costs
      agentState.creditsUsed += 50
      agentState.creditsUsed += 75
      agentState.creditsUsed += 25

      expect(agentState.creditsUsed).toBe(150)
    })
  })

  describe('Subagent Cost Aggregation', () => {
    it('should aggregate costs from successful subagents', async () => {
      const parentAgentState: AgentState = {
        agentId: 'parent-agent',
        agentType: 'test-agent',
        agentContext: {},
        ancestorRunIds: [],
        subagents: [],
        childRunIds: [],
        messageHistory: [],
        stepsRemaining: 10,
        creditsUsed: 50, // Parent starts with some cost
        directCreditsUsed: 50,
      }

      // Mock executeAgent to return results with different credit costs
      const mockExecuteAgent = spyOn(spawnAgentUtils, 'executeSubagent')
        .mockResolvedValueOnce({
          agentState: {
            ...getInitialAgentState(),
            agentId: 'sub-agent-1',
            agentType: 'test-agent',
            stepsRemaining: 10,
            creditsUsed: 75, // First subagent uses 75 credits
          },
          output: { type: 'lastMessage', value: [assistantMessage('Sub-agent 1 response')] },
        })
        .mockResolvedValueOnce({
          agentState: {
            ...getInitialAgentState(),
            agentId: 'sub-agent-2',
            agentType: 'test-agent',
            stepsRemaining: 10,
            creditsUsed: 100, // Second subagent uses 100 credits
          },
          output: { type: 'lastMessage', value: [assistantMessage('Sub-agent 2 response')] },
        })

      const mockToolCall = {
        toolName: 'spawn_agents' as const,
        toolCallId: 'test-call',
        input: {
          agents: [
            { agent_type: 'test-agent', prompt: 'Task 1' },
            { agent_type: 'test-agent', prompt: 'Task 2' },
          ],
        },
      }

      await handleSpawnAgents({
        ...params,
        agentState: parentAgentState,
        toolCall: mockToolCall,
      })

      // Parent should have aggregated costs: original 50 + subagent 75 + subagent 100 = 225
      expect(parentAgentState.creditsUsed).toBe(225)
      expect(mockExecuteAgent).toHaveBeenCalledTimes(2)
    })

    it('should aggregate partial costs from failed subagents', async () => {
      const parentAgentState: AgentState = {
        ...getInitialAgentState(),
        agentId: 'parent-agent',
        agentType: 'test-agent',
        stepsRemaining: 10,
        creditsUsed: 10, // Parent starts with some cost
      }

      const mockValidatedState = {
        fingerprintId: 'test-fingerprint',
        userId: 'test-user',
        agentTemplate: mockAgentTemplate,
        localAgentTemplates: mockLocalAgentTemplates,
        messages: [],
        sendSubagentChunk: () => {},
        system: 'Test system prompt',
      }

      // Mock executeAgent to return success and failure with partial costs
      const mockExecuteAgent = spyOn(spawnAgentUtils, 'executeSubagent')
        .mockResolvedValueOnce({
          agentState: {
            ...getInitialAgentState(),
            agentId: 'sub-agent-1',
            agentType: 'test-agent',
            stepsRemaining: 10,
            creditsUsed: 50, // Successful agent
          },
          output: { type: 'lastMessage', value: [assistantMessage('Successful response')] },
        })
        .mockRejectedValueOnce(
          (() => {
            const error = new Error('Agent failed') as any
            error.agentState = {
              agentId: 'sub-agent-2',
              agentType: 'test-agent',
              agentContext: {},
              subagents: [],
              messageHistory: [],
              stepsRemaining: 10,
              creditsUsed: 25, // Partial cost from failed agent
            }
            error.output = { type: 'error', message: 'Agent failed' }
            return error
          })(),
        )

      const mockToolCall = {
        toolName: 'spawn_agents' as const,
        toolCallId: 'test-call',
        input: {
          agents: [
            { agent_type: 'test-agent', prompt: 'Task 1' },
            { agent_type: 'test-agent', prompt: 'Task 2' },
          ],
        },
      }

      await handleSpawnAgents({
        ...params,
        agentState: parentAgentState,
        toolCall: mockToolCall,
      })

      // Parent should aggregate costs: original 10 + successful subagent 50 + failed subagent 25 = 85
      expect(parentAgentState.creditsUsed).toBe(85)
    })
  })

  describe('Error Handling', () => {
    it('should preserve costs when operations fail', async () => {
      const sessionState = getInitialSessionState(mockFileContext)
      const agentState = sessionState.mainAgentState

      // Set up initial credits
      agentState.creditsUsed = 50

      // Simulate adding credits before an error occurs
      agentState.creditsUsed += 100

      // Simulate an error happening (but costs should be preserved)
      try {
        throw new Error('Operation failed')
      } catch (error) {
        // Error occurred, but credits should still be preserved
      }

      // Agent state should still have the credits that were accumulated
      expect(agentState.creditsUsed).toBe(150) // 50 + 100
    })

    it('should preserve costs when complex operations fail', async () => {
      const sessionState = getInitialSessionState(mockFileContext)
      const agentState = sessionState.mainAgentState

      // Set up initial credits
      agentState.creditsUsed = 25

      // Simulate multiple operations adding credits
      agentState.creditsUsed += 30 // First operation
      agentState.creditsUsed += 45 // Second operation

      // Simulate a failure after credits were added
      let failed = false
      try {
        throw new Error('Complex operation failed')
      } catch (error) {
        failed = true
      }

      // Verify failure occurred but credits were preserved
      expect(failed).toBe(true)
      expect(agentState.creditsUsed).toBe(100) // 25 + 30 + 45
    })
  })

  describe('Basic Functionality', () => {
    it('should initialize creditsUsed field to 0', () => {
      const sessionState = getInitialSessionState(mockFileContext)
      expect(sessionState.mainAgentState.creditsUsed).toBe(0)
    })

    it('should allow setting and retrieving creditsUsed field', () => {
      const sessionState = getInitialSessionState(mockFileContext)
      sessionState.mainAgentState.creditsUsed = 100
      expect(sessionState.mainAgentState.creditsUsed).toBe(100)
    })

    it('should verify cost field exists in AgentState structure', () => {
      const sessionState = getInitialSessionState(mockFileContext)

      // Verify the structure includes creditsUsed field
      expect(sessionState.mainAgentState).toHaveProperty('creditsUsed')
      expect(typeof sessionState.mainAgentState.creditsUsed).toBe('number')

      // Verify it can be set and retrieved
      sessionState.mainAgentState.creditsUsed = 999
      expect(sessionState.mainAgentState.creditsUsed).toBe(999)
    })
  })

  describe('Data Integrity', () => {
    it('should maintain consistent cost accounting across the agent hierarchy', async () => {
      const sessionState = getInitialSessionState(mockFileContext)
      const mainAgentState = sessionState.mainAgentState

      // Simulate a known cost scenario
      const baseAgentCost = 200 // Main agent direct cost
      const subAgent1Cost = 150 // First subagent cost
      const subAgent2Cost = 100 // Second subagent cost
      const expectedTotal = baseAgentCost + subAgent1Cost + subAgent2Cost

      // Set up main agent cost
      mainAgentState.creditsUsed = baseAgentCost

      // Mock subagent spawning that adds their costs
      const mockValidatedState = {
        fingerprintId: 'test-fingerprint',
        userId: 'test-user',
        agentTemplate: mockAgentTemplate,
        localAgentTemplates: mockLocalAgentTemplates,
        messages: [],
        sendSubagentChunk: () => {},
      }

      const mockExecuteAgent = spyOn(spawnAgentUtils, 'executeSubagent')
        .mockResolvedValueOnce({
          agentState: {
            ...getInitialAgentState(),
            agentId: 'sub-agent-1',
            agentType: 'test-agent',
            messageHistory: [assistantMessage('Sub-agent 1 response')],
            stepsRemaining: 10,
            creditsUsed: subAgent1Cost,
          } as AgentState,
          output: { type: 'lastMessage', value: [assistantMessage('Sub-agent 1 response')] },
        })
        .mockResolvedValueOnce({
          agentState: {
            ...getInitialAgentState(),
            agentId: 'sub-agent-2',
            agentType: 'test-agent',
            messageHistory: [assistantMessage('Sub-agent 2 response')],
            stepsRemaining: 10,
            creditsUsed: subAgent2Cost,
          } as AgentState,
          output: { type: 'lastMessage', value: [assistantMessage('Sub-agent 2 response')] },
        })

      const mockToolCall = {
        toolName: 'spawn_agents' as const,
        toolCallId: 'test-call',
        input: {
          agents: [
            { agent_type: 'test-agent', prompt: 'Task 1' },
            { agent_type: 'test-agent', prompt: 'Task 2' },
          ],
        },
      }

      await handleSpawnAgents({
        ...params,
        agentState: mainAgentState,
        toolCall: mockToolCall,
      })

      // Verify exact cost accounting
      expect(mainAgentState.creditsUsed).toBe(expectedTotal)

      // Verify no negative balances or impossible values
      expect(mainAgentState.creditsUsed).toBeGreaterThanOrEqual(0)
      expect(mainAgentState.creditsUsed).toBe(
        Math.floor(mainAgentState.creditsUsed),
      ) // Should be integer
    })
  })
})
