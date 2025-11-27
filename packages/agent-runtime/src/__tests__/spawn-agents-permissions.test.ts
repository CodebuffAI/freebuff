import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { assistantMessage } from '@codebuff/common/util/messages'
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
import { handleSpawnAgentInline } from '../tools/handlers/tool/spawn-agent-inline'
import { getMatchingSpawn } from '../tools/handlers/tool/spawn-agent-utils'
import { handleSpawnAgents } from '../tools/handlers/tool/spawn-agents'

import type { CodebuffToolCall } from '@codebuff/common/tools/list'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'

describe('Spawn Agents Permissions', () => {
  let mockSendSubagentChunk: any
  let mockLoopAgentSteps: any
  let handleSpawnAgentsBaseParams: ParamsExcluding<
    typeof handleSpawnAgents,
    'agentState' | 'agentTemplate' | 'localAgentTemplates' | 'toolCall'
  >

  const createMockAgent = (
    id: string,
    spawnableAgents: string[] = [],
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
    includeMessageHistory: true,
    inheritParentSystemPrompt: false,
    mcpServers: {},
    toolNames: [],
    spawnableAgents,
    systemPrompt: '',
    instructionsPrompt: '',
    stepPrompt: '',
  })

  beforeEach(() => {
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
      writeToClient: () => {},
    }

    // Mock sendSubagentChunk
    mockSendSubagentChunk = mock(() => {})

    // Mock loopAgentSteps to avoid actual agent execution
    mockLoopAgentSteps = spyOn(
      runAgentStep,
      'loopAgentSteps',
    ).mockImplementation(async (options) => {
      return {
        agentState: {
          ...options.agentState,
          messageHistory: [assistantMessage('Mock agent response')],
        },
        output: { type: 'lastMessage', value: [assistantMessage('Mock agent response')] },
      }
    })
  })

  afterEach(() => {
    mock.restore()
  })

  describe('getMatchingSpawn function', () => {
    describe('exact matches with publisher/agent@version format', () => {
      it('should match exact publisher/agent@version', () => {
        const spawnableAgents = [
          'codebuff/thinker@1.0.0',
          'codebuff/reviewer@2.1.0',
        ]
        const result = getMatchingSpawn(
          spawnableAgents,
          'codebuff/thinker@1.0.0',
        )
        expect(result).toBe('codebuff/thinker@1.0.0')
      })

      it('should not match different versions', () => {
        const spawnableAgents = ['codebuff/thinker@1.0.0']
        const result = getMatchingSpawn(
          spawnableAgents,
          'codebuff/thinker@2.0.0',
        )
        expect(result).toBeNull()
      })

      it('should not match different publishers', () => {
        const spawnableAgents = ['codebuff/thinker@1.0.0']
        const result = getMatchingSpawn(spawnableAgents, 'acme/thinker@1.0.0')
        expect(result).toBeNull()
      })

      it('should not match different agent names', () => {
        const spawnableAgents = ['codebuff/thinker@1.0.0']
        const result = getMatchingSpawn(
          spawnableAgents,
          'codebuff/reviewer@1.0.0',
        )
        expect(result).toBeNull()
      })
    })

    describe('publisher/agent format without version', () => {
      it('should match publisher/agent when child has no version', () => {
        const spawnableAgents = ['codebuff/thinker@1.0.0', 'acme/reviewer']
        const result = getMatchingSpawn(spawnableAgents, 'codebuff/thinker')
        expect(result).toBe('codebuff/thinker@1.0.0')
      })

      it('should match exact publisher/agent without version', () => {
        const spawnableAgents = ['codebuff/thinker', 'acme/reviewer']
        const result = getMatchingSpawn(spawnableAgents, 'codebuff/thinker')
        expect(result).toBe('codebuff/thinker')
      })

      it('should not match when publisher differs', () => {
        const spawnableAgents = ['codebuff/thinker@1.0.0']
        const result = getMatchingSpawn(spawnableAgents, 'acme/thinker')
        expect(result).toBeNull()
      })
    })

    describe('agent@version format without publisher', () => {
      it('should match agent@version when spawnable has no publisher', () => {
        const spawnableAgents = ['thinker@1.0.0', 'reviewer@2.0.0']
        const result = getMatchingSpawn(spawnableAgents, 'thinker@1.0.0')
        expect(result).toBe('thinker@1.0.0')
      })

      it('should match agent@version when spawnable has publisher but child does not', () => {
        const spawnableAgents = ['codebuff/thinker@1.0.0', 'reviewer@2.0.0']
        const result = getMatchingSpawn(spawnableAgents, 'thinker@1.0.0')
        expect(result).toBe('codebuff/thinker@1.0.0')
      })

      it('should not match when versions differ', () => {
        const spawnableAgents = ['thinker@1.0.0']
        const result = getMatchingSpawn(spawnableAgents, 'thinker@2.0.0')
        expect(result).toBeNull()
      })
    })

    describe('simple agent name format', () => {
      it('should match simple agent name', () => {
        const spawnableAgents = ['thinker', 'reviewer', 'file-picker']
        const result = getMatchingSpawn(spawnableAgents, 'thinker')
        expect(result).toBe('thinker')
      })

      it('should match simple agent name when spawnable has publisher', () => {
        const spawnableAgents = ['codebuff/thinker@1.0.0', 'reviewer']
        const result = getMatchingSpawn(spawnableAgents, 'thinker')
        expect(result).toBe('codebuff/thinker@1.0.0')
      })

      it('should match simple agent name when spawnable has version', () => {
        const spawnableAgents = ['thinker@1.0.0', 'reviewer']
        const result = getMatchingSpawn(spawnableAgents, 'thinker')
        expect(result).toBe('thinker@1.0.0')
      })

      it('should not match when agent name differs', () => {
        const spawnableAgents = ['thinker', 'reviewer']
        const result = getMatchingSpawn(spawnableAgents, 'file-picker')
        expect(result).toBeNull()
      })
    })

    describe('edge cases', () => {
      it('should return null for empty agent ID', () => {
        const spawnableAgents = ['thinker', 'reviewer']
        const result = getMatchingSpawn(spawnableAgents, '')
        expect(result).toBeNull()
      })

      it('should return null for malformed agent ID', () => {
        const spawnableAgents = ['thinker', 'reviewer']
        const result = getMatchingSpawn(
          spawnableAgents,
          'invalid/agent/format/too/many/slashes',
        )
        expect(result).toBeNull()
      })

      it('should return null when spawnableAgents is empty', () => {
        const spawnableAgents: string[] = []
        const result = getMatchingSpawn(spawnableAgents, 'thinker')
        expect(result).toBeNull()
      })

      it('should handle malformed spawnable agent IDs gracefully', () => {
        const spawnableAgents = ['', 'invalid/agent/too/many/parts', 'thinker']
        const result = getMatchingSpawn(spawnableAgents, 'thinker')
        expect(result).toBe('thinker')
      })

      it('should prioritize exact matches over partial matches', () => {
        const spawnableAgents = ['thinker', 'codebuff/thinker@1.0.0']
        const result = getMatchingSpawn(spawnableAgents, 'thinker')
        expect(result).toBe('thinker') // First match wins
      })
    })
  })

  describe('handleSpawnAgents permission validation', () => {
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

    it('should allow spawning when agent is in spawnableAgents list', async () => {
      const parentAgent = createMockAgent('parent', ['thinker', 'reviewer'])
      const childAgent = createMockAgent('thinker')
      const sessionState = getInitialSessionState(mockFileContext)
      const toolCall = createSpawnToolCall('thinker')

      const { output } = await handleSpawnAgents({
        ...handleSpawnAgentsBaseParams,
        agentState: sessionState.mainAgentState,
        agentTemplate: parentAgent,
        localAgentTemplates: { thinker: childAgent },
        toolCall,
      })

      expect(JSON.stringify(output)).toContain('Mock agent response')
      expect(mockLoopAgentSteps).toHaveBeenCalledTimes(1)
    })

    it('should reject spawning when agent is not in spawnableAgents list', async () => {
      const parentAgent = createMockAgent('parent', ['thinker']) // Only allows thinker
      const childAgent = createMockAgent('reviewer')
      const sessionState = getInitialSessionState(mockFileContext)
      const toolCall = createSpawnToolCall('reviewer') // Try to spawn reviewer

      const { output } = await handleSpawnAgents({
        ...handleSpawnAgentsBaseParams,
        agentState: sessionState.mainAgentState,
        agentTemplate: parentAgent,
        localAgentTemplates: { reviewer: childAgent },
        toolCall,
      })

      expect(JSON.stringify(output)).toContain('Error spawning agent')
      expect(JSON.stringify(output)).toContain(
        'is not allowed to spawn child agent type reviewer',
      )
      expect(mockLoopAgentSteps).not.toHaveBeenCalled()
    })

    it('should reject spawning when agent template is not found', async () => {
      const parentAgent = createMockAgent('parent', ['nonexistent'])
      const sessionState = getInitialSessionState(mockFileContext)
      const toolCall = createSpawnToolCall('nonexistent')

      const { output } = await handleSpawnAgents({
        ...handleSpawnAgentsBaseParams,
        agentState: sessionState.mainAgentState,
        agentTemplate: parentAgent,
        localAgentTemplates: {}, // Empty - agent not found
        toolCall,
      })

      console.log('output', output)
      expect(JSON.stringify(output)).toContain('Error spawning agent')
      expect(JSON.stringify(output)).toContain(
        'Agent type nonexistent not found',
      )
      expect(mockLoopAgentSteps).not.toHaveBeenCalled()
    })

    it('should handle versioned agent permissions correctly', async () => {
      const parentAgent = createMockAgent('parent', ['codebuff/thinker@1.0.0'])
      const childAgent = createMockAgent('codebuff/thinker@1.0.0')
      const sessionState = getInitialSessionState(mockFileContext)
      const toolCall = createSpawnToolCall('codebuff/thinker@1.0.0')

      const { output } = await handleSpawnAgents({
        ...handleSpawnAgentsBaseParams,
        agentState: sessionState.mainAgentState,
        agentTemplate: parentAgent,
        localAgentTemplates: { 'codebuff/thinker@1.0.0': childAgent },
        toolCall,
      })

      expect(JSON.stringify(output)).toContain('Mock agent response')
      expect(mockLoopAgentSteps).toHaveBeenCalledTimes(1)
    })

    it('should allow spawning simple agent name when parent allows versioned agent', async () => {
      const parentAgent = createMockAgent('parent', ['codebuff/thinker@1.0.0'])
      const childAgent = createMockAgent('codebuff/thinker@1.0.0')
      const sessionState = getInitialSessionState(mockFileContext)
      const toolCall = createSpawnToolCall('thinker') // Simple name

      const { output } = await handleSpawnAgents({
        ...handleSpawnAgentsBaseParams,
        agentState: sessionState.mainAgentState,
        agentTemplate: parentAgent,
        localAgentTemplates: {
          thinker: childAgent,
          'codebuff/thinker@1.0.0': childAgent, // Register with both keys
        },
        toolCall,
      })

      expect(JSON.stringify(output)).toContain('Mock agent response')
      expect(mockLoopAgentSteps).toHaveBeenCalledTimes(1)
    })

    it('should reject when version mismatch exists', async () => {
      const parentAgent = createMockAgent('parent', ['codebuff/thinker@1.0.0'])
      const childAgent = createMockAgent('codebuff/thinker@2.0.0')
      const sessionState = getInitialSessionState(mockFileContext)
      const toolCall = createSpawnToolCall('codebuff/thinker@2.0.0')

      const { output } = await handleSpawnAgents({
        ...handleSpawnAgentsBaseParams,
        agentState: sessionState.mainAgentState,
        agentTemplate: parentAgent,
        localAgentTemplates: { 'codebuff/thinker@2.0.0': childAgent },
        toolCall,
      })

      expect(JSON.stringify(output)).toContain('Error spawning agent')
      expect(JSON.stringify(output)).toContain(
        'is not allowed to spawn child agent type',
      )
      expect(mockLoopAgentSteps).not.toHaveBeenCalled()
    })

    it('should handle multiple agents with mixed success/failure', async () => {
      const parentAgent = createMockAgent('parent', ['thinker']) // Only allows thinker
      const thinkerAgent = createMockAgent('thinker')
      const reviewerAgent = createMockAgent('reviewer')
      const sessionState = getInitialSessionState(mockFileContext)

      const toolCall: CodebuffToolCall<'spawn_agents'> = {
        toolName: 'spawn_agents' as const,
        toolCallId: 'test-tool-call-id',
        input: {
          agents: [
            { agent_type: 'thinker', prompt: 'Think about this' },
            { agent_type: 'reviewer', prompt: 'Review this' }, // Should fail
          ],
        },
      }

      const { output } = await handleSpawnAgents({
        ...handleSpawnAgentsBaseParams,
        agentState: sessionState.mainAgentState,
        agentTemplate: parentAgent,
        localAgentTemplates: {
          thinker: thinkerAgent,
          reviewer: reviewerAgent,
        },
        toolCall,
      })

      expect(JSON.stringify(output)).toContain('Mock agent response') // Successful thinker spawn
      expect(JSON.stringify(output)).toContain('Error spawning agent') // Failed reviewer spawn
      expect(JSON.stringify(output)).toContain(
        'is not allowed to spawn child agent type reviewer',
      )
      expect(mockLoopAgentSteps).toHaveBeenCalledTimes(1) // Only thinker was spawned
    })
  })

  describe('handleSpawnAgentInline permission validation', () => {
    const createInlineSpawnToolCall = (
      agentType: string,
      prompt = 'test prompt',
    ): CodebuffToolCall<'spawn_agent_inline'> => ({
      toolName: 'spawn_agent_inline' as const,
      toolCallId: 'test-tool-call-id',
      input: {
        agent_type: agentType,
        prompt,
      },
    })

    it('should allow spawning inline agent when agent is in spawnableAgents list', async () => {
      const parentAgent = createMockAgent('parent', ['thinker', 'reviewer'])
      const childAgent = createMockAgent('thinker')
      const sessionState = getInitialSessionState(mockFileContext)
      const toolCall = createInlineSpawnToolCall('thinker')

      // Should not throw
      await handleSpawnAgentInline({
        ...handleSpawnAgentsBaseParams,
        agentState: sessionState.mainAgentState,
        agentTemplate: parentAgent,
        localAgentTemplates: { thinker: childAgent },
        toolCall,
      })

      expect(mockLoopAgentSteps).toHaveBeenCalledTimes(1)
    })

    it('should reject spawning inline agent when agent is not in spawnableAgents list', async () => {
      const parentAgent = createMockAgent('parent', ['thinker']) // Only allows thinker
      const childAgent = createMockAgent('reviewer')
      const sessionState = getInitialSessionState(mockFileContext)
      const toolCall = createInlineSpawnToolCall('reviewer') // Try to spawn reviewer

      const result = handleSpawnAgentInline({
        ...handleSpawnAgentsBaseParams,
        agentState: sessionState.mainAgentState,
        agentTemplate: parentAgent,
        localAgentTemplates: { reviewer: childAgent },
        toolCall,
      })

      expect(result).rejects.toThrow(
        'is not allowed to spawn child agent type reviewer',
      )
      expect(mockLoopAgentSteps).not.toHaveBeenCalled()
    })

    it('should reject spawning inline agent when agent template is not found', async () => {
      const parentAgent = createMockAgent('parent', ['nonexistent'])
      const sessionState = getInitialSessionState(mockFileContext)
      const toolCall = createInlineSpawnToolCall('nonexistent')

      const result = handleSpawnAgentInline({
        ...handleSpawnAgentsBaseParams,
        agentState: sessionState.mainAgentState,
        agentTemplate: parentAgent,
        localAgentTemplates: {}, // Empty - agent not found
        toolCall,
      })

      expect(result).rejects.toThrow('Agent type nonexistent not found')
      expect(mockLoopAgentSteps).not.toHaveBeenCalled()
    })

    it('should handle versioned inline agent permissions correctly', async () => {
      const parentAgent = createMockAgent('parent', ['codebuff/thinker@1.0.0'])
      const childAgent = createMockAgent('codebuff/thinker@1.0.0')
      const sessionState = getInitialSessionState(mockFileContext)
      const toolCall = createInlineSpawnToolCall('codebuff/thinker@1.0.0')

      // Should not throw
      await handleSpawnAgentInline({
        ...handleSpawnAgentsBaseParams,
        agentState: sessionState.mainAgentState,
        agentTemplate: parentAgent,
        localAgentTemplates: { 'codebuff/thinker@1.0.0': childAgent },
        toolCall,
      })

      expect(mockLoopAgentSteps).toHaveBeenCalledTimes(1)
    })

    it('should allow spawning simple agent name inline when parent allows versioned agent', async () => {
      const parentAgent = createMockAgent('parent', ['codebuff/thinker@1.0.0'])
      const childAgent = createMockAgent('codebuff/thinker@1.0.0')
      const sessionState = getInitialSessionState(mockFileContext)
      const toolCall = createInlineSpawnToolCall('thinker') // Simple name

      // Should not throw
      await handleSpawnAgentInline({
        ...handleSpawnAgentsBaseParams,
        agentState: sessionState.mainAgentState,
        agentTemplate: parentAgent,
        localAgentTemplates: {
          thinker: childAgent,
          'codebuff/thinker@1.0.0': childAgent, // Register with both keys
        },
        toolCall,
      })

      expect(mockLoopAgentSteps).toHaveBeenCalledTimes(1)
    })

    it('should reject inline spawn when version mismatch exists', async () => {
      const parentAgent = createMockAgent('parent', ['codebuff/thinker@1.0.0'])
      const childAgent = createMockAgent('codebuff/thinker@2.0.0')
      const sessionState = getInitialSessionState(mockFileContext)
      const toolCall = createInlineSpawnToolCall('codebuff/thinker@2.0.0')

      const result = handleSpawnAgentInline({
        ...handleSpawnAgentsBaseParams,
        agentState: sessionState.mainAgentState,
        agentTemplate: parentAgent,
        localAgentTemplates: { 'codebuff/thinker@2.0.0': childAgent },
        toolCall,
      })

      expect(result).rejects.toThrow('is not allowed to spawn child agent type')
      expect(mockLoopAgentSteps).not.toHaveBeenCalled()
    })
  })
})
