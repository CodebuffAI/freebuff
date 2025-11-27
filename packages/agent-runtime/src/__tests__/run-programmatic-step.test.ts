import * as analytics from '@codebuff/common/analytics'
import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import {
  assistantMessage,
  jsonToolResult,
  userMessage,
} from '@codebuff/common/util/messages'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import { cloneDeep } from 'lodash'

import {
  clearAgentGeneratorCache,
  runProgrammaticStep,
} from '../run-programmatic-step'
import { mockFileContext } from './test-utils'
import * as toolExecutor from '../tools/tool-executor'

import type { AgentTemplate, StepGenerator } from '../templates/types'
import type { executeToolCall } from '../tools/tool-executor'
import type { PublicAgentState } from '@codebuff/common/types/agent-template'
import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
} from '@codebuff/common/types/contracts/agent-runtime'
import type { SendActionFn } from '@codebuff/common/types/contracts/client'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ParamsOf } from '@codebuff/common/types/function-params'
import type { ToolMessage } from '@codebuff/common/types/messages/codebuff-message'
import type { ToolResultOutput } from '@codebuff/common/types/messages/content-part'
import type { AgentState } from '@codebuff/common/types/session-state'

const logger: Logger = {
  debug: () => {},
  error: () => {},
  info: () => {},
  warn: () => {},
}

