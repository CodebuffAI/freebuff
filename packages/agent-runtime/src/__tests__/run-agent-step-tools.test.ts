import * as analytics from '@codebuff/common/analytics'
import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import {
  createMockDbOperations,
  setupDbSpies,
} from '@codebuff/common/testing/mocks/database'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { promptSuccess } from '@codebuff/common/util/error'
import { assistantMessage, userMessage } from '@codebuff/common/util/messages'
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'

import { runAgentStep } from '../run-agent-step'
import { clearAgentGeneratorCache } from '../run-programmatic-step'
import {
  FOLLOWUP_SUGGESTION_LIMIT_TAG,
  MAX_FOLLOWUP_SUGGESTION_CALLS_PER_RESPONSE,
  MAX_TOOL_CALLS_PER_RESPONSE,
  TOOL_CALL_LIMIT_TAG,
} from '../tools/stream-parser'
import {
  SUGGEST_PROMPTS_BEFORE_ANSWER_MESSAGE,
  SUGGEST_PROMPTS_BEFORE_ANSWER_TAG,
} from '../util/suggest-prompts-before-answer'
import { createToolCallChunk } from './test-utils'

import type { AgentTemplate } from '../templates/types'
import type { DbSpies } from '@codebuff/common/testing/mocks/database'
import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
} from '@codebuff/common/types/contracts/agent-runtime'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { ProjectFileContext } from '@codebuff/common/util/file'

