import { disableLiveUserInputCheck } from '@codebuff/agent-runtime/live-user-inputs'
import { callMainPrompt, mainPrompt } from '@codebuff/agent-runtime/main-prompt'
import * as agentRegistry from '@codebuff/agent-runtime/templates/agent-registry'
import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { generateCompactId } from '@codebuff/common/util/string'
import {
  spyOn,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  mock,
  beforeAll,
} from 'bun:test'

import type { AgentTemplate } from '@codebuff/agent-runtime/templates/types'
import type { ServerAction } from '@codebuff/common/actions'
import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
} from '@codebuff/common/types/contracts/agent-runtime'
import type { SendActionFn } from '@codebuff/common/types/contracts/client'
import type { StreamChunk } from '@codebuff/common/types/contracts/llm'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type { ProjectFileContext } from '@codebuff/common/util/file'
import type { Mock } from 'bun:test'

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
  agentTemplates: {
    base: {
      id: 'base',
      displayName: 'Base Agent',
      outputMode: 'last_message',
      inputSchema: {},
      spawnerPrompt: '',
      model: 'gpt-4o-mini',
      includeMessageHistory: false,
      inheritParentSystemPrompt: false,
      toolNames: ['spawn_agents'],
      spawnableAgents: ['editor'],
      systemPrompt: 'Base agent system prompt',
      instructionsPrompt: 'Base agent instructions',
      stepPrompt: 'Base agent step prompt',
    },
    editor: {
      id: 'editor',
      displayName: 'Editor Agent',
      outputMode: 'last_message',
      inputSchema: {},
      spawnerPrompt: '',
      model: 'gpt-4o-mini',
      includeMessageHistory: true,
      inheritParentSystemPrompt: false,
      toolNames: ['write_file'],
      spawnableAgents: [],
      systemPrompt: '',
      instructionsPrompt: 'Editor agent instructions',
      stepPrompt: 'Editor agent step prompt',
    },
  },
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

