import * as mainPromptModule from '@codebuff/agent-runtime/main-prompt'
import { withSystemTags } from '@codebuff/agent-runtime/util/messages'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { getStubProjectFileContext } from '@codebuff/common/util/file'
import { assistantMessage, userMessage } from '@codebuff/common/util/messages'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { RetryError } from 'ai'

// Type for tool call content blocks in message history
interface ToolCallContentBlock {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}

import { CodebuffClient } from '../client'
import * as databaseModule from '../impl/database'

import type { RunState } from '../run-state'

describe('Run Cancellation Handling', () => {
  afterEach(() => {
    mock.restore()
  })

  it('does not duplicate user message when server responds with session state', async () => {
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

    // Server session state already includes the user's message (as the server would normally do)
    const serverSessionState = getInitialSessionState(
      getStubProjectFileContext(),
    )
    serverSessionState.mainAgentState.messageHistory.push(
      userMessage('Please fix the bug'), // Server added this
      assistantMessage('I will help you with that.'),
    )

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId } = params

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState: serverSessionState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState: serverSessionState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    const client = new CodebuffClient({
      apiKey: 'test-key',
    })

    const result = await client.run({
      agent: 'base2',
      prompt: 'Please fix the bug',
    })

    // The user's message should NOT be duplicated
    const messageHistory = result.sessionState!.mainAgentState.messageHistory

    const userMessages = messageHistory.filter((m) => m.role === 'user')

    // Should have exactly 1 user message, not 2
    expect(userMessages.length).toBe(1)

    // Total messages should be 2 (user + assistant), not 3
    expect(messageHistory.length).toBe(2)
  })

  it('an abort during the user lookup returns a cancelled run, not an auth error', async () => {
    // the lookup is the first request a run makes; an abort while it hangs must read as a cancel, not "invalid API key"
    const controller = new AbortController()
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockImplementation(
      async (params: { signal?: AbortSignal }) => {
        expect(params.signal).toBe(controller.signal)
        controller.abort()
        throw new Error('Network request failed')
      },
    )
    const mainPrompt = spyOn(
      mainPromptModule,
      'callMainPrompt',
    ).mockImplementation(async () => {
      throw new Error('the request must never be sent')
    })

    const client = new CodebuffClient({ apiKey: 'test-key' })
    const result = await client.run({
      agent: 'base2',
      prompt: 'hello',
      signal: controller.signal,
    })

    expect(result.output).toMatchObject({
      type: 'error',
      message: 'Run cancelled by user.',
    })
    expect(mainPrompt).not.toHaveBeenCalled()
  })

  it('does not duplicate user message when cancelled and server already processed the prompt', async () => {
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

    const abortController = new AbortController()

    // Server session state already includes the user's message (server processed it)
    const serverSessionState = getInitialSessionState(
      getStubProjectFileContext(),
    )
    serverSessionState.mainAgentState.messageHistory.push(
      userMessage('Please fix the bug'), // Server added the user's message
      assistantMessage('I will help you with that.'),
    )

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId } = params

        // Stream some content
        await sendAction({
          action: {
            type: 'response-chunk',
            userInputId: promptId,
            chunk: 'Working on it...',
          },
        })

        // User cancels
        abortController.abort()

        // Simulate agent runtime adding interruption message on abort
        serverSessionState.mainAgentState.messageHistory.push(
          userMessage(
            withSystemTags(
              "User interrupted the response. The assistant's previous work has been preserved.",
            ),
          ),
        )

        // Server still responds with its session state
        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState: serverSessionState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState: serverSessionState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    const client = new CodebuffClient({
      apiKey: 'test-key',
    })

    const result = await client.run({
      agent: 'base2',
      prompt: 'Please fix the bug',
      signal: abortController.signal,
    })

    // The user's message should NOT be duplicated
    const messageHistory = result.sessionState!.mainAgentState.messageHistory

    // Count user messages (excluding system interruption messages)
    const userPromptMessages = messageHistory.filter(
      (m) =>
        m.role === 'user' &&
        m.content.some(
          (c: any) => c.type === 'text' && c.text.includes('fix the bug'),
        ),
    )

    // Should have exactly 1 user message with the prompt, not 2
    expect(userPromptMessages.length).toBe(1)

    // Total messages should be: 1 user + 1 assistant (original) + 1 interruption = 3
    // The server state already has the content; pendingAgentResponse is not duplicated.
    expect(messageHistory.length).toBe(3)
  })

  it('extracts error code and message from AI SDK responseBody on 403', async () => {
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

    // Simulate AI SDK's AI_APICallError with responseBody (what the server returns for free_mode_unavailable)
    const apiError = new Error('Forbidden') as Error & {
      statusCode: number
      responseBody: string
    }
    apiError.statusCode = 403
    apiError.responseBody = JSON.stringify({
      error: 'free_mode_unavailable',
      message: 'Free mode is not available in your country.',
      countryCode: 'US',
      countryBlockReason: 'anonymous_network',
      ipPrivacySignals: ['vpn', 'hosting'],
    })

    spyOn(mainPromptModule, 'callMainPrompt').mockRejectedValue(apiError)

    const client = new CodebuffClient({
      apiKey: 'test-key',
    })

    const result = await client.run({
      agent: 'base2',
      prompt: 'hello',
    })

    expect(result.output.type).toBe('error')
    const output = result.output as {
      type: 'error'
      message: string
      statusCode?: number
      error?: string
      countryCode?: string
      countryBlockReason?: string
      ipPrivacySignals?: string[]
    }
    // Should use the message from the response body, not the generic "Forbidden"
    expect(output.message).toBe('Free mode is not available in your country.')
    expect(output.statusCode).toBe(403)
    // Should propagate the error code so isFreeModeUnavailableError can match
    expect(output.error).toBe('free_mode_unavailable')
    expect(output.countryCode).toBe('US')
    expect(output.countryBlockReason).toBe('anonymous_network')
    expect(output.ipPrivacySignals).toEqual(['vpn', 'hosting'])
  })

  it('extracts error code and message from nested AI SDK retry errors', async () => {
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

    const apiError = new Error('Conflict') as Error & {
      statusCode: number
      responseBody: string
    }
    apiError.statusCode = 409
    apiError.responseBody = JSON.stringify({
      error: 'session_model_mismatch',
      message:
        'This session is bound to deepseek; restart freebuff to switch models.',
    })

    spyOn(mainPromptModule, 'callMainPrompt').mockRejectedValue(
      new RetryError({
        message: 'Failed after 4 attempts. Last error: Conflict',
        reason: 'maxRetriesExceeded',
        errors: [apiError],
      }),
    )

    const client = new CodebuffClient({
      apiKey: 'test-key',
    })

    const result = await client.run({
      agent: 'base2',
      prompt: 'hello',
    })

    const output = result.output as {
      type: 'error'
      message: string
      statusCode?: number
      error?: string
    }
    expect(output.message).toBe(
      'This session is bound to deepseek; restart freebuff to switch models.',
    )
    expect(output.statusCode).toBe(409)
    expect(output.error).toBe('session_model_mismatch')
  })

  it('extracts error code from responseBody for account_suspended 403', async () => {
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

    const apiError = new Error('Forbidden') as Error & {
      statusCode: number
      responseBody: string
    }
    apiError.statusCode = 403
    apiError.responseBody = JSON.stringify({
      error: 'account_suspended',
      message: 'Your account has been suspended due to billing issues.',
    })

    spyOn(mainPromptModule, 'callMainPrompt').mockRejectedValue(apiError)

    const client = new CodebuffClient({
      apiKey: 'test-key',
    })

    const result = await client.run({
      agent: 'base2',
      prompt: 'hello',
    })

    const output = result.output as {
      type: 'error'
      message: string
      statusCode?: number
      error?: string
    }
    expect(output.message).toBe(
      'Your account has been suspended due to billing issues.',
    )
    expect(output.statusCode).toBe(403)
    expect(output.error).toBe('account_suspended')
  })

  it('falls back to error.message when responseBody is not valid JSON', async () => {
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

    const apiError = new Error('Forbidden') as Error & {
      statusCode: number
      responseBody: string
    }
    apiError.statusCode = 403
    apiError.responseBody = 'not valid json'

    spyOn(mainPromptModule, 'callMainPrompt').mockRejectedValue(apiError)

    const client = new CodebuffClient({
      apiKey: 'test-key',
    })

    const result = await client.run({
      agent: 'base2',
      prompt: 'hello',
    })

    const output = result.output as {
      type: 'error'
      message: string
      statusCode?: number
      error?: string
    }
    expect(output.message).toBe('Forbidden')
    expect(output.statusCode).toBe(403)
    expect(output.error).toBeUndefined()
  })

  it('preserves user message when callMainPrompt throws an error', async () => {
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

    // Simulate callMainPrompt throwing an error (network failure, server error, etc.)
    spyOn(mainPromptModule, 'callMainPrompt').mockRejectedValue(
      new Error('Network connection failed'),
    )

    const client = new CodebuffClient({
      apiKey: 'test-key',
    })

    const result = await client.run({
      agent: 'base2',
      prompt: 'Please fix the bug in my code',
    })

    // Should return an error output
    expect(result.output.type).toBe('error')
    expect((result.output as { type: 'error'; message: string }).message).toBe(
      'Network connection failed',
    )

    // The user's message should be preserved in the session state
    expect(result.sessionState).toBeDefined()
    const messageHistory = result.sessionState!.mainAgentState.messageHistory

    // Should have: user message + interruption message
    expect(messageHistory.length).toBeGreaterThanOrEqual(2)

    // Find the user's original prompt message (should have USER_PROMPT tag)
    const userPromptMessage = messageHistory.find(
      (m) => m.role === 'user' && m.tags?.includes('USER_PROMPT'),
    )
    expect(userPromptMessage).toBeDefined()

    // Verify the message content contains the original prompt
    const textContent = userPromptMessage!.content.find(
      (c: any) => c.type === 'text',
    ) as { type: 'text'; text: string } | undefined
    expect(textContent).toBeDefined()
    expect(textContent!.text).toContain('Please fix the bug in my code')
  })

  it('does not add empty assistant message when no streaming content', async () => {
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

    const abortController = new AbortController()
    const serverSessionState = getInitialSessionState(
      getStubProjectFileContext(),
    )
    serverSessionState.mainAgentState.messageHistory.push(
      userMessage('User prompt'),
    )
    const originalHistoryLength =
      serverSessionState.mainAgentState.messageHistory.length

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId } = params

        // Abort immediately WITHOUT any streaming chunks
        abortController.abort()

        // Simulate agent runtime adding interruption message on abort
        serverSessionState.mainAgentState.messageHistory.push(
          userMessage(
            withSystemTags(
              "User interrupted the response. The assistant's previous work has been preserved.",
            ),
          ),
        )

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState: serverSessionState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState: serverSessionState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    const client = new CodebuffClient({
      apiKey: 'test-key',
    })

    const result = await client.run({
      agent: 'base2',
      prompt: 'test prompt',
      signal: abortController.signal,
    })

    const messageHistory = result.sessionState!.mainAgentState.messageHistory

    // Should only have: original history + 1 interruption message (NO empty assistant message)
    expect(messageHistory.length).toBe(originalHistoryLength + 1)

    // The last message should be the interruption (user role), not an empty assistant message
    const lastMessage = messageHistory[messageHistory.length - 1]
    expect(lastMessage.role).toBe('user')
    expect(
      (lastMessage.content[0] as { type: 'text'; text: string }).text,
    ).toContain('User interrupted')

    // Verify there's no empty assistant message before the interruption
    const secondToLastMessage = messageHistory[messageHistory.length - 2]
    // This should be the original 'User prompt' message, not an empty assistant
    expect(secondToLastMessage.role).toBe('user')
  })

  it('preserves user message with USER_PROMPT tag when error thrown during callMainPrompt', async () => {
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

    let streamedContent = ''
    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId } = params

        // Simulate some partial streaming before error
        await sendAction({
          action: {
            type: 'response-chunk',
            userInputId: promptId,
            chunk: 'Starting to analyze...',
          },
        })

        // Then throw an error (simulating connection drop)
        throw new Error('Connection reset by peer')
      },
    )

    const client = new CodebuffClient({
      apiKey: 'test-key',
    })

    const result = await client.run({
      agent: 'base2',
      prompt: 'Implement the feature',
      handleStreamChunk: (chunk) => {
        if (typeof chunk === 'string') {
          streamedContent += chunk
        }
      },
    })

    // Verify we received some streamed content before the error
    expect(streamedContent).toBe('Starting to analyze...')

    // Should have error output
    expect(result.output.type).toBe('error')

    // Session state should be preserved
    expect(result.sessionState).toBeDefined()
    const messageHistory = result.sessionState!.mainAgentState.messageHistory

    // Should have: user message (with USER_PROMPT tag) + error context
    expect(messageHistory.length).toBe(2)

    // First message should be the user's prompt with the tag
    const firstMessage = messageHistory[0]
    expect(firstMessage.role).toBe('user')
    expect(firstMessage.tags).toContain('USER_PROMPT')

    // Second message should be the error context
    const secondMessage = messageHistory[1]
    expect(secondMessage.role).toBe('user')
  })

  it('preserves session state from server when aborted and appends interruption message', async () => {
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

    const abortController = new AbortController()

    // Create a session state with some existing message history to verify it's preserved
    const serverSessionState = getInitialSessionState(
      getStubProjectFileContext(),
    )
    serverSessionState.mainAgentState.messageHistory.push(
      userMessage('User prompt'),
      assistantMessage('I will help you with that.'),
    )

    // Add a tool call to simulate work done by the assistant
    serverSessionState.mainAgentState.messageHistory.push({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me read that file...' },
        {
          type: 'tool-call',
          toolCallId: 'tool-1',
          toolName: 'read_files',
          input: { paths: ['file.ts'] },
        } as ToolCallContentBlock,
      ],
    })
    serverSessionState.mainAgentState.messageHistory.push({
      role: 'tool',
      toolCallId: 'tool-1',
      toolName: 'read_files',
      content: [
        { type: 'json', value: [{ path: 'file.ts', content: 'const x = 1;' }] },
      ],
    })

    const originalHistoryLength =
      serverSessionState.mainAgentState.messageHistory.length

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId } = params

        // Simulate some streaming chunks before abort
        await sendAction({
          action: {
            type: 'response-chunk',
            userInputId: promptId,
            chunk: 'Analyzing the code...',
          },
        })

        // Abort the signal to simulate user cancellation
        abortController.abort()

        // Simulate agent runtime adding interruption message on abort
        serverSessionState.mainAgentState.messageHistory.push(
          userMessage(
            withSystemTags(
              "User interrupted the response. The assistant's previous work has been preserved.",
            ),
          ),
        )

        // Server still sends the prompt-response with the full session state
        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState: serverSessionState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState: serverSessionState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    const client = new CodebuffClient({
      apiKey: 'test-key',
    })

    const result = await client.run({
      agent: 'base2',
      prompt: 'test prompt',
      signal: abortController.signal,
    })

    // Verify session state is returned (not undefined/null)
    expect(result.sessionState).toBeDefined()
    expect(result.sessionState).not.toBeNull()

    // Verify the original message history is preserved
    const messageHistory = result.sessionState!.mainAgentState.messageHistory

    // Should have original messages + 1 interruption message
    // The server state already has the content; pendingAgentResponse is not duplicated.
    expect(messageHistory.length).toBe(originalHistoryLength + 1)

    // Verify the original tool call is still present (work was preserved)
    const toolCallMessage = messageHistory.find(
      (m) =>
        m.role === 'assistant' &&
        m.content.some(
          (c: any) => c.type === 'tool-call' && c.toolCallId === 'tool-1',
        ),
    )
    expect(toolCallMessage).toBeDefined()

    const toolResultMessage = messageHistory.find(
      (m) => m.role === 'tool' && m.toolCallId === 'tool-1',
    )
    expect(toolResultMessage).toBeDefined()

    // Verify the interruption message was appended
    const lastMessage = messageHistory[messageHistory.length - 1]
    expect(lastMessage.role).toBe('user')
  })

  it('interruption message uses withSystemTags format', async () => {
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

    const abortController = new AbortController()
    const serverSessionState = getInitialSessionState(
      getStubProjectFileContext(),
    )

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId } = params

        // Abort before sending response
        abortController.abort()

        // Simulate agent runtime adding interruption message on abort
        serverSessionState.mainAgentState.messageHistory.push(
          userMessage(
            withSystemTags(
              "User interrupted the response. The assistant's previous work has been preserved.",
            ),
          ),
        )

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState: serverSessionState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState: serverSessionState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    const client = new CodebuffClient({
      apiKey: 'test-key',
    })

    const result = await client.run({
      agent: 'base2',
      prompt: 'test prompt',
      signal: abortController.signal,
    })

    const messageHistory = result.sessionState!.mainAgentState.messageHistory
    const lastMessage = messageHistory[messageHistory.length - 1]

    // Verify the message content uses withSystemTags format
    expect(lastMessage.role).toBe('user')
    expect(Array.isArray(lastMessage.content)).toBe(true)

    const textContent = lastMessage.content.find(
      (c: any) => c.type === 'text',
    ) as { type: 'text'; text: string } | undefined
    expect(textContent).toBeDefined()

    // The text should be wrapped in <system> tags
    const expectedText = withSystemTags(
      "User interrupted the response. The assistant's previous work has been preserved.",
    )
    expect(textContent!.text).toBe(expectedText)

    // Verify the tag format explicitly
    expect(textContent!.text).toContain('<system>')
    expect(textContent!.text).toContain('</system>')
    expect(textContent!.text).toContain('User interrupted the response')
  })

  it('returns cancelled state when aborted before call starts', async () => {
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      name: null,
      discord_id: null,
      stripe_customer_id: null,
      banned: false,
      created_at: new Date('2024-01-01T00:00:00Z'),
    })

    const abortController = new AbortController()
    // Abort before the run starts
    abortController.abort()

    const client = new CodebuffClient({
      apiKey: 'test-key',
    })

    const result = await client.run({
      agent: 'base2',
      prompt: 'test prompt',
      signal: abortController.signal,
    })

    // When aborted before starting, should return an error output
    expect(result.output.type).toBe('error')
  })

  it('does not add interruption message when not aborted', async () => {
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

    const serverSessionState = getInitialSessionState(
      getStubProjectFileContext(),
    )
    serverSessionState.mainAgentState.messageHistory.push(
      userMessage('User prompt'),
      assistantMessage('Done!'),
    )
    const originalHistoryLength =
      serverSessionState.mainAgentState.messageHistory.length

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId } = params

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState: serverSessionState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState: serverSessionState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    const client = new CodebuffClient({
      apiKey: 'test-key',
    })

    // Run without aborting
    const result = await client.run({
      agent: 'base2',
      prompt: 'test prompt',
    })

    // Message history should not have an interruption message
    const messageHistory = result.sessionState!.mainAgentState.messageHistory
    expect(messageHistory.length).toBe(originalHistoryLength)

    // Last message should be the assistant's "Done!" message, not an interruption
    const lastMessage = messageHistory[messageHistory.length - 1]
    expect(lastMessage.role).toBe('assistant')
  })

  it('preserves message history across cancelled run and subsequent run', async () => {
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

    const abortController = new AbortController()

    // First run: server processes the user message and does some work, then user cancels
    const firstRunServerState = getInitialSessionState(
      getStubProjectFileContext(),
    )
    firstRunServerState.mainAgentState.messageHistory.push(
      userMessage('Fix the bug in auth.ts'),
      assistantMessage('I will analyze the authentication module.'),
    )

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId } = params

        // Stream some content
        await sendAction({
          action: {
            type: 'response-chunk',
            userInputId: promptId,
            chunk: 'Analyzing auth.ts...',
          },
        })

        // User cancels mid-stream
        abortController.abort()

        // Agent runtime adds interruption message on abort
        firstRunServerState.mainAgentState.messageHistory.push(
          userMessage(
            withSystemTags(
              "User interrupted the response. The assistant's previous work has been preserved.",
            ),
          ),
        )

        // Server still sends the prompt-response with its session state
        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState: firstRunServerState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState: firstRunServerState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    const client = new CodebuffClient({
      apiKey: 'test-key',
    })

    // Run 1: cancelled mid-stream
    const firstRunResult = await client.run({
      agent: 'base2',
      prompt: 'Fix the bug in auth.ts',
      signal: abortController.signal,
    })

    // Verify the first run preserved the user message and work
    expect(firstRunResult.sessionState).toBeDefined()
    const firstHistory =
      firstRunResult.sessionState!.mainAgentState.messageHistory
    expect(firstHistory.length).toBe(3) // user + assistant + interruption

    const firstUserMsg = firstHistory.find(
      (m) =>
        m.role === 'user' &&
        m.content.some(
          (c: any) => c.type === 'text' && c.text.includes('Fix the bug'),
        ),
    )
    expect(firstUserMsg).toBeDefined()

    // Now set up mock for the second run
    mock.restore()
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
    spyOn(databaseModule, 'startAgentRun').mockResolvedValue('run-2')
    spyOn(databaseModule, 'finishAgentRun').mockResolvedValue(undefined)
    spyOn(databaseModule, 'addAgentStep').mockResolvedValue('step-2')

    // Second run: server receives the previous state and adds the new user message
    const secondRunServerState = JSON.parse(
      JSON.stringify(firstRunResult.sessionState!),
    ) as typeof firstRunServerState
    secondRunServerState.mainAgentState.messageHistory.push(
      userMessage('Now also fix the login page'),
      assistantMessage('I will fix both issues.'),
    )

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId } = params

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState: secondRunServerState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState: secondRunServerState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    // Run 2: uses previousRun from the cancelled first run
    const secondRunResult = await client.run({
      agent: 'base2',
      prompt: 'Now also fix the login page',
      previousRun: firstRunResult,
    })

    // Verify the second run's session state includes history from BOTH runs
    expect(secondRunResult.sessionState).toBeDefined()
    const secondHistory =
      secondRunResult.sessionState!.mainAgentState.messageHistory

    // Should have: first user msg + first assistant msg + interruption + second user msg + second assistant msg
    expect(secondHistory.length).toBe(5)

    // The first user message should be present
    const firstUserMsgInSecond = secondHistory.find(
      (m) =>
        m.role === 'user' &&
        m.content.some(
          (c: any) => c.type === 'text' && c.text.includes('Fix the bug'),
        ),
    )
    expect(firstUserMsgInSecond).toBeDefined()

    // The second user message should also be present
    const secondUserMsg = secondHistory.find(
      (m) =>
        m.role === 'user' &&
        m.content.some(
          (c: any) =>
            c.type === 'text' && c.text.includes('fix the login page'),
        ),
    )
    expect(secondUserMsg).toBeDefined()

    // The first assistant message should be preserved
    const firstAssistantMsg = secondHistory.find(
      (m) =>
        m.role === 'assistant' &&
        m.content.some(
          (c: any) =>
            c.type === 'text' && c.text.includes('authentication module'),
        ),
    )
    expect(firstAssistantMsg).toBeDefined()
  })

  it('preserves session state even when abort happens mid-stream', async () => {
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

    const abortController = new AbortController()
    const serverSessionState = getInitialSessionState(
      getStubProjectFileContext(),
    )

    // Simulate multiple tool calls and results (more complex work done)
    serverSessionState.mainAgentState.messageHistory.push(
      userMessage('Fix the bug'),
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will analyze the issue.' },
          {
            type: 'tool-call',
            toolCallId: 'read-1',
            toolName: 'read_files',
            input: { paths: ['src/bug.ts'] },
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
            value: [{ path: 'src/bug.ts', content: 'buggy code' }],
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Found the bug, fixing now.' },
          {
            type: 'tool-call',
            toolCallId: 'write-1',
            toolName: 'write_file',
            input: { path: 'src/bug.ts', content: 'fixed code' },
          } as ToolCallContentBlock,
        ],
      },
      {
        role: 'tool',
        toolCallId: 'write-1',
        toolName: 'write_file',
        content: [
          {
            type: 'json',
            value: { file: 'src/bug.ts', message: 'File written' },
          },
        ],
      },
    )

    const streamedChunks: string[] = []

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId } = params

        // Stream some chunks
        for (const chunk of ['Working', ' on', ' the', ' next', ' step']) {
          await sendAction({
            action: {
              type: 'response-chunk',
              userInputId: promptId,
              chunk,
            },
          })
        }

        // User aborts mid-stream
        abortController.abort()

        // Simulate agent runtime adding interruption message on abort
        serverSessionState.mainAgentState.messageHistory.push(
          userMessage(
            withSystemTags(
              "User interrupted the response. The assistant's previous work has been preserved.",
            ),
          ),
        )

        // Server still returns the full session state
        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState: serverSessionState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState: serverSessionState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    const client = new CodebuffClient({
      apiKey: 'test-key',
    })

    const result = await client.run({
      agent: 'base2',
      prompt: 'test prompt',
      signal: abortController.signal,
      handleStreamChunk: (chunk) => {
        if (typeof chunk === 'string') {
          streamedChunks.push(chunk)
        }
      },
    })

    // Verify session state is preserved with all the work
    expect(result.sessionState).toBeDefined()
    const messageHistory = result.sessionState!.mainAgentState.messageHistory

    // Should have: user message + 4 assistant/tool messages + 1 interruption
    // The server state already has the content; pendingAgentResponse is not duplicated.
    expect(messageHistory.length).toBe(6)

    // Verify the write_file tool result is still there (work was preserved)
    const writeToolResult = messageHistory.find(
      (m) => m.role === 'tool' && m.toolCallId === 'write-1',
    )
    expect(writeToolResult).toBeDefined()

    // Verify interruption message was added at the end
    const lastMessage = messageHistory[messageHistory.length - 1]
    expect(lastMessage.role).toBe('user')
    expect(
      (lastMessage.content[0] as { type: 'text'; text: string }).text,
    ).toContain('User interrupted the response')
  })

  it('does not checkpoint a tool call whose result was interrupted', async () => {
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      name: null,
      discord_id: null,
      stripe_customer_id: null,
      banned: false,
      created_at: new Date('2024-01-01T00:00:00Z'),
    })

    const intervals: Array<() => void> = []
    spyOn(globalThis, 'setInterval').mockImplementation(((run: () => void) => {
      intervals.push(run)
      return { unref: () => {} }
    }) as never)

    const snapshots: RunState[] = []
    let runtimeCalls = 0
    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        runtimeCalls++
        if (runtimeCalls > 1) {
          const resumedHistory =
            params.action.sessionState.mainAgentState.messageHistory
          const hasInterruptedCall = resumedHistory.some(
            (message) =>
              message.role === 'assistant' &&
              message.content.some(
                (part) =>
                  part.type === 'tool-call' &&
                  part.toolCallId === 'interrupted-call',
              ),
          )
          if (hasInterruptedCall) {
            throw new Error(
              'Tool result is missing for tool call interrupted-call',
            )
          }

          await params.sendAction({
            action: {
              type: 'prompt-response',
              promptId: params.promptId,
              sessionState: params.action.sessionState,
              output: { type: 'lastMessage', value: [] },
            },
          })
          return {
            sessionState: params.action.sessionState,
            output: { type: 'lastMessage' as const, value: [] },
          }
        }

        params.action.sessionState.mainAgentState.messageHistory = [
          userMessage('Fix the bug'),
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'finished-call',
                toolName: 'read_files',
                input: { paths: ['src/bug.ts'] },
              },
            ],
          },
          {
            role: 'tool',
            toolCallId: 'finished-call',
            toolName: 'read_files',
            content: [{ type: 'json', value: { files: [] } }],
          },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Applying the fix now.' },
              {
                type: 'tool-call',
                toolCallId: 'interrupted-call',
                toolName: 'write_file',
                input: { path: 'src/bug.ts', content: 'fixed' },
              },
            ],
          },
        ]
        intervals.at(-1)!()
        throw new Error('Tool result is missing for tool call interrupted-call')
      },
    )

    const client = new CodebuffClient({ apiKey: 'test-key' })
    await client.run({
      agent: 'base2',
      prompt: 'Fix the bug',
      onStateSnapshot: (snapshot) => snapshots.push(snapshot),
    })
    const checkpoint = snapshots.at(-1)!
    const history = checkpoint.sessionState!.mainAgentState.messageHistory
    const toolCallIds = history.flatMap((message) =>
      message.role === 'assistant'
        ? message.content.flatMap((part) =>
            part.type === 'tool-call' ? [part.toolCallId] : [],
          )
        : [],
    )

    expect(toolCallIds).toEqual(['finished-call'])
    expect(
      history.some(
        (message) =>
          message.role === 'tool' && message.toolCallId === 'finished-call',
      ),
    ).toBe(true)
    expect(
      history.some(
        (message) =>
          message.role === 'assistant' &&
          message.content.some(
            (part) =>
              part.type === 'text' && part.text === 'Applying the fix now.',
          ),
      ),
    ).toBe(true)

    const resumed = await client.run({
      agent: 'base2',
      prompt: 'Continue',
      previousRun: checkpoint,
    })
    expect(resumed.output.type).toBe('lastMessage')
  })
})