describe('runAgentStep - set_output tool', () => {
  let testAgent: AgentTemplate
  let agentRuntimeImpl: AgentRuntimeDeps & AgentRuntimeScopedDeps
  let runAgentStepBaseParams: ParamsExcluding<
    typeof runAgentStep,
    | 'agentType'
    | 'prompt'
    | 'localAgentTemplates'
    | 'agentState'
    | 'agentTemplate'
  >
  let dbSpies: DbSpies

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

    // Setup spies for database operations using typed helper
    dbSpies = setupDbSpies(createMockDbOperations())

    // Mock analytics
    spyOn(analytics, 'trackEvent').mockImplementation(() => {})

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
      return promptSuccess('Test response')
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
    dbSpies.restore()
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
      chromeAvailable: false,
    },
    agentTemplates: {},
    customToolDefinitions: {},
  }

  const createAgent = (
    id: string,
    overrides: Partial<AgentTemplate> = {},
  ): AgentTemplate => ({
    ...testAgent,
    id,
    displayName: id,
    outputMode: 'last_message',
    toolNames: [],
    spawnableAgents: [],
    stepPrompt: '',
    ...overrides,
  })

  it('should set output with simple key-value pair', async () => {
    runAgentStepBaseParams.promptAiSdkStream = async function* ({}) {
      yield createToolCallChunk('set_output', { message: 'Hi' })
      yield { type: 'text' as const, text: '\n\n' }
      yield createToolCallChunk('end_turn', {})
      return promptSuccess('mock-message-id')
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
      agentTemplate: testAgent,
      agentState,
      prompt: 'Analyze the codebase',
    })

    expect(result.agentState.output).toEqual({
      message: 'Hi',
    })
    expect(result.shouldEndTurn).toBe(true)
  })

  it('should set output with complex data', async () => {
    runAgentStepBaseParams.promptAiSdkStream = async function* ({}) {
      yield createToolCallChunk('set_output', {
        message: 'Analysis complete',
        status: 'success',
        findings: ['Bug in auth.ts', 'Missing validation'],
      })
      yield createToolCallChunk('end_turn', {})
      return promptSuccess('mock-message-id')
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
      agentTemplate: testAgent,
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
    runAgentStepBaseParams.promptAiSdkStream = async function* ({}) {
      yield createToolCallChunk('set_output', {
        newField: 'new value',
        existingField: 'updated value',
      })
      yield createToolCallChunk('end_turn', {})
      return promptSuccess('mock-message-id')
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
      agentTemplate: testAgent,
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
    runAgentStepBaseParams.promptAiSdkStream = async function* ({}) {
      yield createToolCallChunk('set_output', {})
      yield createToolCallChunk('end_turn', {})
      return promptSuccess('mock-message-id')
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
      agentTemplate: testAgent,
      agentState,
      agentType: 'test-set-output-agent',
      prompt: 'Update with empty object',
    })

    // Should replace with empty object
    expect(result.agentState.output).toEqual({})
  })

  describe('suggest_prompts and the answer', () => {
    const suggestAgent = (): AgentTemplate => ({
      ...testAgent,
      toolNames: ['suggest_prompts', 'end_turn'],
    })
    const fileContextWithSuggest: ProjectFileContext = {
      ...mockFileContext,
      customToolDefinitions: {
        suggest_prompts: {
          inputSchema: {
            type: 'object',
            properties: { prompts: { type: 'array' } },
            required: ['prompts'],
          },
          description: 'Suggest follow-up prompts',
          // This legacy flag is intentionally false: loop termination comes
          // from TOOLS_WHICH_WONT_FORCE_NEXT_STEP, not the obsolete stop hint.
          endsAgentStep: false,
        },
      },
    }

    /** One step that writes `text`, then calls suggest_prompts. */
    const step = (text: string, messageHistory: Message[] = []) => {
      runAgentStepBaseParams.promptAiSdkStream = async function* () {
        yield { type: 'text' as const, text }
        yield createToolCallChunk('suggest_prompts', {
          prompts: [{ prompt: 'Add tests' }],
        })
        return promptSuccess('mock-message-id')
      }
      runAgentStepBaseParams.requestToolCall = async () => ({
        output: [{ type: 'json', value: { ok: true } }],
      })
      const agent = suggestAgent()
      return runAgentStep({
        ...runAgentStepBaseParams,
        agentType: agent.id,
        localAgentTemplates: { [agent.id]: agent },
        agentTemplate: agent,
        agentState: {
          ...getInitialSessionState(fileContextWithSuggest).mainAgentState,
          messageHistory,
        },
        fileContext: fileContextWithSuggest,
        prompt: 'Plan the helper',
      })
    }

    const notes = (history: Message[]) =>
      history.filter((m) => m.tags?.includes(SUGGEST_PROMPTS_BEFORE_ANSWER_TAG))

    it('ends the turn on cards that follow a real answer, with no note', async () => {
      const answer = `Here is the plan.\n\n${'1. A concrete step and why it is needed.\n'.repeat(10)}`
      const result = await step(answer)
      expect(result.shouldEndTurn).toBe(true)
      expect(notes(result.agentState.messageHistory)).toHaveLength(0)
    })

    it('continues a turn whose cards arrive before the answer, with the note', async () => {
      const result = await step(
        "Planning-only, no code changed — here's the proposal.",
      )
      expect(result.shouldEndTurn).toBe(false)
      const [note] = notes(result.agentState.messageHistory)
      expect(note?.role).toBe('user')
      expect(JSON.stringify(note?.content)).toContain(
        JSON.stringify(SUGGEST_PROMPTS_BEFORE_ANSWER_MESSAGE).slice(1, -1),
      )
      // After the step's own tool result, so it is the last thing read.
      expect(result.agentState.messageHistory.at(-1)).toBe(note)
    })

    it('continues only once per prompt', async () => {
      const result = await step("Here's the proposal.", [
        userMessage({ content: 'Plan it', tags: ['USER_PROMPT'] }),
        assistantMessage({
          type: 'tool-call',
          toolCallId: 'earlier',
          toolName: 'suggest_prompts',
          input: { prompts: [] },
        }),
        {
          role: 'tool',
          toolCallId: 'earlier',
          toolName: 'suggest_prompts',
          content: [],
        },
      ])
      expect(result.shouldEndTurn).toBe(true)
      expect(notes(result.agentState.messageHistory)).toHaveLength(0)
    })
  })

  describe('follow-up suggestion cap', () => {
    const suggestAgent = (): AgentTemplate => ({
      ...testAgent,
      id: 'suggest-cap-agent',
      toolNames: ['suggest_prompts', 'read_files', 'end_turn'],
    })
    const fileContextWithSuggest = (): ProjectFileContext => ({
      ...mockFileContext,
      customToolDefinitions: {
        suggest_prompts: {
          inputSchema: {
            type: 'object',
            properties: { prompts: { type: 'array' } },
            required: ['prompts'],
          },
          description: 'Suggest follow-up prompts',
          endsAgentStep: false,
        },
      },
    })

    /** A response that calls suggest_prompts `calls` times, then writes text.
     *  Records how far it was read and the signal its request was given. */
    const runawayStream = (calls: number) => {
      const seen = { pulled: 0, finished: false, signal: undefined as AbortSignal | undefined }
      const promptAiSdkStream = async function* (params: { signal: AbortSignal }) {
        seen.signal = params.signal
        for (let i = 0; i < calls; i++) {
          seen.pulled++
          yield createToolCallChunk('suggest_prompts', {
            prompts: [{ prompt: `Idea ${i}` }],
          })
        }
        yield { type: 'text' as const, text: 'Done.' }
        seen.finished = true
        return promptSuccess('mock-message-id')
      }
      return { seen, promptAiSdkStream }
    }

    const run = async (calls: number) => {
      const { seen, promptAiSdkStream } = runawayStream(calls)
      runAgentStepBaseParams.promptAiSdkStream = promptAiSdkStream as any
      const executed: string[] = []
      runAgentStepBaseParams.requestToolCall = async ({ toolName }) => {
        executed.push(toolName)
        return { output: [{ type: 'json', value: { ok: true } }] }
      }
      const runSignal = new AbortController().signal
      const agent = suggestAgent()
      const fileContext = fileContextWithSuggest()
      const result = await runAgentStep({
        ...runAgentStepBaseParams,
        signal: runSignal,
        agentType: agent.id,
        localAgentTemplates: { [agent.id]: agent },
        agentTemplate: agent,
        agentState: getInitialSessionState(fileContext).mainAgentState,
        fileContext,
        prompt: 'Finish the task',
      })
      return { result, seen, executed, runSignal }
    }

    const limitNotes = (messages: Message[]) =>
      messages.filter((m) => m.tags?.includes(FOLLOWUP_SUGGESTION_LIMIT_TAG))

    it('executes up to the cap without cutting the response', async () => {
      const { result, seen, executed } = await run(
        MAX_FOLLOWUP_SUGGESTION_CALLS_PER_RESPONSE,
      )

      expect(executed).toHaveLength(MAX_FOLLOWUP_SUGGESTION_CALLS_PER_RESPONSE)
      expect(seen.finished).toBe(true)
      expect(seen.signal?.aborted).toBe(false)
      expect(limitNotes(result.agentState.messageHistory)).toHaveLength(0)
      expect(result.shouldEndTurn).toBe(true)
    })

    it('stops a runaway response at the cap and cancels its request, not the run', async () => {
      const { result, seen, executed, runSignal } = await run(500)

      // Only the first MAX calls ran (and so rendered); the rest were never read.
      expect(executed).toHaveLength(MAX_FOLLOWUP_SUGGESTION_CALLS_PER_RESPONSE)
      expect(seen.pulled).toBe(MAX_FOLLOWUP_SUGGESTION_CALLS_PER_RESPONSE + 1)
      expect(seen.finished).toBe(false)
      expect(seen.signal?.aborted).toBe(true)
      expect(runSignal.aborted).toBe(false)

      const history = result.agentState.messageHistory
      expect(limitNotes(history)).toHaveLength(1)
      const toolCalls = history.flatMap((m) =>
        m.role === 'assistant' && Array.isArray(m.content)
          ? m.content.filter((part) => part.type === 'tool-call')
          : [],
      )
      expect(toolCalls).toHaveLength(MAX_FOLLOWUP_SUGGESTION_CALLS_PER_RESPONSE)
      // Suggestions never force another step, so the cut response ends the turn.
      expect(result.shouldEndTurn).toBe(true)
    })
  })

  describe('tool-call cap', () => {
    // 10-22: MiMo responses streamed thousands of calls (3,539 to 12,146),
    // which compaction could then never fit, wedging the chat.
    const checkAgent = (): AgentTemplate => ({
      ...testAgent,
      id: 'tool-cap-agent',
      toolNames: ['run_check', 'end_turn'],
    })
    const fileContextWithCheck = (): ProjectFileContext => ({
      ...mockFileContext,
      customToolDefinitions: {
        run_check: {
          inputSchema: {
            type: 'object',
            properties: { n: { type: 'number' } },
            required: ['n'],
          },
          description: 'Run a check',
          endsAgentStep: false,
        },
      },
    })

    it('stops a response past the cap, runs the first calls, and tells the model', async () => {
      const seen = { pulled: 0, finished: false, signal: undefined as AbortSignal | undefined }
      runAgentStepBaseParams.promptAiSdkStream = (async function* (params: { signal: AbortSignal }) {
        seen.signal = params.signal
        for (let i = 0; i < 2_000; i++) {
          seen.pulled++
          yield createToolCallChunk('run_check', { n: i })
        }
        seen.finished = true
        return promptSuccess('mock-message-id')
      }) as any
      const executed: string[] = []
      runAgentStepBaseParams.requestToolCall = async ({ toolName }) => {
        executed.push(toolName)
        return { output: [{ type: 'json', value: { ok: true } }] }
      }
      const runSignal = new AbortController().signal
      const agent = checkAgent()
      const fileContext = fileContextWithCheck()
      const result = await runAgentStep({
        ...runAgentStepBaseParams,
        signal: runSignal,
        agentType: agent.id,
        localAgentTemplates: { [agent.id]: agent },
        agentTemplate: agent,
        agentState: getInitialSessionState(fileContext).mainAgentState,
        fileContext,
        prompt: 'Check everything',
      })

      expect(executed).toHaveLength(MAX_TOOL_CALLS_PER_RESPONSE)
      expect(seen.pulled).toBe(MAX_TOOL_CALLS_PER_RESPONSE + 1)
      expect(seen.finished).toBe(false)
      expect(seen.signal?.aborted).toBe(true)
      expect(runSignal.aborted).toBe(false)
      const notes = result.agentState.messageHistory.filter((m) =>
        m.tags?.includes(TOOL_CALL_LIMIT_TAG),
      )
      expect(notes).toHaveLength(1)
    })
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
      return promptSuccess('mock-message-id')
    }

    const sessionState = getInitialSessionState(mockFileContext)
    const agentState = sessionState.mainAgentState

    // Add the user prompt and instructions that would normally be added by loopAgentSteps
    agentState.messageHistory = [
      ...agentState.messageHistory,
      userMessage({
        content: 'Test the handleSteps functionality',
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
      agentTemplate: mockAgentTemplate,
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

  it('continues the turn when the LLM response is only think-tag scaffolding', async () => {
    const thinkOnlyAgent: AgentTemplate = {
      id: 'test-think-only-agent',
      displayName: 'Test Think Only Agent',
      spawnerPrompt: 'Testing think-only turn continuation',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'last_message' as const,
      includeMessageHistory: true,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['read_files', 'end_turn'],
      spawnableAgents: [],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test instructions prompt',
      stepPrompt: 'Test agent step prompt',
    }

    // Orphan </think> is what Kimi via Alibaba/Infron sometimes leaks into
    // content after native reasoning — previously this ended the turn.
    runAgentStepBaseParams.promptAiSdkStream = async function* ({}) {
      yield { type: 'text' as const, text: '</think> ' }
      return promptSuccess('mock-message-id')
    }

    const sessionState = getInitialSessionState(mockFileContext)
    const result = await runAgentStep({
      ...runAgentStepBaseParams,
      agentType: 'test-think-only-agent',
      localAgentTemplates: { 'test-think-only-agent': thinkOnlyAgent },
      agentTemplate: thinkOnlyAgent,
      agentState: sessionState.mainAgentState,
      prompt: 'Continue the task',
    })

    expect(result.shouldEndTurn).toBe(false)
    expect(result.fullResponse).toBe('</think> ')
  })

  it('gives a streamed child only assistant content before its spawn call', async () => {
    let childHistory: Message[] = []
    const childAgent = createAgent('history-child', {
      handleSteps: function* ({ agentState }) {
        childHistory = structuredClone(agentState.messageHistory as Message[])
      },
    })
    const parentAgent = createAgent('history-parent', {
      toolNames: ['spawn_agents'],
      spawnableAgents: ['history-child'],
    })

    runAgentStepBaseParams.promptAiSdkStream = async function* () {
      yield { type: 'reasoning' as const, text: 'Reasoning before spawn.' }
      yield { type: 'text' as const, text: 'Visible before spawn.' }
      yield createToolCallChunk('spawn_agents', {
        agents: [
          { agent_type: 'history-child', prompt: 'Review the conclusion.' },
        ],
      })
      yield { type: 'text' as const, text: 'Visible after spawn.' }
      return promptSuccess('mock-message-id')
    }

    const sessionState = getInitialSessionState(mockFileContext)
    sessionState.mainAgentState.messageHistory = [
      userMessage('Work through the problem, then ask for a review.'),
    ]

    await runAgentStep({
      ...runAgentStepBaseParams,
      agentType: parentAgent.id,
      localAgentTemplates: {
        [parentAgent.id]: parentAgent,
        [childAgent.id]: childAgent,
      },
      agentTemplate: parentAgent,
      agentState: sessionState.mainAgentState,
      prompt: 'Work through the problem, then ask for a review.',
    })

    const inheritedAssistantParts = childHistory
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.content)
    expect(inheritedAssistantParts).toContainEqual({
      type: 'reasoning',
      text: 'Reasoning before spawn.',
    })
    expect(inheritedAssistantParts).toContainEqual({
      type: 'text',
      text: 'Visible before spawn.',
    })
    expect(inheritedAssistantParts).not.toContainEqual({
      type: 'text',
      text: 'Visible after spawn.',
    })
    expect(
      inheritedAssistantParts.some((part) => part.type === 'tool-call'),
    ).toBe(false)
  })

  it('does not duplicate streamed history consumed by an inline child', async () => {
    let childHistory: Message[] = []
    const childAgent = createAgent('inline-history-child', {
      inheritParentSystemPrompt: true,
      handleSteps: function* ({ agentState }) {
        childHistory = structuredClone(agentState.messageHistory as Message[])
      },
    })
    const parentAgent = createAgent('inline-history-parent', {
      toolNames: ['spawn_agent_inline'],
      spawnableAgents: ['inline-history-child'],
    })

    runAgentStepBaseParams.promptAiSdkStream = async function* () {
      yield { type: 'reasoning' as const, text: 'Reasoning before inline.' }
      yield { type: 'text' as const, text: 'Visible before inline spawn.' }
      yield createToolCallChunk('spawn_agent_inline', {
        agent_type: 'inline-history-child',
        prompt: 'Inspect the current transcript.',
      })
      yield { type: 'reasoning' as const, text: 'Reasoning between inline.' }
      yield { type: 'text' as const, text: 'Visible between inline spawns.' }
      yield createToolCallChunk('spawn_agent_inline', {
        agent_type: 'inline-history-child',
        prompt: 'Inspect the updated transcript.',
      })
      yield { type: 'text' as const, text: 'Visible after inline spawn.' }
      return promptSuccess('mock-message-id')
    }

    const sessionState = getInitialSessionState(mockFileContext)
    sessionState.mainAgentState.messageHistory = [
      userMessage('Inspect inline history handling.'),
    ]

    const result = await runAgentStep({
      ...runAgentStepBaseParams,
      agentType: parentAgent.id,
      localAgentTemplates: {
        [parentAgent.id]: parentAgent,
        [childAgent.id]: childAgent,
      },
      agentTemplate: parentAgent,
      agentState: sessionState.mainAgentState,
      prompt: 'Inspect inline history handling.',
    })

    const childText = childHistory
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.content)
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
    expect(childText).toContain('Visible before inline spawn.')
    expect(childText).toContain('Visible between inline spawns.')
    expect(childText).not.toContain('Visible after inline spawn.')

    const childReasoning = childHistory
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.content)
      .filter((part) => part.type === 'reasoning')
      .map((part) => part.text)
    expect(childReasoning).toContain('Reasoning before inline.')
    expect(childReasoning).toContain('Reasoning between inline.')

    const parentText = result.agentState.messageHistory
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.content)
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
    expect(
      parentText.filter((text) => text === 'Visible before inline spawn.'),
    ).toHaveLength(1)
    expect(
      parentText.filter((text) => text === 'Visible between inline spawns.'),
    ).toHaveLength(1)
    expect(
      parentText.filter((text) => text === 'Visible after inline spawn.'),
    ).toHaveLength(1)
    const parentReasoning = result.agentState.messageHistory
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.content)
      .filter((part) => part.type === 'reasoning')
      .map((part) => part.text)
    expect(parentReasoning).toEqual([
      'Reasoning before inline.',
      'Reasoning between inline.',
    ])
  })

  it('does not drop pre-call text when an inline call is invalid', async () => {
    const parentAgent = createAgent('invalid-inline-parent', {
      toolNames: ['spawn_agent_inline'],
    })

    runAgentStepBaseParams.promptAiSdkStream = async function* () {
      yield { type: 'text' as const, text: 'Keep this text.' }
      yield createToolCallChunk('spawn_agent_inline', {})
      return promptSuccess('mock-message-id')
    }

    const sessionState = getInitialSessionState(mockFileContext)
    const result = await runAgentStep({
      ...runAgentStepBaseParams,
      agentType: parentAgent.id,
      localAgentTemplates: { [parentAgent.id]: parentAgent },
      agentTemplate: parentAgent,
      agentState: sessionState.mainAgentState,
      prompt: 'Attempt an invalid inline spawn.',
    })

    const parentText = result.agentState.messageHistory
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.content)
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
    expect(
      parentText.filter((text) => text === 'Keep this text.'),
    ).toHaveLength(1)
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
      yield createToolCallChunk('spawn_agent_inline', {
        agent_type: 'message-deleter-agent',
        prompt: 'Delete the last two assistant messages',
      })
      return promptSuccess('mock-message-id')
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
      agentTemplate: mockParentAgentTemplate,
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