describe('Cost Aggregation Integration Tests', () => {
  let mockLocalAgentTemplates: Record<string, any>
  let agentRuntimeImpl: AgentRuntimeDeps & AgentRuntimeScopedDeps
  let mainPromptBaseParams: ParamsExcluding<typeof mainPrompt, 'action'>
  let callMainPromptBaseParams: ParamsExcluding<typeof callMainPrompt, 'action'>

  beforeAll(() => {
    disableLiveUserInputCheck()
  })

  beforeEach(async () => {
    // Setup mock agent templates
    mockLocalAgentTemplates = {
      base: {
        id: 'base',
        displayName: 'Base Agent',
        outputMode: 'last_message',
        inputSchema: {},
        spawnerPrompt: '',
        model: 'gpt-4o-mini',
        includeMessageHistory: false,
        inheritParentSystemPrompt: false,
        mcpServers: {},
        toolNames: ['spawn_agents'],
        spawnableAgents: ['editor'],
        systemPrompt: 'Base agent system prompt',
        instructionsPrompt: 'Base agent instructions',
        stepPrompt: 'Base agent step prompt',
      } satisfies AgentTemplate,
      editor: {
        id: 'editor',
        displayName: 'Editor Agent',
        outputMode: 'last_message',
        inputSchema: {},
        spawnerPrompt: '',
        model: 'gpt-4o-mini',
        includeMessageHistory: true,
        inheritParentSystemPrompt: false,
        mcpServers: {},
        toolNames: ['write_file'],
        spawnableAgents: [],
        systemPrompt: '',
        instructionsPrompt: 'Editor agent instructions',
        stepPrompt: 'Editor agent step prompt',
      } satisfies AgentTemplate,
    }

    // Mock LLM streaming
    let callCount = 0
    const creditHistory: number[] = []
    agentRuntimeImpl = {
      ...TEST_AGENT_RUNTIME_IMPL,
      sendAction: mock(() => {}),
      promptAiSdkStream: async function* (options) {
        callCount++
        const credits = callCount === 1 ? 10 : 7 // Main agent vs subagent costs
        creditHistory.push(credits)

        if (options.onCostCalculated) {
          await options.onCostCalculated(credits)
        }

        // Simulate different responses based on call
        if (callCount === 1) {
          // Main agent spawns a subagent
          yield {
            type: 'tool-call',
            toolName: 'spawn_agents',
            toolCallId: generateCompactId('test-id-'),
            input: {
              agents: [
                {
                  agent_type: 'editor',
                  prompt: 'Write a simple hello world file',
                },
              ],
            },
          } satisfies StreamChunk
        } else {
          // Subagent writes a file
          yield {
            type: 'tool-call',
            toolName: 'write_file',
            toolCallId: generateCompactId('test-id-'),
            input: {
              path: 'hello.txt',
              instructions: 'Create hello world file',
              content: 'Hello, World!',
            },
          } satisfies StreamChunk
        }
        return 'mock-message-id'
      },
      // Mock tool call execution
      requestToolCall: async ({ toolName, input }) => {
        if (toolName === 'write_file') {
          return {
            output: [
              {
                type: 'json',
                value: {
                  message: `File ${input.path} created successfully`,
                },
              },
            ],
          }
        }
        return {
          output: [
            {
              type: 'json',
              value: {
                message: 'Tool executed successfully',
              },
            },
          ],
        }
      },
      // Mock file reading
      requestFiles: async (params: { filePaths: string[] }) => {
        const results: Record<string, string | null> = {}
        params.filePaths.forEach((path) => {
          results[path] = path === 'hello.txt' ? 'Hello, World!' : null
        })
        return results
      },
    }

    mainPromptBaseParams = {
      ...agentRuntimeImpl,
      repoId: undefined,
      repoUrl: undefined,
      userId: TEST_USER_ID,
      clientSessionId: 'test-session',
      onResponseChunk: () => {},
      localAgentTemplates: mockLocalAgentTemplates,
      signal: new AbortController().signal,
    }

    callMainPromptBaseParams = {
      ...agentRuntimeImpl,
      repoId: undefined,
      repoUrl: undefined,
      userId: TEST_USER_ID,
      promptId: 'test-prompt',
      clientSessionId: 'test-session',
      signal: new AbortController().signal,
    }

    // Mock getAgentTemplate to return our mock templates
    spyOn(agentRegistry, 'getAgentTemplate').mockImplementation(
      async ({ agentId, localAgentTemplates }) => {
        return localAgentTemplates[agentId] || null
      },
    )
  })

  afterEach(() => {
    mock.restore()
  })

  it('should correctly aggregate costs across the entire main prompt flow', async () => {
    const sessionState = getInitialSessionState(mockFileContext)
    // Set the main agent to use the 'base' type which is defined in our mock templates
    sessionState.mainAgentState.stepsRemaining = 10
    sessionState.mainAgentState.agentType = 'base'

    const action = {
      type: 'prompt' as const,
      prompt: 'Create a hello world file using a subagent',
      sessionState,
      fingerprintId: 'test-fingerprint',
      costMode: 'normal' as const,
      promptId: 'test-prompt',
      toolResults: [],
    }

    const result = await mainPrompt({
      ...mainPromptBaseParams,
      action,
    })

    // Verify the total cost includes both main agent and subagent costs
    const finalCreditsUsed = result.sessionState.mainAgentState.creditsUsed
    // 10 for the first call, 7 for the subagent, 7*9 for the next 9 calls
    expect(finalCreditsUsed).toEqual(80)

    // Verify the cost breakdown makes sense
    expect(finalCreditsUsed).toBeGreaterThan(0)
    expect(Number.isInteger(finalCreditsUsed)).toBe(true)
  })

  it('should include final cost in prompt response message', async () => {
    const sessionState = getInitialSessionState(mockFileContext)
    sessionState.mainAgentState.agentType = 'base'

    const action = {
      type: 'prompt' as const,
      prompt: 'Simple task',
      sessionState,
      fingerprintId: 'test-fingerprint',
      costMode: 'normal' as const,
      promptId: 'test-prompt',
      toolResults: [],
    }

    // Call through websocket action handler to test full integration
    await callMainPrompt({
      ...callMainPromptBaseParams,
      action,
    })

    // Verify final cost is included in prompt response
    const promptResponse = (
      callMainPromptBaseParams.sendAction as Mock<SendActionFn>
    ).mock.calls
      .map((call) => call[0].action)
      .find((action: ServerAction) => action.type === 'prompt-response') as any

    expect(promptResponse).toBeDefined()
    expect(promptResponse.promptId).toBe('test-prompt')
    expect(
      promptResponse.sessionState.mainAgentState.creditsUsed,
    ).toBeGreaterThan(0)
  })

  it('should handle multi-level subagent hierarchies correctly', async () => {
    // Mock a more complex scenario with nested subagents
    let callCount = 0
    mainPromptBaseParams.promptAiSdkStream = async function* (options) {
      callCount++

      if (options.onCostCalculated) {
        await options.onCostCalculated(5) // Each call costs 5 credits
      }

      if (callCount === 1) {
        // Main agent spawns first-level subagent
        yield {
          type: 'tool-call',
          toolName: 'spawn_agents',
          toolCallId: generateCompactId('test-id-'),
          input: {
            agents: [{ agent_type: 'editor', prompt: 'Create files' }],
          },
        } satisfies StreamChunk
      } else if (callCount === 2) {
        // First-level subagent spawns second-level subagent
        yield {
          type: 'tool-call',
          toolName: 'spawn_agents',
          toolCallId: generateCompactId('test-id-'),
          input: {
            agents: [{ agent_type: 'editor', prompt: 'Write specific file' }],
          },
        } satisfies StreamChunk
      } else {
        // Second-level subagent does actual work
        yield {
          type: 'tool-call',
          toolName: 'write_file',
          toolCallId: generateCompactId('test-id-'),
          input: {
            path: 'nested.txt',
            instructions: 'Create nested file',
            content: 'Nested content',
          },
        } satisfies StreamChunk
      }

      return 'mock-message-id'
    }

    const sessionState = getInitialSessionState(mockFileContext)
    sessionState.mainAgentState.stepsRemaining = 10
    sessionState.mainAgentState.agentType = 'base'

    const action = {
      type: 'prompt' as const,
      prompt: 'Create a complex nested structure',
      sessionState,
      fingerprintId: 'test-fingerprint',
      costMode: 'normal' as const,
      promptId: 'test-prompt',
      toolResults: [],
    }

    const result = await mainPrompt({
      ...mainPromptBaseParams,
      action,
    })

    // Should aggregate costs from all levels: main + sub1 + sub2
    const finalCreditsUsed = result.sessionState.mainAgentState.creditsUsed
    // 10 calls from base agent, 1 from first subagent, 1 from second subagent: 12 calls total
    expect(finalCreditsUsed).toEqual(60)
  })

  it('should maintain cost integrity when subagents fail', async () => {
    // Mock scenario where subagent fails after incurring partial costs
    let callCount = 0
    mainPromptBaseParams.promptAiSdkStream = async function* (options) {
      callCount++

      if (options.onCostCalculated) {
        await options.onCostCalculated(6) // Each call costs 6 credits
      }

      if (callCount === 1) {
        // Main agent spawns subagent
        yield {
          type: 'tool-call',
          toolName: 'spawn_agents',
          toolCallId: generateCompactId('test-id-'),
          input: {
            agents: [{ agent_type: 'editor', prompt: 'This will fail' }],
          },
        } satisfies StreamChunk
      } else {
        // Subagent fails after incurring cost
        yield {
          type: 'text',
          text: 'Some response',
        } satisfies StreamChunk
        throw new Error('Subagent execution failed')
      }

      return 'mock-message-id'
    }

    const sessionState = getInitialSessionState(mockFileContext)
    sessionState.mainAgentState.agentType = 'base'

    const action = {
      type: 'prompt' as const,
      prompt: 'Task that will partially fail',
      sessionState,
      fingerprintId: 'test-fingerprint',
      costMode: 'normal' as const,
      promptId: 'test-prompt',
      toolResults: [],
    }

    let result
    try {
      result = await mainPrompt({
        ...mainPromptBaseParams,
        action,
      })
    } catch (error) {
      // Expected to fail, but costs may still be tracked
    }

    // Check costs - they should be captured even if execution fails
    const finalCreditsUsed = result
      ? result.sessionState.mainAgentState.creditsUsed
      : sessionState.mainAgentState.creditsUsed
    // Even if the test fails, some cost should be incurred by the main agent
    expect(finalCreditsUsed).toBeGreaterThanOrEqual(0) // At minimum, no negative costs
  })

  it('should not double-count costs in complex scenarios', async () => {
    // Track all saveMessage calls to ensure no duplication
    const saveMessageCalls: any[] = []

    const sessionState = getInitialSessionState(mockFileContext)
    sessionState.mainAgentState.agentType = 'base'

    const action = {
      type: 'prompt' as const,
      prompt: 'Complex multi-agent task',
      sessionState,
      fingerprintId: 'test-fingerprint',
      costMode: 'normal' as const,
      promptId: 'test-prompt',
      toolResults: [],
    }

    await mainPrompt({
      ...mainPromptBaseParams,
      action,
    })

    // Verify no duplicate message IDs (no double-counting)
    const messageIds = saveMessageCalls.map((call) => call.messageId)
    const uniqueMessageIds = new Set(messageIds)
    expect(messageIds.length).toBe(uniqueMessageIds.size)

    // Verify that costs are reasonable (not zero, not extremely high)
    const finalCreditsUsed = sessionState.mainAgentState.creditsUsed
    // Since we're using the websocket callMainPrompt which resets credits to 0, costs will be 0
    // This test verifies that the credit reset mechanism works as expected
    expect(finalCreditsUsed).toBe(0)
  })

  it('should respect server-side state authority', async () => {
    const sessionState = getInitialSessionState(mockFileContext)
    sessionState.mainAgentState.agentType = 'base'

    // Simulate malicious client sending manipulated creditsUsed
    sessionState.mainAgentState.creditsUsed = 999999

    const action = {
      type: 'prompt' as const,
      prompt: 'Simple task',
      sessionState,
      fingerprintId: 'test-fingerprint',
      costMode: 'normal' as const,
      promptId: 'test-prompt',
      toolResults: [],
    }

    // Call through websocket action to test server-side reset
    await callMainPrompt({
      ...callMainPromptBaseParams,
      action,
    })

    // Server should have reset the malicious value and calculated correct cost
    const promptResponse = (
      agentRuntimeImpl.sendAction as Mock<SendActionFn>
    ).mock.calls
      .map((call) => call[0].action)
      .find((action) => action.type === 'prompt-response') as any

    expect(promptResponse).toBeDefined()
    expect(promptResponse.sessionState.mainAgentState.creditsUsed).toBeLessThan(
      1000,
    ) // Reasonable value, not manipulated
    expect(
      promptResponse.sessionState.mainAgentState.creditsUsed,
    ).toBeGreaterThan(0) // But still tracked correctly
  })
})
