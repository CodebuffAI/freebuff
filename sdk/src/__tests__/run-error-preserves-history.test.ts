import * as mainPromptModule from '@codebuff/agent-runtime/main-prompt'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { getStubProjectFileContext } from '@codebuff/common/util/file'
import { assistantMessage, userMessage } from '@codebuff/common/util/messages'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { CodebuffClient } from '../client'
import * as databaseModule from '../impl/database'

interface ToolCallContentBlock {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}

const setupDatabaseMocks = () => {
  spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
    id: 'user-123',
    email: 'test@example.com',
    name: null,
    discord_id: null,
    stripe_customer_id: null,
    banned: false,
    created_at: new Date('2024-01-01T00:00:00Z'),
  })
  spyOn(databaseModule, 'fetchAgentFromDatabase').mockResolvedValue(null)
  spyOn(databaseModule, 'startAgentRun').mockResolvedValue('run-1')
  spyOn(databaseModule, 'finishAgentRun').mockResolvedValue(undefined)
  spyOn(databaseModule, 'addAgentStep').mockResolvedValue('step-1')
}

describe('Error preserves in-progress message history', () => {
  afterEach(() => {
    mock.restore()
  })

  it('preserves in-progress assistant work on error (simulated via shared state mutation)', async () => {
    setupDatabaseMocks()

    // Simulate the agent runtime:
    // 1. Mutates the shared session state with the user message and partial work
    // 2. Then throws due to a downstream timeout/service error
    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const mainAgentState = params.action.sessionState.mainAgentState

        // Match the real runtime's behavior: replace messageHistory with a new
        // array that includes the user prompt as its first entry. The SDK
        // detects runtime progress via reference inequality, so we must
        // reassign the array rather than pushing into it.
        mainAgentState.messageHistory = [
          ...mainAgentState.messageHistory,
          {
            role: 'user',
            content: [{ type: 'text', text: 'Fix the bug in auth.ts' }],
            tags: ['USER_PROMPT'],
          },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me read the auth file first.' },
              {
                type: 'tool-call',
                toolCallId: 'read-1',
                toolName: 'read_files',
                input: { paths: ['auth.ts'] },
              } as ToolCallContentBlock,
            ],
          },
          {
            role: 'tool',
            toolCallId: 'read-1',
            toolName: 'read_files',
            content: [
              {
                type: 'json',
                value: [{ path: 'auth.ts', content: 'const auth = ...' }],
              },
            ],
          },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Found the issue, writing the fix now.' },
              {
                type: 'tool-call',
                toolCallId: 'write-1',
                toolName: 'write_file',
                input: { path: 'auth.ts', content: 'const auth = fixed' },
              } as ToolCallContentBlock,
            ],
          },
          {
            role: 'tool',
            toolCallId: 'write-1',
            toolName: 'write_file',
            content: [{ type: 'json', value: { file: 'auth.ts', message: 'File written' } }],
          },
        ]

        // Now simulate a server timeout on the next LLM call
        const timeoutError = new Error('Service Unavailable') as Error & {
          statusCode: number
          responseBody: string
        }
        timeoutError.statusCode = 503
        timeoutError.responseBody = JSON.stringify({
          message: 'Request timeout after 30s',
        })
        throw timeoutError
      },
    )

    const client = new CodebuffClient({ apiKey: 'test-key' })
    const result = await client.run({
      agent: 'base2',
      prompt: 'Fix the bug in auth.ts',
    })

    // Error output with correct status code
    expect(result.output.type).toBe('error')
    const errorOutput = result.output as {
      type: 'error'
      message: string
      statusCode?: number
    }
    expect(errorOutput.statusCode).toBe(503)

    const history = result.sessionState!.mainAgentState.messageHistory

    // The user's prompt should appear exactly once
    const userPromptMessages = history.filter(
      (m) =>
        m.role === 'user' &&
        (m.content as Array<{ type: string; text?: string }>).some(
          (c) => c.type === 'text' && c.text?.includes('Fix the bug'),
        ),
    )
    expect(userPromptMessages.length).toBe(1)

    // Assistant text messages from both steps should be preserved
    const firstAssistantText = history.find(
      (m) =>
        m.role === 'assistant' &&
        (m.content as Array<{ type: string; text?: string }>).some(
          (c) => c.type === 'text' && c.text?.includes('read the auth file'),
        ),
    )
    expect(firstAssistantText).toBeDefined()

    const secondAssistantText = history.find(
      (m) =>
        m.role === 'assistant' &&
        (m.content as Array<{ type: string; text?: string }>).some(
          (c) => c.type === 'text' && c.text?.includes('writing the fix'),
        ),
    )
    expect(secondAssistantText).toBeDefined()

    // Both tool calls and both tool results should be preserved
    const readToolCall = history.find(
      (m) =>
        m.role === 'assistant' &&
        (m.content as Array<{ type: string; toolCallId?: string }>).some(
          (c) => c.type === 'tool-call' && c.toolCallId === 'read-1',
        ),
    )
    expect(readToolCall).toBeDefined()

    const writeToolCall = history.find(
      (m) =>
        m.role === 'assistant' &&
        (m.content as Array<{ type: string; toolCallId?: string }>).some(
          (c) => c.type === 'tool-call' && c.toolCallId === 'write-1',
        ),
    )
    expect(writeToolCall).toBeDefined()

    const readToolResult = history.find(
      (m) => m.role === 'tool' && m.toolCallId === 'read-1',
    )
    expect(readToolResult).toBeDefined()

    const writeToolResult = history.find(
      (m) => m.role === 'tool' && m.toolCallId === 'write-1',
    )
    expect(writeToolResult).toBeDefined()
  })

  it('a subsequent run after error includes the preserved in-progress history', async () => {
    setupDatabaseMocks()

    // Run 1: agent does some work then hits an error
    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const mainAgentState = params.action.sessionState.mainAgentState

        mainAgentState.messageHistory = [
          ...mainAgentState.messageHistory,
          {
            role: 'user',
            content: [{ type: 'text', text: 'Investigate the login bug' }],
            tags: ['USER_PROMPT'],
          },
          assistantMessage('I found the problem in auth.ts on line 42.'),
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'read-login',
                toolName: 'read_files',
                input: { paths: ['login.ts'] },
              } as ToolCallContentBlock,
            ],
          },
          {
            role: 'tool',
            toolCallId: 'read-login',
            toolName: 'read_files',
            content: [{ type: 'json', value: [{ path: 'login.ts', content: 'login code' }] }],
          },
        ]

        const error = new Error('Service Unavailable') as Error & {
          statusCode: number
        }
        error.statusCode = 503
        throw error
      },
    )

    const client = new CodebuffClient({ apiKey: 'test-key' })
    const firstResult = await client.run({
      agent: 'base2',
      prompt: 'Investigate the login bug',
    })

    expect(firstResult.output.type).toBe('error')

    // Run 2: use the failed run as previousRun
    mock.restore()
    setupDatabaseMocks()

    let historyReceivedByRuntime: unknown[] | undefined
    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId } = params
        historyReceivedByRuntime = [
          ...params.action.sessionState.mainAgentState.messageHistory,
        ]

        const responseSessionState = getInitialSessionState(
          getStubProjectFileContext(),
        )
        responseSessionState.mainAgentState.messageHistory = [
          ...params.action.sessionState.mainAgentState.messageHistory,
          userMessage('Now try again'),
          assistantMessage('Continuing with the fix.'),
        ]

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState: responseSessionState,
            output: { type: 'lastMessage', value: [] },
          },
        })

        return {
          sessionState: responseSessionState,
          output: { type: 'lastMessage' as const, value: [] },
        }
      },
    )

    const secondResult = await client.run({
      agent: 'base2',
      prompt: 'Now try again',
      previousRun: firstResult,
    })

    // The runtime should have received history containing the work from the first run
    expect(historyReceivedByRuntime).toBeDefined()
    const receivedReadCall = historyReceivedByRuntime!.find(
      (m) =>
        (m as { role: string }).role === 'assistant' &&
        ((m as { content: Array<{ type: string; toolCallId?: string }> })
          .content ?? []).some(
          (c) => c.type === 'tool-call' && c.toolCallId === 'read-login',
        ),
    )
    expect(receivedReadCall).toBeDefined()

    const receivedToolResult = historyReceivedByRuntime!.find(
      (m) =>
        (m as { role: string }).role === 'tool' &&
        (m as { toolCallId: string }).toolCallId === 'read-login',
    )
    expect(receivedToolResult).toBeDefined()

    // Final result should preserve history
    const finalHistory = secondResult.sessionState!.mainAgentState.messageHistory
    const finalReadCall = finalHistory.find(
      (m) =>
        m.role === 'assistant' &&
        (m.content as Array<{ type: string; toolCallId?: string }>).some(
          (c) => c.type === 'tool-call' && c.toolCallId === 'read-login',
        ),
    )
    expect(finalReadCall).toBeDefined()
  })
})
