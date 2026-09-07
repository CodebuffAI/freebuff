import * as analytics from '@codebuff/common/analytics'
import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { createTestAgentRuntimeParams } from '@codebuff/common/testing/fixtures/agent-runtime'
import { promptSuccess } from '@codebuff/common/util/error'
import {
  AgentTemplateTypes,
  getInitialSessionState,
} from '@codebuff/common/types/session-state'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'

import { mainPrompt } from '../main-prompt'
import * as processFileBlockModule from '../process-file-block'
import { createToolCallChunk } from './test-utils'

import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type {
  RequestFilesFn,
  RequestOptionalFileFn,
  RequestToolCallFn,
} from '@codebuff/common/types/contracts/client'
import type { ParamsOf } from '@codebuff/common/types/function-params'
import type { ProjectFileContext } from '@codebuff/common/util/file'

let mainPromptBaseParams: any

import type { StreamChunk } from '@codebuff/common/types/contracts/llm'

const mockAgentStream = (chunks: StreamChunk[]) => {
  mainPromptBaseParams.promptAiSdkStream = async function* ({}) {
    for (const chunk of chunks) {
      yield chunk
    }
    return 'mock-message-id'
  }
}

describe('mainPrompt', () => {
  let mockLocalAgentTemplates: Record<string, any>

  beforeEach(() => {
    // Setup common mock agent templates
    mockLocalAgentTemplates = {
      [AgentTemplateTypes.base]: {
        id: AgentTemplateTypes.base,
        displayName: 'Base Agent',
        outputMode: 'last_message',
        inputSchema: {},
        spawnerPrompt: '',
        model: 'gpt-4o-mini',
        includeMessageHistory: true,
        inheritParentSystemPrompt: false,
        mcpServers: {},
        toolNames: ['write_file', 'run_terminal_command', 'end_turn'],
        spawnableAgents: [],
        systemPrompt: '',
        instructionsPrompt: '',
        stepPrompt: '',
      } satisfies AgentTemplate,
      [AgentTemplateTypes.base_max]: {
        id: AgentTemplateTypes.base_max,
        displayName: 'Base Max Agent',
        outputMode: 'last_message',
        inputSchema: {},
        spawnerPrompt: '',
        model: 'gpt-4o',
        includeMessageHistory: true,
        inheritParentSystemPrompt: false,
        mcpServers: {},
        toolNames: ['write_file', 'run_terminal_command', 'end_turn'],
        spawnableAgents: [],
        systemPrompt: '',
        instructionsPrompt: '',
        stepPrompt: '',
      } satisfies AgentTemplate,
    }

    mainPromptBaseParams = {
      ...createTestAgentRuntimeParams(),
      repoId: undefined,
      repoUrl: undefined,
      userId: TEST_USER_ID,
      clientSessionId: 'test-session',
      onResponseChunk: () => {},
      localAgentTemplates: mockLocalAgentTemplates,
      signal: new AbortController().signal,
      // Mock fetch to return a token count response
      fetch: async () =>
        ({
          ok: true,
          text: async () => JSON.stringify({ inputTokens: 1000 }),
        }) as Response,
    }

    // Mock analytics
    spyOn(analytics, 'trackEvent').mockImplementation(() => {})

    // Mock processFileBlock
    spyOn(processFileBlockModule, 'processFileBlock').mockImplementation(
      async (params) => {
        return promptSuccess({
          tool: 'write_file' as const,
          path: params.path,
          content: params.newContent,
          patch: undefined,
          messages: [],
        })
      },
    )

    // Mock LLM APIs
    mockAgentStream([{ type: 'text', text: 'Test response' }])

    // Mock websocket actions
    mainPromptBaseParams.requestFiles = async ({
      filePaths,
    }: ParamsOf<RequestFilesFn>) => {
      const results: Record<string, string | null> = {}
      filePaths.forEach((p) => {
        if (p === 'test.txt') {
          results[p] = 'mock content for test.txt'
        } else {
          results[p] = null
        }
      })
      return results
    }

    mainPromptBaseParams.requestOptionalFile = async ({
      filePath,
    }: ParamsOf<RequestOptionalFileFn>) => {
      if (filePath === 'test.txt') {
        return 'mock content for test.txt'
      }
      return null
    }

    mainPromptBaseParams.requestToolCall = mock(
      async ({
        toolName,
        input,
      }: ParamsOf<RequestToolCallFn>): ReturnType<RequestToolCallFn> => ({
        output: [
          {
            type: 'json',
            value: `Tool call success: ${{ toolName, input }}`,
          },
        ],
      }),
    )
  })

  afterEach(() => {
    // Clear all mocks after each test
    mock.restore()
  })

  class _MockWebSocket {
    send(msg: string) {}
    close() {}
    on(event: string, listener: (...args: any[]) => void) {}
    removeListener(event: string, listener: (...args: any[]) => void) {}
  }

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
      chromeAvailable: false,
    },
  }

  it('does not include other local agents in spawnableAgents when agentId is provided', async () => {
    // When a specific agentId is provided, we only use the spawnable agents
    // defined in that agent's template - we don't auto-add all available agents
    const sessionState = getInitialSessionState(mockFileContext)
    const mainAgentId = 'test-main-agent'
    const localAgentId = 'test-local-agent'

    const localAgentTemplates: Record<string, AgentTemplate> = {
      [mainAgentId]: {
        id: mainAgentId,
        displayName: 'Test Main Agent',
        outputMode: 'last_message',
        inputSchema: {},
        spawnerPrompt: '',
        model: 'gpt-4o-mini',
        includeMessageHistory: true,
        inheritParentSystemPrompt: false,
        mcpServers: {},
        toolNames: ['write_file', 'run_terminal_command', 'end_turn'],
        spawnableAgents: [],
        systemPrompt: '',
        instructionsPrompt: '',
        stepPrompt: '',
      },
      [localAgentId]: {
        id: localAgentId,
        displayName: 'Test Local Agent',
        outputMode: 'last_message',
        inputSchema: {},
        spawnerPrompt: '',
        model: 'gpt-4o-mini',
        includeMessageHistory: false,
        inheritParentSystemPrompt: false,
        mcpServers: {},
        toolNames: ['write_file', 'run_terminal_command', 'end_turn'],
        spawnableAgents: [],
        systemPrompt: '',
        instructionsPrompt: '',
        stepPrompt: '',
      },
    }

    const action = {
      type: 'prompt' as const,
      prompt: 'Hello',
      sessionState,
      fingerprintId: 'test',
      costMode: 'normal' as const,
      promptId: 'test',
      toolResults: [],
      agentId: mainAgentId,
    }

    await mainPrompt({
      ...mainPromptBaseParams,
      action,
      localAgentTemplates,
    })

    // When agentId is provided, spawnableAgents should only contain what was
    // explicitly defined in the template (empty in this case)
    expect(localAgentTemplates[mainAgentId].spawnableAgents).not.toContain(
      localAgentId,
    )
    expect(localAgentTemplates[mainAgentId].spawnableAgents).toEqual([])
  })

  it('should handle write_file tool call', async () => {
    // Mock LLM to return a write_file tool call using native tool call chunks
    mockAgentStream([
      createToolCallChunk('write_file', {
        path: 'new-file.txt',
        instructions: 'Added Hello World',
        content: 'Hello, world!',
      }),
      createToolCallChunk('end_turn', {}),
    ])

    // Get reference to the spy so we can check if it was called
    const requestToolCallSpy = mainPromptBaseParams.requestToolCall

    const sessionState = getInitialSessionState(mockFileContext)
    const action = {
      type: 'prompt' as const,
      prompt: 'Write hello world to new-file.txt',
      sessionState,
      fingerprintId: 'test',
      costMode: 'max' as const, // This causes streamGemini25Pro to be called
      promptId: 'test',
      toolResults: [],
    }

    await mainPrompt({
      ...mainPromptBaseParams,
      action,
      localAgentTemplates: {
        [AgentTemplateTypes.base]: {
          id: 'base',
          displayName: 'Base Agent',
          outputMode: 'last_message',
          inputSchema: {},
          spawnerPrompt: '',
          model: 'gpt-4o-mini',
          includeMessageHistory: true,
          inheritParentSystemPrompt: false,
          mcpServers: {},
          toolNames: ['write_file', 'run_terminal_command', 'end_turn'],
          spawnableAgents: [],
          systemPrompt: '',
          instructionsPrompt: '',
          stepPrompt: '',
        },
        [AgentTemplateTypes.base_max]: {
          id: 'base-max',
          displayName: 'Base Max Agent',
          outputMode: 'last_message',
          inputSchema: {},
          spawnerPrompt: '',
          model: 'gpt-4o',
          includeMessageHistory: true,
          inheritParentSystemPrompt: false,
          mcpServers: {},
          toolNames: ['write_file', 'run_terminal_command', 'end_turn'],
          spawnableAgents: [],
          systemPrompt: '',
          instructionsPrompt: '',
          stepPrompt: '',
        },
      },
    })

    // Assert that requestToolCall was called exactly once
    expect(requestToolCallSpy).toHaveBeenCalledTimes(1)

    // Verify the write_file call was made with the correct arguments
    expect(requestToolCallSpy).toHaveBeenCalledWith({
      userInputId: expect.any(String), // userInputId
      toolName: 'write_file',
      input: expect.objectContaining({
        type: 'file',
        path: 'new-file.txt',
        content: 'Hello, world!',
      }),
    })
  })

  it('should force end of response after MAX_CONSECUTIVE_ASSISTANT_MESSAGES', async () => {
    const sessionState = getInitialSessionState(mockFileContext)

    // Set up message history with many consecutive assistant messages
    sessionState.mainAgentState.stepsRemaining = 0
    sessionState.mainAgentState.messageHistory = [
      { role: 'user', content: 'Initial prompt' },
      ...Array(20).fill({ role: 'assistant', content: 'Assistant response' }),
    ]

    const action = {
      type: 'prompt' as const,
      prompt: '', // No new prompt
      sessionState,
      fingerprintId: 'test',
      costMode: 'max' as const,
      promptId: 'test',
      toolResults: [],
    }

    const { output } = await mainPrompt({
      ...mainPromptBaseParams,
      action,
    })

    expect(output.type).toBeDefined() // Output should exist
  })

  it('should update consecutiveAssistantMessages when new prompt is received', async () => {
    const sessionState = getInitialSessionState(mockFileContext)
    sessionState.mainAgentState.stepsRemaining = 12
    const initialStepsRemaining = sessionState.mainAgentState.stepsRemaining

    const action = {
      type: 'prompt' as const,
      prompt: 'New user prompt',
      sessionState,
      fingerprintId: 'test',
      costMode: 'max' as const,
      promptId: 'test',
      toolResults: [],
    }

    const { sessionState: newSessionState } = await mainPrompt({
      ...mainPromptBaseParams,
      action,
      localAgentTemplates: mockLocalAgentTemplates,
    })

    // When there's a new prompt, consecutiveAssistantMessages should be set to 1
    expect(newSessionState.mainAgentState.stepsRemaining).toBe(
      initialStepsRemaining - 1,
    )
  })

  it('should increment consecutiveAssistantMessages when no new prompt', async () => {
    const sessionState = getInitialSessionState(mockFileContext)
    const initialCount = 5
    sessionState.mainAgentState.stepsRemaining = initialCount

    const action = {
      type: 'prompt' as const,
      prompt: '', // No new prompt
      sessionState,
      fingerprintId: 'test',
      costMode: 'max' as const,
      promptId: 'test',
      toolResults: [],
    }

    const { sessionState: newSessionState } = await mainPrompt({
      ...mainPromptBaseParams,
      action,
      localAgentTemplates: mockLocalAgentTemplates,
    })

    // When there's no new prompt, consecutiveAssistantMessages should increment by 1
    expect(newSessionState.mainAgentState.stepsRemaining).toBe(initialCount - 1)
  })

  it('should return no tool calls when LLM response is empty', async () => {
    // Mock the LLM stream to return nothing
    mockAgentStream([])

    const sessionState = getInitialSessionState(mockFileContext)
    const action = {
      type: 'prompt' as const,
      prompt: 'Test prompt leading to empty response',
      sessionState,
      fingerprintId: 'test',
      costMode: 'normal' as const,
      promptId: 'test',
      toolResults: [],
    }

    const { output } = await mainPrompt({
      ...mainPromptBaseParams,
      action,
      localAgentTemplates: mockLocalAgentTemplates,
    })

    expect(output.type).toBeDefined() // Output should exist even for empty response
  })

  it('does not replace the history with an empty summary on /compact', async () => {
    // A silent empty stop yields no recovery chunk, so an unguarded /compact
    // replacement would collapse the whole history into one summary message
    // carrying nothing — every earlier turn gone from the model's context.
    mockAgentStream([])

    const sessionState = getInitialSessionState(mockFileContext)
    sessionState.mainAgentState.messageHistory = [
      {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'earlier turn: fix the login bug' }],
        sentAt: 1,
      },
      {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'fixed it' }],
        sentAt: 2,
      },
    ]
    const action = {
      type: 'prompt' as const,
      prompt: '/compact',
      sessionState,
      fingerprintId: 'test',
      costMode: 'normal' as const,
      promptId: 'test',
      toolResults: [],
    }

    const { sessionState: newSessionState } = await mainPrompt({
      ...mainPromptBaseParams,
      action,
      localAgentTemplates: mockLocalAgentTemplates,
    })

    // The history survives: no empty summary message, earlier turns intact.
    const history = newSessionState.mainAgentState.messageHistory
    expect(
      history.some((m) => textOfHistoryMessage(m).includes('The following is a summary')),
    ).toBe(false)
    expect(
      history.some((m) => textOfHistoryMessage(m).includes('earlier turn: fix the login bug')),
    ).toBe(true)
  })

  it('still replaces the history on /compact when the model produced a summary', async () => {
    mockAgentStream([{ type: 'text', text: 'Summary: the user asked to fix the login bug, which was fixed.' }])

    const sessionState = getInitialSessionState(mockFileContext)
    sessionState.mainAgentState.messageHistory = [
      {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'earlier turn: fix the login bug' }],
        sentAt: 1,
      },
      {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'fixed it' }],
        sentAt: 2,
      },
    ]
    const action = {
      type: 'prompt' as const,
      prompt: '/compact',
      sessionState,
      fingerprintId: 'test',
      costMode: 'normal' as const,
      promptId: 'test',
      toolResults: [],
    }

    const { sessionState: newSessionState } = await mainPrompt({
      ...mainPromptBaseParams,
      action,
      localAgentTemplates: mockLocalAgentTemplates,
    })

    const history = newSessionState.mainAgentState.messageHistory
    expect(history).toHaveLength(1)
    expect(textOfHistoryMessage(history[0])).toContain(
      'Summary: the user asked to fix the login bug',
    )
  })
})

function textOfHistoryMessage(message: { content: unknown }): string {
  const content = message.content as unknown
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part: { type?: string; text?: string }) =>
        part.type === 'text' && typeof part.text === 'string' ? part.text : '',
      )
      .join('\n')
  }
  return ''
}
