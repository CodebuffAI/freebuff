import * as bigquery from '@codebuff/bigquery'
import * as analytics from '@codebuff/common/analytics'
import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getToolCallString } from '@codebuff/common/tools/utils'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { assistantMessage, userMessage } from '@codebuff/common/util/messages'
import db from '@codebuff/internal/db'
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

import { disableLiveUserInputCheck } from '../live-user-inputs'
import { runAgentStep } from '../run-agent-step'
import { clearAgentGeneratorCache } from '../run-programmatic-step'
import { asUserMessage } from '../util/messages'

import type { AgentTemplate } from '../templates/types'
import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
} from '@codebuff/common/types/contracts/agent-runtime'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type { ProjectFileContext } from '@codebuff/common/util/file'

describe('runAgentStep - set_output tool', () => {
  let testAgent: AgentTemplate
  let agentRuntimeImpl: AgentRuntimeDeps & AgentRuntimeScopedDeps
  let runAgentStepBaseParams: ParamsExcluding<
    typeof runAgentStep,
    'agentType' | 'prompt' | 'localAgentTemplates' | 'agentState'
  >

  beforeAll(() => {
    disableLiveUserInputCheck()
  })

  beforeEach(async () => {
    agentRuntimeImpl = { ...TEST_AGENT_RUNTIME_IMPL, sendAction: () => {} }

    // Create a test agent that supports set_output
    testAgent = {
      id: 'test-set-output-agent',
      displayName: 'Test Set Output Agent',
      spawnerPrompt: 'Testing set_output functionality',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'structured_output' as const,
      includeMessageHistory: true,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['set_output', 'end_turn'],
      spawnableAgents: [],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test instructions prompt',
      stepPrompt: 'Test agent step prompt',
    }

    // Setup spies for database operations
    spyOn(db, 'insert').mockReturnValue({
      values: mock(() => Promise.resolve({ id: 'test-run-id' })),
    } as any)

    spyOn(db, 'update').mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    } as any)

    // Mock analytics and tracing
    spyOn(analytics, 'initAnalytics').mockImplementation(() => {})
    analytics.initAnalytics(agentRuntimeImpl)
    spyOn(analytics, 'trackEvent').mockImplementation(() => {})
    spyOn(bigquery, 'insertTrace').mockImplementation(() =>
      Promise.resolve(true),
    )

    agentRuntimeImpl.requestFiles = async ({ filePaths }) => {
      const results: Record<string, string | null> = {}
      filePaths.forEach((p) => {
        if (p === 'src/auth.ts') {
          results[p] = 'export function authenticate() { return true; }'
        } else if (p === 'src/user.ts') {
          results[p] = 'export interface User { id: string; name: string; }'
        } else {
          results[p] = null
        }
      })
      return results
    }
    agentRuntimeImpl.requestOptionalFile = async ({ filePath }) => {
      if (filePath === 'src/auth.ts') {
        return 'export function authenticate() { return true; }'
      } else if (filePath === 'src/user.ts') {
        return 'export interface User { id: string; name: string; }'
      }
      return null
    }

    // Don't mock requestToolCall for integration test - let real tool execution happen

    // Mock LLM APIs
    agentRuntimeImpl.promptAiSdk = async function () {
      return 'Test response'
    }
    clearAgentGeneratorCache(agentRuntimeImpl)

    runAgentStepBaseParams = {
      ...agentRuntimeImpl,

      additionalToolDefinitions: () => Promise.resolve({}),
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
  })

  afterEach(() => {
    mock.restore()
  })

  afterAll(() => {
    clearAgentGeneratorCache(agentRuntimeImpl)
  })

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
    systemInfo: {
      platform: 'test',
      shell: 'test',
      nodeVersion: 'test',
      arch: 'test',
      homedir: '/home/test',
      cpus: 1,
    },
    agentTemplates: {},
    customToolDefinitions: {},
  }

  it('should set output with simple key-value pair', async () => {
    const mockResponse =
      getToolCallString('set_output', {
        message: 'Hi',
      }) +
      '\n\n' +
      getToolCallString('end_turn', {})

    runAgentStepBaseParams.promptAiSdkStream = async function* ({}) {
      yield { type: 'text' as const, text: mockResponse }
      return 'mock-message-id'
    }

    const sessionState = getInitialSessionState(mockFileContext)
    const agentState = sessionState.mainAgentState
    const localAgentTemplates = {
      'test-set-output-agent': testAgent,
    }

    const result = await runAgentStep({
      ...runAgentStepBaseParams,
      agentType: 'test-set-output-agent',
      localAgentTemplates,
      agentState,
      prompt: 'Analyze the codebase',
    })

    expect(result.agentState.output).toEqual({
      message: 'Hi',
    })
    expect(result.shouldEndTurn).toBe(true)
  })

  it('should set output with complex data', async () => {
    const mockResponse =
      getToolCallString('set_output', {
        message: 'Analysis complete',
        status: 'success',
        findings: ['Bug in auth.ts', 'Missing validation'],
      }) + getToolCallString('end_turn', {})

    runAgentStepBaseParams.promptAiSdkStream = async function* ({}) {
      yield { type: 'text' as const, text: mockResponse }
      return 'mock-message-id'
    }

    const sessionState = getInitialSessionState(mockFileContext)
    const agentState = sessionState.mainAgentState
    const localAgentTemplates = {
      'test-set-output-agent': testAgent,
    }

    const result = await runAgentStep({
      ...runAgentStepBaseParams,
      agentType: 'test-set-output-agent',
      localAgentTemplates,
      agentState,
      prompt: 'Analyze the codebase',
    })

    expect(result.agentState.output).toEqual({
      message: 'Analysis complete',
      status: 'success',
      findings: ['Bug in auth.ts', 'Missing validation'],
    })
    expect(result.shouldEndTurn).toBe(true)
  })

  it('should replace existing output data', async () => {
    const mockResponse =
      getToolCallString('set_output', {
        newField: 'new value',
        existingField: 'updated value',
      }) + getToolCallString('end_turn', {})

    runAgentStepBaseParams.promptAiSdkStream = async function* ({}) {
      yield { type: 'text' as const, text: mockResponse }
      return 'mock-message-id'
    }

    const sessionState = getInitialSessionState(mockFileContext)
    const agentState = sessionState.mainAgentState
    // Pre-populate the output with existing data
    agentState.output = {
      existingField: 'original value',
      anotherField: 'unchanged',
    }
    const localAgentTemplates = {
      'test-set-output-agent': testAgent,
    }

    const result = await runAgentStep({
      ...runAgentStepBaseParams,
      localAgentTemplates,
      agentState,
      prompt: 'Update the output',
      agentType: 'test-set-output-agent',
    })

    expect(result.agentState.output).toEqual({
      newField: 'new value',
      existingField: 'updated value',
    })
  })

  it('should handle empty output parameter', async () => {
    const mockResponse =
      getToolCallString('set_output', {}) + getToolCallString('end_turn', {})

    runAgentStepBaseParams.promptAiSdkStream = async function* ({}) {
      yield { type: 'text' as const, text: mockResponse }
      return 'mock-message-id'
    }

    const sessionState = getInitialSessionState(mockFileContext)
    const agentState = sessionState.mainAgentState
    agentState.output = { existingField: 'value' }
    const localAgentTemplates = {
      'test-set-output-agent': testAgent,
    }

    const result = await runAgentStep({
      ...runAgentStepBaseParams,
      localAgentTemplates,
      agentState,
      agentType: 'test-set-output-agent',
      prompt: 'Update with empty object',
    })

    // Should replace with empty object
    expect(result.agentState.output).toEqual({})
  })

  it('should handle handleSteps with one tool call and STEP_ALL', async () => {
    // Create a mock agent template with handleSteps
    const mockAgentTemplate: AgentTemplate = {
      id: 'test-handlesteps-agent',
      displayName: 'Test HandleSteps Agent',
      spawnerPrompt: 'Testing handleSteps functionality',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'structured_output' as const,
      includeMessageHistory: true,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['read_files', 'end_turn'],
      spawnableAgents: [],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test instructions prompt',
      stepPrompt: 'Test agent step prompt',
      handleSteps: function* ({ agentState, prompt, params }) {
        // Yield one tool call
        yield {
          toolName: 'read_files',
          input: { paths: ['src/test.ts'] },
        }
        // Then yield STEP_ALL to continue processing
        yield 'STEP_ALL'
      },
    }

    // Mock the agent registry to include our test agent
    const mockAgentRegistry = {
      'test-handlesteps-agent': mockAgentTemplate,
    }

    // Mock requestFiles to return test file content
    runAgentStepBaseParams.requestFiles = async ({ filePaths }) => {
      const results: Record<string, string | null> = {}
      filePaths.forEach((p) => {
        if (p === 'src/test.ts') {
          results[p] = 'export function testFunction() { return "test"; }'
        } else {
          results[p] = null
        }
      })
      return results
    }

    // Mock the LLM stream to return a response that doesn't end the turn
    runAgentStepBaseParams.promptAiSdkStream = async function* ({}) {
      yield { type: 'text' as const, text: 'Continuing with the analysis...' } // Non-empty response, no tool calls
      return 'mock-message-id'
    }

    const sessionState = getInitialSessionState(mockFileContext)
    const agentState = sessionState.mainAgentState

    // Add the user prompt and instructions that would normally be added by loopAgentSteps
    agentState.messageHistory = [
      ...agentState.messageHistory,
      userMessage({
        content: asUserMessage('Test the handleSteps functionality'),
        keepDuringTruncation: true,
      }),
      userMessage({
        content: 'Test instructions prompt',
        timeToLive: 'userPrompt' as const,
        keepDuringTruncation: true,
      }),
    ]

    const initialMessageCount = agentState.messageHistory.length

    const result = await runAgentStep({
      ...runAgentStepBaseParams,
      agentType: 'test-handlesteps-agent',
      localAgentTemplates: mockAgentRegistry,
      agentState,
      prompt: 'Test the handleSteps functionality',
    })

    // Should end turn because toolCalls.length === 0 && toolResults.length === 0 from LLM processing
    // (The programmatic step tool results don't count toward this calculation)
    expect(result.shouldEndTurn).toBe(true)

    const finalMessages = result.agentState.messageHistory

    // Verify the exact sequence of messages in the final message history
    const newMessages = finalMessages.slice(initialMessageCount)

    // Check that we have the user prompt in the full message history
    expect(
      finalMessages.some(
        (m) =>
          m.role === 'user' &&
          m.content[0].type === 'text' &&
          m.content[0].text.includes('Test the handleSteps functionality'),
      ),
    ).toBe(true)

    // The test should verify that the LLM response is correctly processed
    expect(
      newMessages.some(
        (m) =>
          m.role === 'assistant' &&
          m.content[0].type === 'text' &&
          m.content[0].text === 'Continuing with the analysis...',
      ),
    ).toBe(true)
  })

  it('should spawn agent inline that deletes last two assistant messages', async () => {
    // Create a mock inline agent template that deletes messages
    const mockInlineAgentTemplate: AgentTemplate = {
      id: 'message-deleter-agent',
      displayName: 'Message Deleter Agent',
      spawnerPrompt: 'Deletes assistant messages',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'structured_output' as const,
      includeMessageHistory: true,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['set_messages', 'end_turn'],
      spawnableAgents: [],
      systemPrompt: 'Delete messages system prompt',
      instructionsPrompt: 'Delete messages instructions prompt',
      stepPrompt: 'Delete messages step prompt',
      handleSteps: function* ({ agentState, prompt, params }) {
        // Delete the last two assistant messages by doing two iterations
        const messages = [...agentState.messageHistory]

        // First iteration: find and remove the last assistant message, which is the tool call to this agent
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'assistant') {
            messages.splice(i, 1)
            break
          }
        }

        // Second iteration: find and remove the next-to-last assistant message
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'assistant') {
            messages.splice(i, 1)
            break
          }
        }

        // Third iteration: find and remove the third assistant message
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'assistant') {
            messages.splice(i, 1)
            break
          }
        }

        // Set the updated messages
        yield {
          toolName: 'set_messages',
          input: { messages },
        }
      },
    }

    // Create a parent agent template that can spawn the inline agent
    const mockParentAgentTemplate: AgentTemplate = {
      id: 'parent-agent',
      displayName: 'Parent Agent',
      spawnerPrompt: 'Parent agent that spawns inline agents',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'structured_output' as const,
      includeMessageHistory: true,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['spawn_agent_inline', 'end_turn'],
      spawnableAgents: ['message-deleter-agent'],
      systemPrompt: 'Parent system prompt',
      instructionsPrompt: 'Parent instructions prompt',
      stepPrompt: 'Parent step prompt',
    }

    // Mock the agent registry to include both agents
    const mockAgentRegistry = {
      'parent-agent': mockParentAgentTemplate,
      'message-deleter-agent': mockInlineAgentTemplate,
    }

    // Mock the LLM stream to spawn the inline agent
    runAgentStepBaseParams.promptAiSdkStream = async function* ({}) {
      yield {
        type: 'text' as const,
        text: getToolCallString('spawn_agent_inline', {
          agent_type: 'message-deleter-agent',
          prompt: 'Delete the last two assistant messages',
        }),
      }
      return 'mock-message-id'
    }

    const sessionState = getInitialSessionState(mockFileContext)
    const agentState = sessionState.mainAgentState

    // Add some initial messages including assistant messages to delete
    agentState.messageHistory = [
      userMessage('Hello'),
      assistantMessage('Hi there!'),
      userMessage('How are you?'),
      assistantMessage('I am doing well, thank you!'),
      userMessage('Can you help me?'),
      assistantMessage('Of course, I would be happy to help!'),
      // Add the user prompt and instructions that would normally be added by loopAgentSteps
      userMessage({
        content: 'Spawn an inline agent to clean up messages',
        keepDuringTruncation: true,
      }),
      userMessage({
        content: 'Parent instructions prompt',
        timeToLive: 'userPrompt' as const,
        keepDuringTruncation: true,
      }),
    ]

    const result = await runAgentStep({
      ...runAgentStepBaseParams,
      agentType: 'parent-agent',
      localAgentTemplates: mockAgentRegistry,
      agentState,
      prompt: 'Spawn an inline agent to clean up messages',
    })

    const finalMessages = result.agentState.messageHistory

    // This integration test demonstrates that spawn_agent_inline tool calls are executed successfully!
    // The inline agent runs its handleSteps function and executes tool calls

    // Verify that the inline agent executed and messages were properly deleted
    // After refactoring, the execution flow may be different but the end result should be the same

    // Check that some assistant messages were deleted (we started with 3, should have fewer now)
    const assistantMessagesCount = finalMessages.filter(
      (m) => m.role === 'assistant',
    ).length
    expect(assistantMessagesCount).toBeLessThan(3) // We should have deleted some assistant messages

    // Check that we have the user prompt that triggered the inline agent
    expect(
      finalMessages.some(
        (m) =>
          m.role === 'user' &&
          m.content[0].type === 'text' &&
          m.content[0].text.includes(
            'Spawn an inline agent to clean up messages',
          ),
      ),
    ).toBe(true)

    // The final messages should still contain the core conversation structure
    expect(
      finalMessages.some(
        (m) =>
          m.role === 'user' &&
          m.content[0].type === 'text' &&
          m.content[0].text === 'Hello',
      ),
    ).toBe(true)
    expect(
      finalMessages.some(
        (m) =>
          m.role === 'user' &&
          m.content[0].type === 'text' &&
          m.content[0].text === 'How are you?',
      ),
    ).toBe(true)
    expect(
      finalMessages.some(
        (m) =>
          m.role === 'user' &&
          m.content[0].type === 'text' &&
          m.content[0].text === 'Can you help me?',
      ),
    ).toBe(true)
  })
})