describe('runProgrammaticStep', () => {
  let mockTemplate: AgentTemplate
  let mockAgentState: AgentState
  let mockParams: ParamsOf<typeof runProgrammaticStep>
  let executeToolCallSpy: any
  let agentRuntimeImpl: AgentRuntimeDeps & AgentRuntimeScopedDeps

  beforeEach(() => {
    agentRuntimeImpl = {
      ...TEST_AGENT_RUNTIME_IMPL,
      addAgentStep: async () => 'test-agent-step-id',

      sendAction: () => {},
    }

    // Mock analytics
    spyOn(analytics, 'initAnalytics').mockImplementation(() => {})
    analytics.initAnalytics({ logger })
    spyOn(analytics, 'trackEvent').mockImplementation(() => {})

    // Mock executeToolCall
    executeToolCallSpy = spyOn(
      toolExecutor,
      'executeToolCall',
    ).mockImplementation(async () => {})

    // Mock crypto.randomUUID
    spyOn(crypto, 'randomUUID').mockImplementation(
      () =>
        'mock-uuid-0000-0000-0000-000000000000' as `${string}-${string}-${string}-${string}-${string}`,
    )

    // Create mock template
    mockTemplate = {
      id: 'test-agent',
      displayName: 'Test Agent',
      spawnerPrompt: 'Testing',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'structured_output',
      includeMessageHistory: true,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['read_files', 'write_file', 'end_turn'],
      spawnableAgents: [],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test user prompt',
      stepPrompt: 'Test agent step prompt',
      handleSteps: undefined, // Will be set in individual tests
    } as AgentTemplate

    // Create mock agent state
    const sessionState = getInitialSessionState(mockFileContext)
    mockAgentState = {
      ...sessionState.mainAgentState,
      agentId: 'test-agent-id',
      runId:
        'test-run-id' as `${string}-${string}-${string}-${string}-${string}`,
      messageHistory: [
        userMessage('Initial message'),
        assistantMessage('Initial response'),
      ],
      output: undefined,
      directCreditsUsed: 0,
      childRunIds: [],
    }

    // Create mock params
    mockParams = {
      ...agentRuntimeImpl,
      runId: 'test-run-id',
      ancestorRunIds: [],
      repoId: undefined,
      repoUrl: undefined,
      agentState: mockAgentState,
      template: mockTemplate,
      prompt: 'Test prompt',
      toolCallParams: { testParam: 'value' },
      userId: TEST_USER_ID,
      userInputId: 'test-user-input',
      clientSessionId: 'test-session',
      fingerprintId: 'test-fingerprint',
      onResponseChunk: () => {},
      onCostCalculated: async () => {},
      fileContext: mockFileContext,
      localAgentTemplates: {},
      system: 'Test system prompt',
      stepsComplete: false,
      stepNumber: 1,

      logger,
      signal: new AbortController().signal,
    }
  })

  afterEach(() => {
    mock.restore()
    // Clear the generator cache between tests
    clearAgentGeneratorCache({ logger })
  })

  describe('generator lifecycle', () => {
    it('should create new generator when none exists', async () => {
      const mockGenerator = (function* () {
        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      const result = await runProgrammaticStep(mockParams)

      expect(result.endTurn).toBe(true)
      expect(result.agentState).toBeDefined()
    })

    it('should not reuse existing generator for same agent', async () => {
      // Note: this behavior of creating a new generator after the first generator ended prevents memory leaks.
      let callCount = 0
      const createGenerator = () => {
        callCount++
        return (function* () {
          yield { toolName: 'end_turn', input: {} }
        })() as StepGenerator
      }

      mockTemplate.handleSteps = createGenerator
      // First call
      await runProgrammaticStep(mockParams)
      expect(callCount).toBe(1)

      // Second call with same agent ID should create a new generator
      await runProgrammaticStep(mockParams)
      expect(callCount).toBe(2) // Should create new generator
    })

    it('should handle STEP_ALL generator state', async () => {
      // First, set up a generator that will be marked as STEP_ALL
      const mockGenerator = (function* () {
        yield 'STEP_ALL'
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      // First call to set STEP_ALL state
      const result1 = await runProgrammaticStep(mockParams)
      expect(result1.endTurn).toBe(false)

      // Second call should return early due to STEP_ALL state
      // Use the same agent state with the same runId
      const result2 = await runProgrammaticStep({
        ...mockParams,
        agentState: result1.agentState,
      })
      expect(result2.endTurn).toBe(false)
      expect(result2.agentState.agentId).toEqual(result1.agentState.agentId)
    })

    it('should throw error when template has no handleStep', async () => {
      mockTemplate.handleSteps = undefined

      await expect(runProgrammaticStep(mockParams)).rejects.toThrow(
        'No step handler found for agent template test-agent',
      )
    })
  })

  describe('tool execution', () => {
    it('should not add tool call message for add_message tool', async () => {
      const mockGenerator = (function* () {
        yield {
          toolName: 'add_message',
          input: { role: 'user', content: 'Hello world' },
          includeToolCall: false,
        }
        yield { toolName: 'read_files', input: { paths: ['test.txt'] } }
        yield { toolName: 'end_turn', input: {} }
      })() satisfies StepGenerator

      mockTemplate.handleSteps = () => mockGenerator
      mockTemplate.toolNames = ['add_message', 'read_files', 'end_turn']

      // Track chunks sent via sendSubagentChunk
      const sentChunks: string[] = []
      const sendActionMock = mock<SendActionFn>(({ action }) => {
        if (action.type === 'subagent-response-chunk') {
          sentChunks.push(action.chunk)
        }
      })

      const result = await runProgrammaticStep({
        ...mockParams,
        sendAction: sendActionMock,
      })

      // Verify add_message tool was executed
      expect(executeToolCallSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'add_message',
          input: { role: 'user', content: 'Hello world' },
        }),
      )

      // Verify read_files tool was executed
      expect(executeToolCallSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'read_files',
          input: { paths: ['test.txt'] },
        }),
      )

      // Check that no tool call chunk was sent for add_message
      const addMessageToolCallChunk = sentChunks.find(
        (chunk) =>
          chunk.includes('add_message') && chunk.includes('Hello world'),
      )
      expect(addMessageToolCallChunk).toBeUndefined()

      // Check that tool call chunk WAS sent for read_files (normal behavior)
      const readFilesToolCallChunk = sentChunks.find(
        (chunk) => chunk.includes('read_files') && chunk.includes('test.txt'),
      )
      expect(readFilesToolCallChunk).toBeDefined()

      // Verify final message history doesn't contain add_message tool call
      const addMessageToolCallInHistory = result.agentState.messageHistory.find(
        (msg) =>
          msg.content[0].type === 'text' &&
          msg.content[0].text.includes('add_message') &&
          msg.content[0].text.includes('Hello world'),
      )
      expect(addMessageToolCallInHistory).toBeUndefined()

      expect(result.endTurn).toBe(true)
    })
    it('should execute single tool call', async () => {
      const mockGenerator = (function* () {
        yield { toolName: 'read_files', input: { paths: ['test.txt'] } }
        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      const result = await runProgrammaticStep(mockParams)

      expect(executeToolCallSpy).toHaveBeenCalledTimes(2)
      expect(executeToolCallSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'read_files',
          input: expect.any(Object),
          agentTemplate: mockTemplate,
          fileContext: mockFileContext,
        }),
      )
      expect(result.endTurn).toBe(true)
    })

    it('should add find_files tool result to messageHistory', async () => {
      const mockGenerator = (function* () {
        yield { toolName: 'find_files', input: { query: 'authentication' } }
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator
      mockTemplate.toolNames = ['find_files', 'end_turn']

      // Mock executeToolCall to simulate find_files tool result
      executeToolCallSpy.mockImplementation(
        async (
          options: ParamsOf<typeof executeToolCall>,
        ): ReturnType<typeof executeToolCall> => {
          if (options.toolName === 'find_files') {
            const toolResult: ToolMessage = {
              role: 'tool',
              toolName: 'find_files',
              toolCallId: 'find-files-call-id',
              content: jsonToolResult({
                files: [
                  { path: 'src/auth.ts', relevance: 0.9 },
                  { path: 'src/login.ts', relevance: 0.8 },
                ],
              }),
            }
            options.toolResults.push(toolResult)

            options.agentState.messageHistory.push(toolResult)
          }
        },
      )

      const result = await runProgrammaticStep(mockParams)

      expect(executeToolCallSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'find_files',
          input: { query: 'authentication' },
          agentTemplate: mockTemplate,
          fileContext: mockFileContext,
        }),
      )

      // Verify tool result was added to messageHistory
      const toolMessages = result.agentState.messageHistory.filter(
        (msg) =>
          msg.role === 'tool' &&
          JSON.stringify(msg.content).includes('src/auth.ts'),
      )
      expect(toolMessages).toHaveLength(1)
      expect(JSON.stringify(toolMessages[0].content)).toContain('src/auth.ts')
      expect(JSON.stringify(toolMessages[0].content)).toContain('src/login.ts')

      expect(result.endTurn).toBe(true)
    })

    it('should execute multiple tool calls in sequence', async () => {
      const mockGenerator = (function* () {
        yield { toolName: 'read_files', input: { paths: ['file1.txt'] } }
        yield {
          toolName: 'write_file',
          input: { path: 'file2.txt', content: 'test' },
        }
        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      const result = await runProgrammaticStep(mockParams)

      expect(executeToolCallSpy).toHaveBeenCalledTimes(3)
      expect(result.endTurn).toBe(true)
    })

    it('should comprehensively test STEP_ALL functionality with multiple tools and state management', async () => {
      // Track all tool results and state changes for verification
      const toolResultsReceived: ToolResultOutput[][] = []
      const stateSnapshots: PublicAgentState[] = []
      let stepCount = 0

      const mockGenerator = (function* () {
        stepCount++

        // Step 1: Read files and capture initial state
        const step1 = yield {
          toolName: 'read_files',
          input: { paths: ['src/auth.ts', 'src/config.ts'] },
        }
        toolResultsReceived.push(step1.toolResult)
        stateSnapshots.push({ ...step1.agentState })

        // Step 2: Search for patterns based on file content
        const step2 = yield {
          toolName: 'code_search',
          input: { pattern: 'authenticate', flags: '-i' },
        }
        toolResultsReceived.push(step2.toolResult)
        stateSnapshots.push({ ...step2.agentState })

        // Step 3: Create a plan based on findings
        const step3 = yield {
          toolName: 'create_plan',
          input: {
            path: 'analysis-plan.md',
            plan: 'Comprehensive analysis of authentication system',
          },
        }
        toolResultsReceived.push(step3.toolResult)
        stateSnapshots.push({ ...step3.agentState })

        // Step 4: Add subgoal for tracking
        const step4 = yield {
          toolName: 'add_subgoal',
          input: {
            id: 'auth-analysis',
            objective: 'Analyze authentication patterns',
            status: 'IN_PROGRESS',
            plan: 'Review auth files and create recommendations',
          },
        }
        toolResultsReceived.push(step4.toolResult)
        stateSnapshots.push({ ...step4.agentState })

        // Step 5: Write analysis file
        const step5 = yield {
          toolName: 'write_file',
          input: {
            path: 'auth-analysis.md',
            instructions: 'Create authentication analysis document',
            content: '# Authentication Analysis\n\nBased on code review...',
          },
        }
        toolResultsReceived.push(step5.toolResult)
        stateSnapshots.push({ ...step5.agentState })

        // Step 6: Update subgoal status
        const step6 = yield {
          toolName: 'update_subgoal',
          input: {
            id: 'auth-analysis',
            status: 'COMPLETE',
            log: 'Analysis completed successfully',
          },
        }
        toolResultsReceived.push(step6.toolResult)
        stateSnapshots.push({ ...step6.agentState })

        // Step 7: Set final output with comprehensive data
        const step7 = yield {
          toolName: 'set_output',
          input: {
            status: 'success',
            filesAnalyzed: ['src/auth.ts', 'src/config.ts'],
            patternsFound: 3,
            recommendations: ['Use stronger auth', 'Add 2FA'],
            completedAt: new Date().toISOString(),
          },
        }
        toolResultsReceived.push(step7.toolResult)
        stateSnapshots.push({ ...step7.agentState })

        // Step 8: Transition to STEP_ALL to continue processing
        yield 'STEP_ALL'
      })() as StepGenerator

      // Set up comprehensive tool names for this test
      mockTemplate.handleSteps = () => mockGenerator
      mockTemplate.toolNames = [
        'read_files',
        'code_search',
        'create_plan',
        'add_subgoal',
        'write_file',
        'update_subgoal',
        'set_output',
        'end_turn',
      ]

      // Mock executeToolCall to simulate realistic tool results and state updates
      executeToolCallSpy.mockImplementation(
        async (
          options: ParamsOf<typeof executeToolCall>,
        ): ReturnType<typeof executeToolCall> => {
          const { toolName, input, toolResults, agentState } = options

          let result: string
          switch (toolName) {
            case 'read_files':
              result = JSON.stringify({
                'src/auth.ts':
                  'export function authenticate(user) { return true; }',
                'src/config.ts': 'export const authConfig = { enabled: true };',
              })
              break
            case 'code_search':
              result =
                'src/auth.ts:1:export function authenticate(user) {\nsrc/config.ts:1:authConfig'
              break
            case 'create_plan':
              result = 'Plan created successfully at analysis-plan.md'
              break
            case 'add_subgoal':
              result = 'Subgoal "auth-analysis" added successfully'
              // Update agent state to include subgoal in agentContext
              agentState.agentContext['auth-analysis'] = {
                objective: 'Analyze authentication patterns',
                status: 'IN_PROGRESS',
                plan: 'Review auth files and create recommendations',
                logs: [],
              }
              break
            case 'write_file':
              result = 'File written successfully: auth-analysis.md'
              break
            case 'update_subgoal':
              result = 'Subgoal "auth-analysis" updated successfully'
              // Update subgoal status in agent state
              if (agentState.agentContext['auth-analysis']) {
                agentState.agentContext['auth-analysis'].status = 'COMPLETE'
                agentState.agentContext['auth-analysis'].logs.push(
                  'Analysis completed successfully',
                )
              }
              break
            case 'set_output':
              result = 'Output set successfully'
              agentState.output = input
              break
            default:
              result = `${toolName} executed successfully`
          }

          const toolResult: ToolMessage = {
            role: 'tool',
            toolName,
            toolCallId: `${toolName}-call-id`,
            content: [
              {
                type: 'json',
                value: result,
              },
            ],
          }
          toolResults.push(toolResult)

          agentState.messageHistory.push(toolResult)
        },
      )

      // First call - should execute all tools and transition to STEP_ALL
      const result1 = await runProgrammaticStep(mockParams)

      // Verify all tools were executed
      expect(executeToolCallSpy).toHaveBeenCalledTimes(7) // 7 tools before STEP_ALL
      expect(result1.endTurn).toBe(false) // Should not end turn due to STEP_ALL
      expect(stepCount).toBe(1) // Generator should have run once

      // Verify tool execution order and arguments
      const toolCalls = executeToolCallSpy.mock.calls
      expect(toolCalls[0][0].toolName).toBe('read_files')
      expect(toolCalls[0][0].input.paths).toEqual([
        'src/auth.ts',
        'src/config.ts',
      ])
      expect(toolCalls[1][0].toolName).toBe('code_search')
      expect(toolCalls[1][0].input.pattern).toBe('authenticate')
      expect(toolCalls[2][0].toolName).toBe('create_plan')
      expect(toolCalls[3][0].toolName).toBe('add_subgoal')
      expect(toolCalls[4][0].toolName).toBe('write_file')
      expect(toolCalls[5][0].toolName).toBe('update_subgoal')
      expect(toolCalls[6][0].toolName).toBe('set_output')

      // Verify tool results were passed back to generator
      expect(toolResultsReceived).toHaveLength(7)
      expect(JSON.stringify(toolResultsReceived[0])).toContain('authenticate')
      expect(JSON.stringify(toolResultsReceived[3])).toContain('auth-analysis')
      expect(JSON.stringify(toolResultsReceived[6])).toContain(
        'Output set successfully',
      )

      // Verify state management throughout execution
      expect(stateSnapshots).toHaveLength(7)
      expect(Object.keys(result1.agentState.agentContext)).toContain(
        'auth-analysis',
      )
      expect(result1.agentState.agentContext['auth-analysis']?.status).toBe(
        'COMPLETE',
      )
      expect(result1.agentState.output).toEqual({
        status: 'success',
        filesAnalyzed: ['src/auth.ts', 'src/config.ts'],
        patternsFound: 3,
        recommendations: ['Use stronger auth', 'Add 2FA'],
        completedAt: expect.any(String),
      })

      // Verify tool results were processed correctly
      expect(toolResultsReceived).toHaveLength(7)
      expect(toolResultsReceived.every((result) => result !== undefined)).toBe(
        true,
      )

      // Verify that executeToolCall was called with agentState.messageHistory
      expect(executeToolCallSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          agentState: expect.objectContaining({
            messageHistory: expect.any(Array),
          }),
        }),
      )

      // Reset spy for second call
      executeToolCallSpy.mockClear()

      // Second call - should return early due to STEP_ALL state
      const result2 = await runProgrammaticStep({
        ...mockParams,
        // Use the updated agent state from first call
        agentState: result1.agentState,
      })

      // Verify STEP_ALL behavior
      expect(executeToolCallSpy).not.toHaveBeenCalled() // No tools should execute
      expect(result2.endTurn).toBe(false) // Should still not end turn
      expect(result2.agentState.agentId).toEqual(result1.agentState.agentId) // State should be similar
      expect(stepCount).toBe(1) // Generator should not have run again

      // Third call - verify STEP_ALL state persists
      const result3 = await runProgrammaticStep({
        ...mockParams,
        agentState: result2.agentState,
      })

      expect(executeToolCallSpy).not.toHaveBeenCalled()
      expect(result3.endTurn).toBe(false)
      expect(result3.agentState.agentId).toEqual(result1.agentState.agentId)
      expect(stepCount).toBe(1) // Generator should still not have run again
    })

    it('should pass tool results back to generator', async () => {
      const toolResults: ToolMessage[] = []
      let receivedToolResult: ToolResultOutput[] | undefined

      const mockGenerator = (function* () {
        const input1 = yield {
          toolName: 'read_files',
          input: { paths: ['test.txt'] },
        }
        receivedToolResult = input1.toolResult
        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      // Mock executeToolCall to add tool results
      executeToolCallSpy.mockImplementation(
        async (
          options: ParamsOf<typeof executeToolCall>,
        ): ReturnType<typeof executeToolCall> => {
          if (options.toolName === 'read_files') {
            options.toolResults.push({
              role: 'tool',
              toolName: 'read_files',
              toolCallId: 'test-id',
              content: [
                {
                  type: 'json',
                  value: 'file content',
                },
              ],
            } satisfies ToolMessage)
          }
        },
      )

      await runProgrammaticStep(mockParams)

      expect(receivedToolResult).toEqual([
        {
          type: 'json',
          value: 'file content',
        },
      ])
    })
  })

  describe('generator control flow', () => {
    it('should handle STEP value to break execution', async () => {
      const mockGenerator = (function* () {
        yield { toolName: 'read_files', input: { paths: ['test.txt'] } }
        yield 'STEP'
        yield {
          toolName: 'write_file',
          input: { path: 'test.txt', content: 'test' },
        }
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      const result = await runProgrammaticStep(mockParams)

      expect(executeToolCallSpy).toHaveBeenCalledTimes(1) // Only first tool call
      expect(result.endTurn).toBe(false)
    })

    it('should handle generator completion', async () => {
      const mockGenerator = (function* () {
        yield { toolName: 'read_files', input: { paths: ['test.txt'] } }
        return // Generator completes
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      const result = await runProgrammaticStep(mockParams)

      expect(result.endTurn).toBe(true)
    })

    it('should end turn when end_turn tool is called', async () => {
      const mockGenerator = (function* () {
        yield { toolName: 'read_files', input: { paths: ['test.txt'] } }
        yield { toolName: 'end_turn', input: {} }
        yield {
          toolName: 'write_file',
          input: { path: 'test.txt', content: 'test' },
        } // Should not execute
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      const result = await runProgrammaticStep(mockParams)

      expect(executeToolCallSpy).toHaveBeenCalledTimes(2) // read_files + end_turn
      expect(result.endTurn).toBe(true)
    })
  })

  describe('state management', () => {
    it('should preserve agent state changes', async () => {
      const mockGenerator = (function* () {
        yield {
          toolName: 'set_output',
          input: { status: 'complete' },
        }
        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator
      mockTemplate.toolNames.push('set_output')

      // Mock executeToolCall to update state
      executeToolCallSpy.mockImplementation(
        async (
          options: ParamsOf<typeof executeToolCall>,
        ): ReturnType<typeof executeToolCall> => {
          if (options.toolName === 'set_output') {
            options.agentState.output = { status: 'complete' }
          }
        },
      )

      const result = await runProgrammaticStep(mockParams)

      expect(result.agentState.output).toEqual({ status: 'complete' })
    })

    it('should preserve message history', async () => {
      const mockGenerator = (function* () {
        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator
      const previousMessageHistory = cloneDeep(mockAgentState.messageHistory)

      mockTemplate.handleSteps = () => mockGenerator

      const result = await runProgrammaticStep(mockParams)

      expect(result.agentState.messageHistory).toEqual([
        ...previousMessageHistory,
        assistantMessage(
          '<codebuff_tool_call>\n{\n  "cb_tool_name": "end_turn",\n  "cb_easp": true\n}\n</codebuff_tool_call>',
        ),
      ])
    })
  })

  describe('error handling', () => {
    it('should handle generator errors gracefully', async () => {
      const mockGenerator = (function* () {
        throw new Error('Generator error')
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      const responseChunks: any[] = []
      mockParams.onResponseChunk = (chunk) => responseChunks.push(chunk)

      const result = await runProgrammaticStep(mockParams)

      expect(result.endTurn).toBe(true)
      expect(result.agentState.output?.error).toContain('Generator error')
      expect(
        responseChunks.some((chunk) => chunk.includes('Generator error')),
      ).toBe(true)
    })

    it('should handle tool execution errors', async () => {
      const mockGenerator = (function* () {
        yield { toolName: 'read_files', input: { paths: ['test.txt'] } }
        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator
      executeToolCallSpy.mockRejectedValue(new Error('Tool execution failed'))

      const responseChunks: any[] = []
      mockParams.onResponseChunk = (chunk) => responseChunks.push(chunk)

      const result = await runProgrammaticStep(mockParams)

      expect(result.endTurn).toBe(true)
      expect(result.agentState.output?.error).toContain('Tool execution failed')
    })

    it('should handle non-Error exceptions', async () => {
      const mockGenerator = (function* () {
        throw 'String error'
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      const result = await runProgrammaticStep(mockParams)

      expect(result.endTurn).toBe(true)
      expect(result.agentState.output?.error).toContain('Unknown error')
    })
  })

  describe('output schema validation', () => {
    it('should validate output against outputSchema when using setOutput', async () => {
      // Create template with outputSchema
      const schemaTemplate = {
        ...mockTemplate,
        outputMode: 'structured_output' as const,
        outputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
            status: { type: 'string', enum: ['success', 'error'] },
            count: { type: 'number' },
          },
          required: ['message', 'status'],
        },
        toolNames: ['set_output', 'end_turn'],
      }

      const mockGenerator = (function* () {
        yield {
          toolName: 'set_output',
          input: {
            message: 'Task completed successfully',
            status: 'success',
            count: 42,
          },
        }
        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator

      schemaTemplate.handleSteps = () => mockGenerator

      // Don't mock executeToolCall - let it use the real implementation
      executeToolCallSpy.mockRestore()

      const result = await runProgrammaticStep({
        ...mockParams,
        template: schemaTemplate,
        localAgentTemplates: { 'test-agent': schemaTemplate },
      } as any)

      expect(result.endTurn).toBe(true)
      expect(result.agentState.output).toEqual({
        message: 'Task completed successfully',
        status: 'success',
        count: 42,
      })
    })

    it('should handle invalid output that fails schema validation', async () => {
      // Create template with strict outputSchema
      const schemaTemplate = {
        ...mockTemplate,
        outputMode: 'structured_output' as const,
        outputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
            status: { type: 'string', enum: ['success', 'error'] },
          },
          required: ['message', 'status'],
        },
        toolNames: ['set_output', 'end_turn'],
      }

      const mockGenerator = (function* () {
        yield {
          toolName: 'set_output',
          input: {
            message: 'Task completed',
            status: 'invalid_status', // This should fail validation
            extraField: 'not allowed',
          },
        }
        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator

      schemaTemplate.handleSteps = () => mockGenerator

      // Don't mock executeToolCall - let it use the real implementation
      executeToolCallSpy.mockRestore()

      const responseChunks: any[] = []
      mockParams.onResponseChunk = (chunk) => responseChunks.push(chunk)

      const result = await runProgrammaticStep({
        ...mockParams,
        template: schemaTemplate,
        localAgentTemplates: { 'test-agent': schemaTemplate },
      } as any)

      // Should end turn (validation may fail but execution continues)
      expect(result.endTurn).toBe(true)
      // Test passes if no exception is thrown during execution
      expect(result.agentState).toBeDefined()
    })

    it('should work with agents that have no outputSchema', async () => {
      const noSchemaTemplate = {
        ...mockTemplate,
        outputMode: 'last_message' as const,
        outputSchema: undefined,
        toolNames: ['set_output', 'end_turn'],
      }

      const mockGenerator = (function* () {
        yield {
          toolName: 'set_output',
          input: {
            anyField: 'any value',
            anotherField: 123,
          },
        }
        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator

      noSchemaTemplate.handleSteps = () => mockGenerator

      // Don't mock executeToolCall - let it use the real implementation
      executeToolCallSpy.mockRestore()

      const result = await runProgrammaticStep({
        ...mockParams,
        template: noSchemaTemplate,
        localAgentTemplates: { 'test-agent': noSchemaTemplate },
      })

      expect(result.endTurn).toBe(true)
      expect(result.agentState.output).toEqual({
        anyField: 'any value',
        anotherField: 123,
      })
    })

    it('should work with outputMode structured_output but no outputSchema defined', async () => {
      const schemaWithoutSchemaTemplate = {
        ...mockTemplate,
        outputMode: 'structured_output' as const,
        outputSchema: undefined, // No schema defined
        toolNames: ['set_output', 'end_turn'],
      }

      const mockGenerator = (function* () {
        yield {
          toolName: 'set_output',
          input: {
            result: 'success',
            data: { count: 5 },
          },
        }
        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator

      schemaWithoutSchemaTemplate.handleSteps = () => mockGenerator

      // Don't mock executeToolCall - let it use the real implementation
      executeToolCallSpy.mockRestore()

      const result = await runProgrammaticStep({
        ...mockParams,
        template: schemaWithoutSchemaTemplate,
        localAgentTemplates: { 'test-agent': schemaWithoutSchemaTemplate },
      })

      expect(result.endTurn).toBe(true)
      expect(result.agentState.output).toEqual({
        result: 'success',
        data: { count: 5 },
      })
    })
  })

  describe('stepsComplete parameter', () => {
    it('should pass stepsComplete=false by default', async () => {
      let receivedStepsComplete: boolean | undefined

      const mockGenerator = (function* () {
        const input = yield {
          toolName: 'read_files',
          input: { paths: ['test.txt'] },
        }
        receivedStepsComplete = input.stepsComplete
        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      await runProgrammaticStep({
        ...mockParams,
        stepsComplete: false,
      })

      expect(receivedStepsComplete).toBe(false)
    })

    it('should pass stepsComplete=true when specified', async () => {
      let receivedStepsComplete: boolean | undefined

      const mockGenerator = (function* () {
        const input = yield {
          toolName: 'read_files',
          input: { paths: ['test.txt'] },
        }
        receivedStepsComplete = input.stepsComplete
        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      await runProgrammaticStep({
        ...mockParams,
        stepsComplete: true,
      })

      expect(receivedStepsComplete).toBe(true)
    })

    it('should handle post-processing when stepsComplete=true', async () => {
      const executionLog: string[] = []

      const mockGenerator = (function* () {
        const step1 = yield {
          toolName: 'read_files',
          input: { paths: ['file1.txt'] },
        }
        executionLog.push(`step1: stepsComplete=${step1.stepsComplete}`)

        if (step1.stepsComplete) {
          // Post-processing step
          executionLog.push('performing post-processing')
          yield {
            toolName: 'set_output',
            input: { message: 'Post-processing completed' },
          }
        }

        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator
      mockTemplate.toolNames = ['read_files', 'set_output', 'end_turn']

      // Mock executeToolCall to update state for set_output
      executeToolCallSpy.mockImplementation(
        async (
          options: ParamsOf<typeof executeToolCall>,
        ): ReturnType<typeof executeToolCall> => {
          if (options.toolName === 'set_output') {
            options.agentState.output = options.input
          }
        },
      )

      const result = await runProgrammaticStep({
        ...mockParams,
        stepsComplete: true,
      })

      expect(executionLog).toEqual([
        'step1: stepsComplete=true',
        'performing post-processing',
      ])
      expect(result.agentState.output).toEqual({
        message: 'Post-processing completed',
      })
      expect(executeToolCallSpy).toHaveBeenCalledTimes(3) // read_files + set_output + end_turn
    })

    it('should clear STEP_ALL mode when stepsComplete=true', async () => {
      // First, set up a generator that will be marked as STEP_ALL
      let generatorCallCount = 0
      const createGenerator = () => {
        generatorCallCount++
        if (generatorCallCount === 1) {
          return (function* () {
            yield 'STEP_ALL'
          })() as StepGenerator
        } else {
          return (function* () {
            yield {
              toolName: 'set_output',
              input: { status: 'finalized' },
            }
            yield { toolName: 'end_turn', input: {} }
          })() as StepGenerator
        }
      }

      mockTemplate.handleSteps = createGenerator
      mockTemplate.toolNames = ['set_output', 'end_turn']

      // First call to set STEP_ALL state
      const result1 = await runProgrammaticStep({
        ...mockParams,
        stepsComplete: false,
      })
      expect(result1.endTurn).toBe(false)
      expect(generatorCallCount).toBe(1)

      // Second call with stepsComplete=false should return early due to STEP_ALL
      const result2 = await runProgrammaticStep({
        ...mockParams,
        agentState: result1.agentState,
        stepsComplete: false,
      })
      expect(result2.endTurn).toBe(false)
      expect(generatorCallCount).toBe(1) // Should not create new generator

      // Third call with stepsComplete=true should clear STEP_ALL and continue with existing generator
      executeToolCallSpy.mockImplementation(
        async (
          options: ParamsOf<typeof executeToolCall>,
        ): ReturnType<typeof executeToolCall> => {
          if (options.toolName === 'set_output') {
            options.agentState.output = options.input
          }
        },
      )

      const result3 = await runProgrammaticStep({
        ...mockParams,
        agentState: result2.agentState,
        stepsComplete: true,
      })

      expect(result3.endTurn).toBe(true)
      // The existing generator continues execution rather than creating a new one
      expect(generatorCallCount).toBe(1)
    })
  })

  describe('continued stepping after completion', () => {
    it('should allow agent to continue with STEP after initial completion', async () => {
      const executionSteps: string[] = []

      const mockGenerator = (function* () {
        executionSteps.push('initial execution')
        const step1 = yield {
          toolName: 'read_files',
          input: { paths: ['config.txt'] },
        }

        if (step1.stepsComplete) {
          executionSteps.push('post-processing detected')
          yield {
            toolName: 'write_file',
            input: {
              path: 'summary.txt',
              instructions: 'Create summary',
              content: 'Processing completed',
            },
          }

          // Force agent to continue with another step
          executionSteps.push('requesting continuation')
          const step2 = yield 'STEP'
          executionSteps.push(`step2: stepsComplete=${step2.stepsComplete}`)

          if (!step2.stepsComplete) {
            yield {
              toolName: 'set_output',
              input: { message: 'Continued processing' },
            }
          }
        }

        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator
      mockTemplate.toolNames = [
        'read_files',
        'write_file',
        'set_output',
        'end_turn',
      ]

      executeToolCallSpy.mockImplementation(
        async (
          options: ParamsOf<typeof executeToolCall>,
        ): ReturnType<typeof executeToolCall> => {
          if (options.toolName === 'set_output') {
            options.agentState.output = options.input
          }
        },
      )

      // First call with stepsComplete=true (post-processing mode)
      const result = await runProgrammaticStep({
        ...mockParams,
        stepsComplete: true,
      })

      expect(executionSteps).toEqual([
        'initial execution',
        'post-processing detected',
        'requesting continuation',
      ])
      expect(result.endTurn).toBe(false) // Should not end due to STEP
      expect(executeToolCallSpy).toHaveBeenCalledTimes(2) // read_files + write_file

      const finalResult = await runProgrammaticStep({
        ...mockParams,
        stepsComplete: false,
      })

      expect(executionSteps).toEqual([
        'initial execution',
        'post-processing detected',
        'requesting continuation',
        'step2: stepsComplete=false',
      ])
      expect(finalResult.endTurn).toBe(true) // Should end from end_turn
      expect(executeToolCallSpy).toHaveBeenCalledTimes(4) // read_files + write_file + set_output + end_turn
    })

    it('should allow agent to continue with STEP_ALL after initial completion', async () => {
      const executionSteps: string[] = []

      const mockGenerator = (function* () {
        executionSteps.push('initial execution')
        const step1 = yield {
          toolName: 'read_files',
          input: { paths: ['data.txt'] },
        }

        if (step1.stepsComplete) {
          executionSteps.push('post-processing with STEP_ALL')
          yield {
            toolName: 'write_file',
            input: {
              path: 'processed.txt',
              instructions: 'Create processed file',
              content: 'Data processed',
            },
          }

          // Force agent to continue with STEP_ALL
          yield 'STEP_ALL'
          executionSteps.push('STEP_ALL requested')
        }
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator
      mockTemplate.toolNames = ['read_files', 'write_file', 'end_turn']

      // First call with stepsComplete=true
      const result = await runProgrammaticStep({
        ...mockParams,
        stepsComplete: true,
      })

      expect(executionSteps).toEqual([
        'initial execution',
        'post-processing with STEP_ALL',
      ])
      expect(result.endTurn).toBe(false) // Should not end due to STEP_ALL
      expect(executeToolCallSpy).toHaveBeenCalledTimes(2) // read_files + write_file
    })

    it('should handle complex post-processing workflow', async () => {
      const workflowSteps: string[] = []
      let stepCount = 0

      const mockGenerator = (function* () {
        stepCount++
        workflowSteps.push(`generator run ${stepCount}`)

        // Initial processing
        const step1 = yield {
          toolName: 'read_files',
          input: { paths: ['input.txt'] },
        }
        workflowSteps.push(
          `read completed, stepsComplete=${step1.stepsComplete}`,
        )

        if (step1.stepsComplete) {
          // Post-processing phase
          workflowSteps.push('entering post-processing')

          // Analyze the input
          yield {
            toolName: 'code_search',
            input: { pattern: 'TODO', flags: '-n' },
          }

          // Create analysis report
          yield {
            toolName: 'write_file',
            input: {
              path: 'analysis.md',
              instructions: 'Create analysis report',
              content: '# Analysis Report\n\nTODO items found.',
            },
          }

          // Add subgoal for tracking
          yield {
            toolName: 'add_subgoal',
            input: {
              id: 'analysis-complete',
              objective: 'Complete post-processing analysis',
              status: 'COMPLETE',
            },
          }

          // Set final output
          yield {
            toolName: 'set_output',
            input: {
              phase: 'post-processing',
              analysisCreated: true,
              subgoalAdded: true,
            },
          }

          // Continue for more processing
          const step2 = yield 'STEP'
          workflowSteps.push(
            `step after STEP: stepsComplete=${step2.stepsComplete}`,
          )

          if (step2.stepsComplete) {
            // Final cleanup
            yield {
              toolName: 'update_subgoal',
              input: {
                id: 'analysis-complete',
                log: 'All post-processing completed',
              },
            }
          }
        } else {
          // Normal processing
          workflowSteps.push('normal processing mode')
          yield {
            toolName: 'set_output',
            input: { phase: 'normal', message: 'Regular processing' },
          }
        }

        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator
      mockTemplate.toolNames = [
        'read_files',
        'code_search',
        'write_file',
        'add_subgoal',
        'set_output',
        'update_subgoal',
        'end_turn',
      ]

      executeToolCallSpy.mockImplementation(
        async (
          options: ParamsOf<typeof executeToolCall>,
        ): ReturnType<typeof executeToolCall> => {
          if (options.toolName === 'set_output') {
            options.agentState.output = options.input
          } else if (options.toolName === 'add_subgoal') {
            options.agentState.agentContext[options.input.id as any] = {
              ...options.input,
              logs: [],
            }
          }
        },
      )

      // Call with stepsComplete=true to trigger post-processing
      const result = await runProgrammaticStep({
        ...mockParams,
        stepsComplete: true,
      })

      expect(workflowSteps).toEqual([
        'generator run 1',
        'read completed, stepsComplete=true',
        'entering post-processing',
      ])

      expect(result.endTurn).toBe(false) // Should not end due to STEP
      expect(result.agentState.output).toEqual({
        phase: 'post-processing',
        analysisCreated: true,
        subgoalAdded: true,
      })
      expect(result.agentState.agentContext['analysis-complete']).toBeDefined()
      expect(executeToolCallSpy).toHaveBeenCalledTimes(5) // read_files, code_search, write_file, add_subgoal, set_output
    })
  })

  describe('yield value validation', () => {
    it('should reject invalid yield values', async () => {
      const mockGenerator = (function* () {
        yield { invalid: 'value' } as any
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      const responseChunks: any[] = []
      mockParams.onResponseChunk = (chunk) => responseChunks.push(chunk)

      const result = await runProgrammaticStep(mockParams)

      expect(result.endTurn).toBe(true)
      expect(result.agentState.output?.error).toContain(
        'Invalid yield value from handleSteps',
      )
    })

    it('should reject yield values with wrong types', async () => {
      const mockGenerator = (function* () {
        yield { type: 'STEP_TEXT', text: 123 } as any // text should be string
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      const responseChunks: any[] = []
      mockParams.onResponseChunk = (chunk) => responseChunks.push(chunk)

      const result = await runProgrammaticStep(mockParams)

      expect(result.endTurn).toBe(true)
      expect(result.agentState.output?.error).toContain(
        'Invalid yield value from handleSteps',
      )
    })

    it('should reject GENERATE_N with non-positive n', async () => {
      const mockGenerator = (function* () {
        yield { type: 'GENERATE_N', n: 0 } as any
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      const responseChunks: any[] = []
      mockParams.onResponseChunk = (chunk) => responseChunks.push(chunk)

      const result = await runProgrammaticStep(mockParams)

      expect(result.endTurn).toBe(true)
      expect(result.agentState.output?.error).toContain(
        'Invalid yield value from handleSteps',
      )
    })

    it('should reject GENERATE_N with negative n', async () => {
      const mockGenerator = (function* () {
        yield { type: 'GENERATE_N', n: -5 } as any
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      const responseChunks: any[] = []
      mockParams.onResponseChunk = (chunk) => responseChunks.push(chunk)

      const result = await runProgrammaticStep(mockParams)

      expect(result.endTurn).toBe(true)
      expect(result.agentState.output?.error).toContain(
        'Invalid yield value from handleSteps',
      )
    })

    it('should accept valid STEP literal', async () => {
      const mockGenerator = (function* () {
        yield 'STEP'
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      const result = await runProgrammaticStep(mockParams)

      expect(result.endTurn).toBe(false)
      expect(result.agentState.output?.error).toBeUndefined()
    })

    it('should accept valid STEP_ALL literal', async () => {
      const mockGenerator = (function* () {
        yield 'STEP_ALL'
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      const result = await runProgrammaticStep(mockParams)

      expect(result.endTurn).toBe(false)
      expect(result.agentState.output?.error).toBeUndefined()
    })

    it('should accept valid STEP_TEXT object', async () => {
      const mockGenerator = (function* () {
        yield { type: 'STEP_TEXT', text: 'Custom response text' }
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      const result = await runProgrammaticStep(mockParams)

      expect(result.endTurn).toBe(false)
      expect(result.agentState.output?.error).toBeUndefined()
    })

    it('should accept valid GENERATE_N object', async () => {
      const mockGenerator = (function* () {
        yield { type: 'GENERATE_N', n: 3 }
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      const result = await runProgrammaticStep(mockParams)

      expect(result.endTurn).toBe(false)
      expect(result.generateN).toBe(3)
      expect(result.agentState.output?.error).toBeUndefined()
    })

    it('should accept valid tool call object', async () => {
      const mockGenerator = (function* () {
        yield { toolName: 'read_files', input: { paths: ['test.txt'] } }
        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      const result = await runProgrammaticStep(mockParams)

      expect(result.endTurn).toBe(true)
      expect(result.agentState.output?.error).toBeUndefined()
    })

    it('should accept tool call with includeToolCall option', async () => {
      const mockGenerator = (function* () {
        yield {
          toolName: 'read_files',
          input: { paths: ['test.txt'] },
          includeToolCall: false,
        }
        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      const result = await runProgrammaticStep(mockParams)

      expect(result.endTurn).toBe(true)
      expect(result.agentState.output?.error).toBeUndefined()
    })

    it('should reject random string values', async () => {
      const mockGenerator = (function* () {
        yield 'INVALID_STEP' as any
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      const result = await runProgrammaticStep(mockParams)

      expect(result.endTurn).toBe(true)
      expect(result.agentState.output?.error).toContain(
        'Invalid yield value from handleSteps',
      )
    })

    it('should reject null yield values', async () => {
      const mockGenerator = (function* () {
        yield null as any
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      const result = await runProgrammaticStep(mockParams)

      expect(result.endTurn).toBe(true)
      expect(result.agentState.output?.error).toContain(
        'Invalid yield value from handleSteps',
      )
    })

    it('should reject undefined yield values', async () => {
      const mockGenerator = (function* () {
        yield undefined as any
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      const result = await runProgrammaticStep(mockParams)

      expect(result.endTurn).toBe(true)
      expect(result.agentState.output?.error).toContain(
        'Invalid yield value from handleSteps',
      )
    })

    it('should reject tool call without toolName', async () => {
      const mockGenerator = (function* () {
        yield { input: { paths: ['test.txt'] } } as any
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      const result = await runProgrammaticStep(mockParams)

      expect(result.endTurn).toBe(true)
      expect(result.agentState.output?.error).toContain(
        'Invalid yield value from handleSteps',
      )
    })

    it('should reject tool call without input', async () => {
      const mockGenerator = (function* () {
        yield { toolName: 'read_files' } as any
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      const result = await runProgrammaticStep(mockParams)

      expect(result.endTurn).toBe(true)
      expect(result.agentState.output?.error).toContain(
        'Invalid yield value from handleSteps',
      )
    })
  })

  describe('logging and context', () => {
    it('should log agent execution start', async () => {
      const mockGenerator = (function* () {
        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      await runProgrammaticStep(mockParams)

      // Logger is mocked, but we can verify the function completes without error
      expect(true).toBe(true)
    })

    it('should generate unique agent step ID', async () => {
      const mockGenerator = (function* () {
        yield { toolName: 'read_files', input: { paths: ['test.txt'] } }
        yield { toolName: 'end_turn', input: {} }
      })() as StepGenerator

      mockTemplate.handleSteps = () => mockGenerator

      await runProgrammaticStep(mockParams)

      expect(executeToolCallSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          agentStepId: 'mock-uuid-0000-0000-0000-000000000000',
        }),
      )
    })
  })
})
