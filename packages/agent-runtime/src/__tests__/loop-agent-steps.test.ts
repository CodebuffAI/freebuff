import * as analytics from '@codebuff/common/analytics'
import { FREEBUFF_TURN_SPEND_LIMIT_MESSAGE } from '@codebuff/common/constants/freebuff-errors'
import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { createTestAgentRuntimeParams } from '@codebuff/common/testing/fixtures/agent-runtime'
import { clearMockedModules } from '@codebuff/common/testing/mock-modules'
import {
  createMockDbOperations,
  setupDbSpies,
} from '@codebuff/common/testing/mocks/database'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { AbortError, promptSuccess } from '@codebuff/common/util/error'
import { assistantMessage, userMessage } from '@codebuff/common/util/messages'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import { APICallError, RetryError } from 'ai'
import { z } from 'zod/v4'

import { loopAgentSteps } from '../run-agent-step'
import { clearAgentGeneratorCache } from '../run-programmatic-step'
import {
  MAX_CONSECUTIVE_STREAM_RECOVERIES,
  OUTPUT_LIMIT_TAG,
  REPEATED_OUTPUT_LIMIT_MESSAGE,
  REPEATED_STREAM_INTERRUPTIONS_MESSAGE,
  STREAM_INTERRUPTED_TAG,
} from '../tools/stream-parser'
import { createToolCallChunk, mockFileContext } from './test-utils'

import type { AgentTemplate } from '../templates/types'
import type { DbSpies } from '@codebuff/common/testing/mocks/database'
import type { StepGenerator } from '@codebuff/common/types/agent-template'
import type { AgentState } from '@codebuff/common/types/session-state'

describe('loopAgentSteps - runAgentStep vs runProgrammaticStep behavior', () => {
  let mockTemplate: AgentTemplate
  let mockAgentState: AgentState
  let llmCallCount: number
  let agentRuntimeImpl: Omit<
    ReturnType<typeof createTestAgentRuntimeParams>,
    'agentTemplate' | 'localAgentTemplates'
  > & {
    promptAiSdkStream?: ReturnType<typeof mock>
  }
  let loopAgentStepsBaseParams: Parameters<typeof loopAgentSteps>[0]
  let dbSpies: DbSpies

  beforeAll(async () => {
    // Set up mocks.
  })

  beforeEach(() => {
    const {
      agentTemplate: _,
      localAgentTemplates: __,
      ...baseRuntimeParams
    } = createTestAgentRuntimeParams()

    agentRuntimeImpl = {
      ...baseRuntimeParams,
    }

    llmCallCount = 0

    // Setup spies for database operations using typed helper
    dbSpies = setupDbSpies(createMockDbOperations())

    agentRuntimeImpl.promptAiSdkStream = mock(async function* ({}) {
      llmCallCount++
      yield { type: 'text' as const, text: 'LLM response\n\n' }
      yield createToolCallChunk('end_turn', {})
      return promptSuccess('mock-message-id')
    })

    // Mock analytics
    spyOn(analytics, 'trackEvent').mockImplementation(() => {})

    // Mock crypto.randomUUID
    spyOn(crypto, 'randomUUID').mockImplementation(
      () => 'mock-uuid-0000-0000-0000-000000000000' as const,
    )

    // Create mock template with programmatic agent
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
    } satisfies AgentTemplate as AgentTemplate

    // Create mock agent state
    const sessionState = getInitialSessionState(mockFileContext)
    mockAgentState = {
      ...sessionState.mainAgentState,
      agentId: 'test-agent-id',
      messageHistory: [
        userMessage('Initial message'),
        assistantMessage('Initial response'),
      ],
      output: undefined,
      stepsRemaining: 10, // Ensure we don't hit the limit
    }

    loopAgentStepsBaseParams = {
      ...agentRuntimeImpl,
      agentType: 'test-agent',
      localAgentTemplates: { 'test-agent': mockTemplate },
      repoId: undefined,
      repoUrl: undefined,
      userInputId: 'test-user-input',
      agentState: mockAgentState,
      prompt: 'Test prompt',
      spawnParams: undefined,
      fingerprintId: 'test-fingerprint',
      fileContext: mockFileContext,
      userId: TEST_USER_ID,
      clientSessionId: 'test-session',
      ancestorRunIds: [],
      onResponseChunk: () => {},
      signal: new AbortController().signal,
    }
  })

  afterEach(() => {
    clearAgentGeneratorCache(agentRuntimeImpl)
    dbSpies.restore()
    mock.restore()
    const {
      agentTemplate: _,
      localAgentTemplates: __,
      ...baseRuntimeParams
    } = createTestAgentRuntimeParams()
    agentRuntimeImpl = {
      ...baseRuntimeParams,
    }
  })

  afterAll(() => {
    clearMockedModules()
  })

  it('retains completed steps after a spending cap and resumes under a new run id', async () => {
    mockTemplate.handleSteps = function* () {
      yield 'STEP'
      yield 'STEP'
    }
    let calls = 0
    const capped = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      startAgentRun: async () => 'capped-run',
      promptAiSdkStream: async function* () {
        if (++calls === 2) {
          throw new APICallError({
            statusCode: 429,
            message: FREEBUFF_TURN_SPEND_LIMIT_MESSAGE,
            url: 'http://localhost/api/v1/chat/completions',
            requestBodyValues: {},
            responseBody: JSON.stringify({
              error: 'turn_spend_limit',
              message: FREEBUFF_TURN_SPEND_LIMIT_MESSAGE,
            }),
            isRetryable: false,
          })
        }
        yield { type: 'text' as const, text: 'Completed research: result 42.' }
        yield createToolCallChunk('end_turn', {})
        return promptSuccess('completed-step')
      },
    })
    expect(calls).toBe(2)
    expect(capped.output).toMatchObject({
      type: 'error',
      error: 'turn_spend_limit',
    })
    expect(JSON.stringify(capped.agentState.messageHistory)).toContain(
      'Completed research: result 42.',
    )
    expect(capped.agentState.runId).toBe('capped-run')

    const resumed = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentState: capped.agentState,
      prompt: 'Continue',
      startAgentRun: async () => 'fresh-run',
    })
    expect(resumed.output.type).not.toBe('error')
    expect(resumed.agentState.runId).toBe('fresh-run')
    const history = JSON.stringify(resumed.agentState.messageHistory)
    expect(history).toContain('Completed research: result 42.')
    expect(history).toContain('Continue')
  })

  it('an abort during agent-run registration is a cancel, not a failed run', async () => {
    // registration ends on the run's signal now, so the null it returns under an abort is the
    // abort itself and must read like every other cancel
    const controller = new AbortController()
    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      signal: controller.signal,
      startAgentRun: async () => {
        controller.abort()
        return null
      },
    })
    expect(result.output).toEqual({
      type: 'error',
      message: 'Run cancelled by user',
    })
    expect(llmCallCount).toBe(0)
  })

  it('should verify correct STEP behavior - LLM called once after STEP', async () => {
    // This test verifies that when a programmatic agent yields STEP,
    // the LLM should be called once in the next iteration

    let stepCount = 0
    const mockGeneratorFunction = function* () {
      stepCount++
      // Execute a tool, then STEP
      yield { toolName: 'read_files', input: { paths: ['file1.txt'] } }
      yield 'STEP' // Should pause here and let LLM run
      // Continue after LLM runs (this won't be reached in this test since LLM ends turn)
      yield {
        toolName: 'write_file',
        input: { path: 'output.txt', content: 'test' },
      }
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    console.log(`LLM calls made: ${llmCallCount}`)
    console.log(`Step count: ${stepCount}`)

    // CORRECT BEHAVIOR: After STEP, LLM should be called once
    // The programmatic agent yields STEP, then LLM runs once and ends turn
    expect(llmCallCount).toBe(1) // LLM called once after STEP

    // The programmatic agent should have been called once (yielded STEP)
    expect(stepCount).toBe(1)
  })

  it('should demonstrate correct behavior when programmatic agent completes without STEP', async () => {
    // This test shows that when a programmatic agent doesn't yield STEP,
    // it should complete without calling the LLM at all (since it ends with end_turn)

    const mockGeneratorFunction = function* () {
      yield { toolName: 'read_files', input: { paths: ['file1.txt'] } }
      yield {
        toolName: 'write_file',
        input: { path: 'output.txt', content: 'test' },
      }
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Should NOT call LLM since the programmatic agent ended with end_turn
    expect(llmCallCount).toBe(0)
    // The result should have agentState
    expect(result.agentState).toBeDefined()
  })

  it('should run programmatic step first, then LLM step, then continue', async () => {
    // This test verifies the correct execution order in loopAgentSteps:
    // 1. Programmatic step runs first and yields STEP
    // 2. LLM step runs once
    // 3. Loop continues but generator is complete after first STEP

    let stepCount = 0
    const mockGeneratorFunction = function* () {
      stepCount++
      // First execution: do some work, then STEP
      yield { toolName: 'read_files', input: { paths: ['file1.txt'] } }
      yield 'STEP' // Hand control to LLM
      // After LLM runs, continue (this happens in the same generator instance)
      yield {
        toolName: 'write_file',
        input: { path: 'output.txt', content: 'updated by LLM' },
      }
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Verify execution order:
    // 1. Programmatic step function was called once (creates generator)
    // 2. LLM was called once after STEP
    // 3. Generator continued after LLM step
    expect(stepCount).toBe(1) // Generator function called once
    expect(llmCallCount).toBe(1) // LLM called once after first STEP
    expect(result.agentState).toBeDefined()
  })

  it('should handle programmatic agent that yields STEP_ALL', async () => {
    // Test STEP_ALL behavior - should run LLM then continue with programmatic step

    let stepCount = 0
    const mockGeneratorFunction = function* () {
      stepCount++
      yield { toolName: 'read_files', input: { paths: ['file1.txt'] } }
      yield 'STEP_ALL' // Hand all remaining control to LLM
      // Should continue after LLM completes all its steps
      yield {
        toolName: 'write_file',
        input: { path: 'final.txt', content: 'done' },
      }
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    expect(stepCount).toBe(1) // Generator function called once
    expect(llmCallCount).toBe(1) // LLM should be called once
    expect(result.agentState).toBeDefined()
  })

  it('should not call LLM when programmatic agent returns without STEP', async () => {
    // Test that programmatic agents that don't yield STEP don't trigger LLM

    const mockGeneratorFunction = function* () {
      yield { toolName: 'read_files', input: { paths: ['test.txt'] } }
      yield {
        toolName: 'write_file',
        input: { path: 'result.txt', content: 'processed' },
      }
      // No STEP - agent completes without LLM involvement
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    expect(llmCallCount).toBe(0) // No LLM calls should be made
    expect(result.agentState).toBeDefined()
  })

  it('should handle LLM-only agent (no handleSteps)', async () => {
    // Test traditional LLM-based agents that don't have handleSteps

    const llmOnlyTemplate = {
      ...mockTemplate,
      handleSteps: undefined, // No programmatic step function
    }

    const localAgentTemplates = {
      'test-agent': llmOnlyTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    expect(llmCallCount).toBe(1) // LLM should be called once
    expect(result.agentState).toBeDefined()
  })

  it('should pass the full message history to the traceWriter when provided', async () => {
    const recordedSteps: Array<{ agentId: string; messages: unknown[] }> = []
    const traceWriter = {
      recordStep: (params: { agentId: string; messages: unknown[] }) => {
        recordedSteps.push(params)
      },
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      traceWriter,
      agentType: 'test-agent',
      localAgentTemplates: {
        'test-agent': { ...mockTemplate, handleSteps: undefined },
      },
    })

    expect(result.agentState).toBeDefined()
    // Called at least at the start and end of the step
    expect(recordedSteps.length).toBeGreaterThanOrEqual(2)
    expect(recordedSteps[0]!.agentId).toBe('test-agent-id')
    // End-of-step call sees the assistant response appended to the history
    const lastMessages = recordedSteps[recordedSteps.length - 1]!.messages
    expect(lastMessages.length).toBeGreaterThan(
      recordedSteps[0]!.messages.length,
    )
  })

  it('should handle programmatic agent error and still call LLM', async () => {
    // Test error handling in programmatic step - should still allow LLM to run

    const mockGeneratorFunction = function* () {
      yield { toolName: 'read_files', input: { paths: ['file1.txt'] } }
      throw new Error('Programmatic step failed')
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // After programmatic step error, should end turn and not call LLM
    expect(llmCallCount).toBe(0)
    expect(result.agentState).toBeDefined()
    expect(result.agentState.output?.error).toContain(
      'Error executing handleSteps for agent test-agent',
    )
  })

  it('should handle mixed execution with multiple STEP yields', async () => {
    // Test complex scenario with multiple STEP yields and LLM interactions
    // Note: In current implementation, LLM typically ends turn after running,
    // so this tests the first STEP interaction

    let stepCount = 0
    const mockGeneratorFunction = function* () {
      stepCount++
      yield { toolName: 'read_files', input: { paths: ['input.txt'] } }
      yield 'STEP' // First LLM interaction
      yield {
        toolName: 'write_file',
        input: { path: 'temp.txt', content: 'intermediate' },
      }
      yield {
        toolName: 'write_file',
        input: { path: 'final.txt', content: 'complete' },
      }
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    expect(stepCount).toBe(1) // Generator function called once
    expect(llmCallCount).toBe(1) // LLM called once after STEP
    expect(result.agentState).toBeDefined()
  })

  it('should pass shouldEndTurn: true as stepsComplete when end_turn tool is called', async () => {
    // Test that when LLM calls end_turn, shouldEndTurn (stepsComplete) is correctly passed
    // to the handleSteps generator via the step result.
    //
    // Flow:
    // 1. Generator yields 'STEP', runProgrammaticStep returns
    // 2. loopAgentSteps calls runAgentStep (LLM), which calls end_turn -> shouldEndTurn = true
    // 3. loopAgentSteps calls runProgrammaticStep again with stepsComplete: true
    // 4. Generator resumes from yield 'STEP' and receives { stepsComplete: true }

    let stepsCompleteValues: boolean[] = []

    const mockGeneratorFunction = function* () {
      // First STEP - after LLM runs and calls end_turn, we receive stepsComplete: true
      const result1 = yield 'STEP'
      stepsCompleteValues.push(result1.stepsComplete)

      // Since stepsComplete was true, we should end gracefully
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Verify that stepsComplete was passed correctly:
    // After yielding STEP and LLM running (which calls end_turn),
    // the generator receives stepsComplete: true
    expect(stepsCompleteValues).toHaveLength(1)
    expect(stepsCompleteValues[0]).toBe(true)
  })

  it('should continue loop when handleSteps returns endTurn: false even if LLM calls end_turn', async () => {
    // Test that handleSteps endTurn: false takes precedence over LLM end_turn tool call

    let programmaticStepCount = 0
    let llmStepCount = 0

    const mockGeneratorFunction = function* () {
      // First iteration: return endTurn: false
      programmaticStepCount++
      yield 'STEP'

      // Second iteration: also return endTurn: false
      programmaticStepCount++
      yield 'STEP'

      // Third iteration: finally return endTurn: true to end the loop
      programmaticStepCount++
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    // Mock LLM to always call end_turn, but handleSteps should override it
    let promptCallCount = 0
    loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
      promptCallCount++
      llmStepCount++

      // LLM always tries to end turn
      yield { type: 'text' as const, text: 'LLM response\n\n' }
      yield createToolCallChunk('end_turn', {})
      return promptSuccess(`mock-message-id-${promptCallCount}`)
    }

    await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Verify handleSteps ran 3 times (yielded STEP twice, then end_turn)
    expect(programmaticStepCount).toBe(3)

    // Verify LLM was called 2 times (once per STEP yield)
    expect(llmStepCount).toBe(2)

    // This confirms that even though LLM called end_turn every time,
    // the loop continued because handleSteps kept yielding STEP before finally ending
  })

  it('should restart loop when agent finishes without setting required output', async () => {
    // Test that when an agent has outputSchema but finishes without calling set_output,
    // the loop restarts with a system message

    const outputSchema = z.object({
      result: z.string(),
      status: z.string(),
    })

    const templateWithOutputSchema = {
      ...mockTemplate,
      outputSchema,
      toolNames: ['set_output', 'end_turn'], // Add set_output to available tools
      handleSteps: undefined, // LLM-only agent
    }

    const localAgentTemplates = {
      'test-agent': templateWithOutputSchema,
    }

    let llmCallNumber = 0
    const llmStepNumbers: string[] = []
    let capturedAgentState: AgentState | null = null

    loopAgentStepsBaseParams.promptAiSdkStream = async function* ({
      extraCodebuffMetadata,
    }) {
      llmCallNumber++
      llmStepNumbers.push(extraCodebuffMetadata?.llm_step_number ?? '')
      if (llmCallNumber === 1) {
        // First call: agent tries to end turn without setting output
        yield {
          type: 'text' as const,
          text: 'First response without output\n\n',
        }
        yield createToolCallChunk('end_turn', {})
      } else if (llmCallNumber === 2) {
        // Second call: agent sets output after being reminded
        // Manually set the output to simulate the set_output tool execution
        if (capturedAgentState) {
          capturedAgentState.output = {
            result: 'test result',
            status: 'success',
          }
        }
        yield { type: 'text' as const, text: 'Setting output now\n\n' }
        yield createToolCallChunk('set_output', {
          result: 'test result',
          status: 'success',
        })
        yield { type: 'text' as const, text: '\n\n' }
        yield createToolCallChunk('end_turn', {})
      } else {
        // Safety: if called more than twice, just end
        yield { type: 'text' as const, text: 'Ending\n\n' }
        yield createToolCallChunk('end_turn', {})
      }
      return promptSuccess('mock-message-id')
    }

    mockAgentState.output = undefined
    capturedAgentState = mockAgentState

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Should call LLM twice: once to try ending without output, once after reminder
    expect(llmCallNumber).toBe(2)
    expect(llmStepNumbers).toEqual(['1', '2'])

    // Should have output set after the second attempt
    expect(result.agentState.output).toEqual({
      result: 'test result',
      status: 'success',
    })

    // Check that a system message was added to message history
    const systemMessages = result.agentState.messageHistory.filter(
      (msg) =>
        msg.role === 'user' &&
        msg.content[0].type === 'text' &&
        msg.content[0].text.includes('set_output'),
    )
    expect(systemMessages.length).toBeGreaterThan(0)
  })

  it('should not restart loop if output is set correctly', async () => {
    // Test that when an agent has outputSchema and sets output correctly,
    // the loop ends normally without restarting

    const outputSchema = z.object({
      result: z.string(),
    })

    const templateWithOutputSchema = {
      ...mockTemplate,
      outputSchema,
      toolNames: ['set_output', 'end_turn'],
      handleSteps: undefined,
    }

    const localAgentTemplates = {
      'test-agent': templateWithOutputSchema,
    }

    let llmCallNumber = 0
    let capturedAgentState: AgentState | null = null

    loopAgentStepsBaseParams.promptAiSdkStream = async function* ({}) {
      llmCallNumber++
      // Agent sets output correctly on first call
      if (capturedAgentState) {
        capturedAgentState.output = { result: 'success' }
      }
      yield { type: 'text' as const, text: 'Setting output\n\n' }
      yield createToolCallChunk('set_output', { result: 'success' })
      yield { type: 'text' as const, text: '\n\n' }
      yield createToolCallChunk('end_turn', {})
      return promptSuccess('mock-message-id')
    }

    mockAgentState.output = undefined
    capturedAgentState = mockAgentState

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Should only call LLM once since output was set correctly
    expect(llmCallNumber).toBe(1)

    // Should have output set
    expect(result.agentState.output).toEqual({ result: 'success' })
  })

  it('should pass generateN from programmatic step to runAgentStep as n parameter', async () => {
    // Test that when programmatic step returns generateN, it's passed to runAgentStep

    let agentStepN: number | undefined

    const mockGeneratorFunction = function* () {
      // Yield GENERATE_N to trigger n parameter
      yield { type: 'GENERATE_N', n: 5 }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    // Mock promptAiSdk to capture the n parameter
    loopAgentStepsBaseParams.promptAiSdk = async (params: any) => {
      agentStepN = params.n
      return promptSuccess(
        JSON.stringify([
          'Response 1',
          'Response 2',
          'Response 3',
          'Response 4',
          'Response 5',
        ]),
      )
    }

    await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Verify generateN was passed to runAgentStep as n
    expect(agentStepN).toBe(5)
  })

  it('should pass nResponses from runAgentStep back to programmatic step', async () => {
    // Test that nResponses returned by runAgentStep are passed to next programmatic step

    let receivedNResponses: string[] | undefined

    const mockGeneratorFunction = function* () {
      const { nResponses } = yield { type: 'GENERATE_N', n: 3 }
      receivedNResponses = nResponses
      const step = yield {
        toolName: 'read_files',
        input: { paths: ['test.txt'] },
      }
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const expectedResponses = [
      'Implementation A',
      'Implementation B',
      'Implementation C',
    ]
    loopAgentStepsBaseParams.promptAiSdk = async () => {
      return promptSuccess(JSON.stringify(expectedResponses))
    }

    await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    expect(receivedNResponses).toEqual(expectedResponses)
  })

  it('should allow agents without outputSchema to end normally', async () => {
    // Test that agents without outputSchema can end without setting output

    const templateWithoutOutputSchema = {
      ...mockTemplate,
      outputSchema: undefined,
      handleSteps: undefined,
    }

    const localAgentTemplates = {
      'test-agent': templateWithoutOutputSchema,
    }

    let llmCallNumber = 0
    loopAgentStepsBaseParams.promptAiSdkStream = async function* ({}) {
      llmCallNumber++
      yield { type: 'text' as const, text: 'Response without output\n\n' }
      yield createToolCallChunk('end_turn', {})
      return promptSuccess('mock-message-id')
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Should only call LLM once and end normally
    expect(llmCallNumber).toBe(1)

    // Output should be undefined since no outputSchema required
    expect(result.agentState.output).toBeUndefined()
  })

  it('should continue loop if agent does not end turn (has more work)', async () => {
    // Test that validation only triggers when shouldEndTurn is true

    const outputSchema = z.object({
      result: z.string(),
    })

    const templateWithOutputSchema = {
      ...mockTemplate,
      outputSchema,
      toolNames: ['read_files', 'set_output', 'end_turn'],
      handleSteps: undefined,
    }

    const localAgentTemplates = {
      'test-agent': templateWithOutputSchema,
    }

    let llmCallNumber = 0
    let capturedAgentState: AgentState | null = null

    loopAgentStepsBaseParams.promptAiSdkStream = async function* ({}) {
      llmCallNumber++
      if (llmCallNumber === 1) {
        // First call: agent does some work but doesn't end turn
        yield { type: 'text' as const, text: 'Doing work\n\n' }
        yield createToolCallChunk('read_files', { paths: ['test.txt'] })
      } else {
        // Second call: agent sets output and ends
        if (capturedAgentState) {
          capturedAgentState.output = { result: 'done' }
        }
        yield { type: 'text' as const, text: 'Finishing\n\n' }
        yield createToolCallChunk('set_output', { result: 'done' })
        yield { type: 'text' as const, text: '\n\n' }
        yield createToolCallChunk('end_turn', {})
      }
      return promptSuccess('mock-message-id')
    }

    mockAgentState.output = undefined
    capturedAgentState = mockAgentState

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Should call LLM twice: once for work, once to set output and end
    expect(llmCallNumber).toBe(2)

    // Should have output set
    expect(result.agentState.output).toEqual({ result: 'done' })
  })

  describe('abort handling', () => {
    it('should handle AbortError and finish with cancelled status', async () => {
      // Test that when an AbortError is thrown (e.g., from a tool handler),
      // loopAgentSteps catches it, finishes with 'cancelled' status, and returns
      // an error output indicating the run was cancelled.

      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      // Track finishAgentRun calls
      let finishAgentRunStatus: string | undefined
      const mockFinishAgentRun = mock(async (params: { status: string }) => {
        finishAgentRunStatus = params.status
      })

      // Mock promptAiSdkStream to throw an AbortError (simulating user cancellation mid-stream)
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        // Yield some content first
        yield { type: 'text' as const, text: 'Starting work...\n' }
        // Then throw AbortError to simulate user cancellation
        throw new AbortError('User pressed Ctrl+C')
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
        finishAgentRun: mockFinishAgentRun,
      })

      // Verify the output indicates cancellation
      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        expect(result.output.message).toBe('Run cancelled by user')
      }

      // Verify finishAgentRun was called with 'cancelled' status
      expect(mockFinishAgentRun).toHaveBeenCalled()
      expect(finishAgentRunStatus).toBe('cancelled')
    })

    it('should distinguish AbortError from other errors', async () => {
      // Test that non-abort errors are NOT treated as cancellations

      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      // Track finishAgentRun calls
      let finishAgentRunStatus: string | undefined
      const mockFinishAgentRun = mock(async (params: { status: string }) => {
        finishAgentRunStatus = params.status
      })

      // Mock promptAiSdkStream to throw a regular error (not AbortError)
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        yield { type: 'text' as const, text: 'Starting...\n' }
        throw new Error('Network connection failed')
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
        finishAgentRun: mockFinishAgentRun,
      })

      // Verify the output indicates an error (not cancellation)
      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        expect(result.output.message).toContain('Network connection failed')
        expect(result.output.message).not.toBe('Run cancelled by user')
      }

      // Verify finishAgentRun was called with 'failed' status (not 'cancelled')
      expect(mockFinishAgentRun).toHaveBeenCalled()
      expect(finishAgentRunStatus).toBe('failed')
    })

    it('should handle signal.aborted before loop starts', async () => {
      // Test that if signal is already aborted when loopAgentSteps is called,
      // it returns immediately with a cancelled message

      const abortController = new AbortController()
      abortController.abort() // Abort immediately

      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
        signal: abortController.signal,
      })

      // Verify the output indicates cancellation
      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        expect(result.output.message).toBe('Run cancelled by user')
      }

      // LLM should not have been called since we aborted before starting
      expect(llmCallCount).toBe(0)
    })
  })

  describe('API error handling', () => {
    it('should propagate error code and server message from 403 APICallError responseBody', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      // Mock promptAiSdkStream to throw an APICallError with a 403 status
      // and a responseBody containing the server's structured error
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        throw new APICallError({
          statusCode: 403,
          message: 'Forbidden',
          url: 'https://api.codebuff.com/v1/chat/completions',
          requestBodyValues: {},
          responseBody: JSON.stringify({
            error: 'free_mode_unavailable',
            message: 'Free mode is not available in your country.',
            countryCode: 'US',
            countryBlockReason: 'anonymous_network',
            ipPrivacySignals: ['vpn', 'hosting'],
          }),
          isRetryable: false,
        })
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        // Should use the server's message, NOT the generic "Forbidden"
        expect(result.output.message).toBe(
          'Free mode is not available in your country.',
        )
        // Should NOT have the 'Agent run error: ' prefix since message came from responseBody
        expect(result.output.message).not.toContain('Agent run error:')
        // Should propagate the error code so the CLI can match on it
        expect(result.output.error).toBe('free_mode_unavailable')
        // Should propagate the status code
        expect(result.output.statusCode).toBe(403)
        expect(result.output.countryCode).toBe('US')
        expect(result.output.countryBlockReason).toBe('anonymous_network')
        expect(result.output.ipPrivacySignals).toEqual(['vpn', 'hosting'])
      }
    })

    it('should prefix with "Agent run error:" when responseBody has no parseable message', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      // APICallError with no responseBody
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        throw new APICallError({
          statusCode: 500,
          message: 'Internal Server Error',
          url: 'https://api.codebuff.com/v1/chat/completions',
          requestBodyValues: {},
          responseBody: undefined,
          isRetryable: true,
        })
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        // Should have the prefix since there's no server message
        expect(result.output.message).toContain('Agent run error:')
        expect(result.output.message).toContain('Internal Server Error')
        // No error code since responseBody wasn't parseable
        expect(result.output.error).toBeUndefined()
      }
    })

    it('should unwrap retry errors to propagate underlying 409 gate errors', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      const apiError = new APICallError({
        statusCode: 409,
        message: 'Conflict',
        url: 'https://api.codebuff.com/v1/chat/completions',
        requestBodyValues: {},
        responseBody: JSON.stringify({
          error: 'session_superseded',
          message:
            'Another instance of freebuff has taken over this session. Only one instance per account is allowed.',
        }),
        isRetryable: true,
      })

      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        throw new RetryError({
          message: 'Failed after 4 attempts. Last error: Conflict',
          reason: 'maxRetriesExceeded',
          errors: [apiError],
        })
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        expect(result.output.message).toBe(
          'Another instance of freebuff has taken over this session. Only one instance per account is allowed.',
        )
        expect(result.output.message).not.toContain('Agent run error:')
        expect(result.output.error).toBe('session_superseded')
        expect(result.output.statusCode).toBe(409)
      }
    })

    it('should explain fetch idle timeouts instead of showing the raw runtime message', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      // Bun aborts a fetch after 5 minutes without receiving bytes, throwing a
      // DOMException named TimeoutError with this exact message.
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        const timeoutError = new Error('The operation timed out.')
        timeoutError.name = 'TimeoutError'
        throw timeoutError
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        expect(result.output.message).toContain(
          'no data was received from the server for 5 minutes',
        )
        expect(result.output.message).not.toContain('Agent run error:')
        expect(result.output.message).not.toBe('The operation timed out.')
      }
    })

    it('should explain dropped socket connections instead of showing the raw runtime message', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      // Bun's fetch throws a plain Error with this message (and code
      // ECONNRESET/ConnectionClosed) when the TCP connection is dropped.
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        const socketError = new Error(
          'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
        ) as Error & { code: string }
        socketError.code = 'ECONNRESET'
        throw socketError
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        expect(result.output.message).toContain('Connection interrupted')
        expect(result.output.message).not.toContain('Agent run error:')
        expect(result.output.message).not.toContain(
          'pass `verbose: true` in the second argument to fetch()',
        )
      }
    })
  })

  describe('steering (drainSteeringMessages)', () => {
    it('appends a steering message at the step boundary and continues the turn', async () => {
      // The mock LLM ends the turn after one step. A steering message that arrives
      // during that step should be appended to history and keep the turn going, so
      // the agent runs a second step that can see (and act on) the new message.
      const steerText = 'Also rename the variable to fooBar'
      let drainCalls = 0
      const drainSteeringMessages = () => {
        drainCalls++
        return drainCalls === 1 ? [steerText] : []
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        drainSteeringMessages,
      })

      // Step 1 wanted to end the turn, but the steer kept it going → a 2nd step ran.
      expect(llmCallCount).toBe(2)

      // The steered text landed in history as a user message.
      const steered = result.agentState.messageHistory.find(
        (m) =>
          m.role === 'user' && JSON.stringify(m.content).includes(steerText),
      )
      expect(steered).toBeDefined()
      expect((steered as { tags?: string[] }).tags).toContain('USER_PROMPT')
    })

    it('does not extend the turn when no steering messages arrive', async () => {
      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        drainSteeringMessages: () => [],
      })

      // No steer → the agent ends the turn after its single step, as usual.
      expect(llmCallCount).toBe(1)
      expect(result.agentState).toBeDefined()
    })
  })

  describe('stream interruptions', () => {
    it('retries after a stream interruption and completes the turn', async () => {
      let callCount = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        callCount++
        if (callCount === 1) {
          // A stream cut mid-response: partial text, then the interruption
          // chunk promptAiSdkStream yields when no finish marker arrived.
          yield { type: 'text' as const, text: 'partial answer that got cut ' }
          yield {
            type: 'error' as const,
            source: 'stream-interrupted' as const,
            message: 'The connection dropped while the response was streaming.',
          }
          return promptSuccess('interrupted-message-id')
        }
        yield { type: 'text' as const, text: 'complete answer' }
        yield createToolCallChunk('end_turn', {})
        return promptSuccess('complete-message-id')
      }

      const result = await loopAgentSteps(loopAgentStepsBaseParams)

      // The interruption forced a second step (the retry), which completed.
      expect(callCount).toBe(2)
      expect(result.output?.type).not.toBe('error')

      const notes = result.agentState.messageHistory.filter(
        (m) => m.role === 'user' && m.tags?.includes(STREAM_INTERRUPTED_TAG),
      )
      expect(notes).toHaveLength(1)
    })

    it('gives up with a clear error when every attempt is interrupted', async () => {
      let callCount = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        callCount++
        yield {
          type: 'error' as const,
          source: 'stream-interrupted' as const,
          message: 'The connection dropped while the response was streaming.',
        }
        return promptSuccess(`interrupted-${callCount}`)
      }

      const result = await loopAgentSteps(loopAgentStepsBaseParams)

      expect(result.output?.type).toBe('error')
      expect((result.output as { message?: string }).message).toContain(
        REPEATED_STREAM_INTERRUPTIONS_MESSAGE,
      )
      // The retried interruptions, plus the final attempt that trips the cap
      // instead of retrying forever (well under maxAgentSteps).
      expect(callCount).toBe(MAX_CONSECUTIVE_STREAM_RECOVERIES + 1)
    })

    it('retries after an output-limit thinking overrun and completes the turn', async () => {
      let callCount = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        callCount++
        if (callCount === 1) {
          // The model burned its output budget on reasoning: only reasoning
          // chunks, then the output-limit chunk promptAiSdkStream yields for
          // a 'length' finish with no content or tool calls.
          yield { type: 'reasoning' as const, text: 'thinking forever ' }
          yield {
            type: 'error' as const,
            source: 'output-limit' as const,
            message: 'The response hit its output token limit while reasoning.',
          }
          return promptSuccess('limited-message-id')
        }
        yield { type: 'text' as const, text: 'concise answer' }
        yield createToolCallChunk('end_turn', {})
        return promptSuccess('complete-message-id')
      }

      const result = await loopAgentSteps(loopAgentStepsBaseParams)

      expect(callCount).toBe(2)
      expect(result.output?.type).not.toBe('error')

      const notes = result.agentState.messageHistory.filter(
        (m) => m.role === 'user' && m.tags?.includes(OUTPUT_LIMIT_TAG),
      )
      expect(notes).toHaveLength(1)
    })

    it('gives up with the output-limit message when every attempt overruns', async () => {
      let callCount = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        callCount++
        yield {
          type: 'error' as const,
          source: 'output-limit' as const,
          message: 'The response hit its output token limit while reasoning.',
        }
        return promptSuccess(`limited-${callCount}`)
      }

      const result = await loopAgentSteps(loopAgentStepsBaseParams)

      expect(result.output?.type).toBe('error')
      expect((result.output as { message?: string }).message).toContain(
        REPEATED_OUTPUT_LIMIT_MESSAGE,
      )
      expect(callCount).toBe(MAX_CONSECUTIVE_STREAM_RECOVERIES + 1)
    })
  })

  describe('the end-of-turn context recount', () => {
    // The cancel exit is where the recount earns its keep, and it is also the
    // only exit where the two behaviours are far apart enough to assert
    // cleanly. A turn that ends normally re-enters the loop once and re-runs
    // the in-loop estimate before breaking, so that estimate already covers the
    // answer; a turn that is cancelled leaves the loop from inside the step,
    // and the last estimate it took predates everything the model produced.
    const BIG_PARTIAL_ANSWER = 'here is what I found so far. '.repeat(2000)

    const contextTokensAfterCancelledTurn = async (agentState: AgentState) => {
      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentState,
        promptAiSdkStream: async function* () {
          yield { type: 'text' as const, text: BIG_PARTIAL_ANSWER }
          throw new AbortError('User pressed Ctrl+C')
        },
      })
      return result.agentState.contextTokenCount
    }

    const withHistory = (extra?: Partial<AgentState>): AgentState => ({
      ...mockAgentState,
      messageHistory: [...mockAgentState.messageHistory],
      contextTokenCount: 0,
      ...extra,
    })

    it('leaves the root counting the history the turn actually kept', async () => {
      // The host persists this number and shows it to the user between turns,
      // so it has to describe the history the NEXT message is sent on top of —
      // including the partial answer a cancelled turn preserves.
      const asRoot = await contextTokensAfterCancelledTurn(withHistory())
      expect(asRoot).toBeGreaterThan(10_000)
    })

    it('does not pay to recount a subagent nobody reads', async () => {
      // Only the root's count leaves the runtime — the host reads
      // sessionState.mainAgentState. Recounting here tokenizes a spawned
      // agent's whole history (file-picker, thinker, context-pruner, …) for a
      // value that is discarded with the agent, which on a one-step subagent
      // roughly doubles its tokenizer cost.
      //
      // Same predicate as the compaction callback: parentId.
      const asRoot = await contextTokensAfterCancelledTurn(withHistory())
      const asSubagent = await contextTokensAfterCancelledTurn(
        withHistory({ parentId: 'parent-agent-id' }),
      )

      // Not merely different: the subagent's number is the estimate taken
      // before the model call, which predates everything the model produced.
      expect(asRoot).toBeGreaterThan(asSubagent * 2)
    })
  })
})
