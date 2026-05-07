import { describe, test, expect, beforeEach } from 'bun:test'

import contextPruner from '../context-pruner'

import type { AgentState } from '../types/agent-definition'
import type { JSONValue, Message, ToolMessage } from '../types/util-types'

// Helper to create a minimal mock AgentState for testing
function createMockAgentState(
  messageHistory: Message[],
  contextTokenCount: number,
): AgentState {
  return {
    agentId: 'test-agent',
    runId: 'test-run',
    parentId: undefined,
    messageHistory,
    output: undefined,
    systemPrompt: '',
    toolDefinitions: {},
    contextTokenCount,
  }
}

/**
 * Regression test: Verify handleSteps can be serialized and run in isolation.
 * This catches bugs like CACHE_EXPIRY_MS not being defined when the function
 * is stringified and executed in a QuickJS sandbox.
 *
 * The handleSteps function is serialized to a string and executed in a sandbox
 * at runtime. Any variables referenced from outside the function scope will
 * cause "X is not defined" errors. This test ensures all constants and helper
 * functions are defined inside handleSteps.
 */
describe('context-pruner handleSteps serialization', () => {
  test('handleSteps works when serialized and executed in isolation (regression test for external variable references)', () => {
    // Get the handleSteps function and convert it to a string, just like the SDK does
    const handleStepsString = contextPruner.handleSteps!.toString()

    // Verify it's a valid generator function string
    expect(handleStepsString).toMatch(/^function\*\s*\(/)

    // Create a new function from the string to simulate sandbox isolation.
    // This will fail if handleSteps references any external variables
    // (like CACHE_EXPIRY_MS was before the fix).
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const isolatedFunction = new Function(`return (${handleStepsString})`)()

    // Create minimal mock data to run the function
    const mockAgentState = createMockAgentState(
      [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hello' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi there!' }],
        },
      ],
      100, // Under the limit, so it won't prune
    )

    const mockLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }

    // Run the isolated function - this will throw if any external variables are undefined
    const generator = isolatedFunction({
      agentState: mockAgentState,
      logger: mockLogger,
      params: { maxContextLength: 200000 },
    })

    // Consume the generator to ensure all code paths execute
    const results: unknown[] = []
    let result = generator.next()
    while (!result.done) {
      results.push(result.value)
      result = generator.next()
    }

    // Should have produced a result (set_messages call)
    expect(results.length).toBeGreaterThan(0)
  })

  test('handleSteps works in isolation when pruning is triggered', () => {
    // Get the handleSteps function and convert it to a string
    const handleStepsString = contextPruner.handleSteps!.toString()

    // Create a new function from the string to simulate sandbox isolation
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const isolatedFunction = new Function(`return (${handleStepsString})`)()

    // Create mock data that will trigger pruning (context over limit)
    const mockAgentState = createMockAgentState(
      [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Please help me with a task' }],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Sure, I can help with that' },
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'read_files',
              input: { paths: ['test.ts'] },
            },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'call-1',
          toolName: 'read_files',
          content: [{ type: 'json', value: { content: 'file content' } }],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Thanks!' }],
        },
      ],
      250000, // Over the limit, will trigger pruning
    )

    const mockLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }

    // Run the isolated function - exercises all the helper functions like
    // truncateLongText, estimateTokens, getTextContent, summarizeToolCall
    const generator = isolatedFunction({
      agentState: mockAgentState,
      logger: mockLogger,
      params: { maxContextLength: 200000 },
    })

    // Consume the generator
    const results: any[] = []
    let result = generator.next()
    while (!result.done) {
      results.push(result.value)
      result = generator.next()
    }

    // Should have produced a result
    expect(results.length).toBeGreaterThan(0)

    // The result should contain a summary
    const setMessagesCall = results[0]
    expect(setMessagesCall.toolName).toBe('set_messages')
    expect(setMessagesCall.input.messages[0].content[0].text).toContain(
      '<conversation_summary>',
    )
  })
})

const createMessage = (
  role: 'user' | 'assistant',
  content: string,
): Message => ({
  role,
  content: [
    {
      type: 'text',
      text: content,
    },
  ],
})

const createToolCallMessage = (
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
): Message => ({
  role: 'assistant',
  content: [
    {
      type: 'tool-call',
      toolCallId,
      toolName,
      input,
    },
  ],
})

const createToolResultMessage = (
  toolCallId: string,
  toolName: string,
  value: JSONValue,
): ToolMessage => ({
  role: 'tool',
  toolCallId,
  toolName,
  content: [
    {
      type: 'json',
      value,
    },
  ],
})

describe('context-pruner handleSteps', () => {
  let mockAgentState: AgentState

  beforeEach(() => {
    mockAgentState = createMockAgentState([], 0)
  })

  const runHandleSteps = (
    messages: Message[],
    contextTokenCount?: number,
    maxContextLength?: number,
    budgets?: { assistantToolBudget?: number; userBudget?: number },
  ) => {
    mockAgentState.messageHistory = messages
    // If contextTokenCount not provided, estimate from messages
    mockAgentState.contextTokenCount =
      contextTokenCount ?? Math.ceil(JSON.stringify(messages).length / 3)
    const mockLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }
    const generator = contextPruner.handleSteps!({
      agentState: mockAgentState,
      logger: mockLogger,
      params: {
        ...(maxContextLength ? { maxContextLength } : {}),
        ...budgets,
      },
    })
    const results: any[] = []
    let result = generator.next()
    while (!result.done) {
      if (typeof result.value === 'object') {
        results.push(result.value)
      }
      result = generator.next()
    }
    return results
  }

  test('does nothing when context is under max limit', () => {
    const messages = [
      createMessage('user', 'Hello'),
      createMessage('assistant', 'Hi there!'),
    ]

    // Context under max limit - should not trigger pruning
    const results = runHandleSteps(messages, 199000, 200000)

    expect(results).toHaveLength(1)
    expect(results[0]).toEqual(
      expect.objectContaining({
        toolName: 'set_messages',
        input: {
          messages,
        },
      }),
    )
  })

  test('summarizes conversation when context exceeds max limit', () => {
    const messages = [
      createMessage('user', 'Please help me with this task'),
      createMessage('assistant', 'Sure, I can help you with that'),
      createMessage('user', 'Thanks for your help'),
    ]

    // Set contextTokenCount higher than max limit to trigger pruning
    const results = runHandleSteps(messages, 210000, 200000)

    expect(results).toHaveLength(1)
    const resultMessages = results[0].input.messages

    // Should have a single summarized message
    expect(resultMessages).toHaveLength(1)
    expect(resultMessages[0].role).toBe('user')

    // Should be wrapped in conversation_summary tags
    const content = resultMessages[0].content[0].text
    expect(content).toContain('<conversation_summary>')
    expect(content).toContain('</conversation_summary>')

    // Should use a memory artifact format, not transcript role markers
    expect(content).toContain('<historical_memory>')
    expect(content).toContain('[USER]')
    expect(content).toContain('Progress note:')
    expect(content).not.toContain('[ASSISTANT]')
  })

  test('includes tool call summaries in the output', () => {
    const messages = [
      createMessage('user', 'Read these files'),
      createToolCallMessage('call-1', 'read_files', {
        paths: ['file1.ts', 'file2.ts'],
      }),
      createToolResultMessage('call-1', 'read_files', {
        content: 'file data',
      } as JSONValue),
      createMessage('user', 'Now edit this file'),
      createToolCallMessage('call-2', 'str_replace', {
        path: 'file1.ts',
        replacements: [],
      }),
      createToolResultMessage('call-2', 'str_replace', { success: true }),
    ]

    const results = runHandleSteps(messages, 50000, 10000)
    const content = results[0].input.messages[0].content[0].text

    // Should contain tool summaries
    expect(content).toContain('inspected files: file1.ts, file2.ts')
    expect(content).toContain('edited file: file1.ts')
  })

  test('includes inspected path for single read calls', () => {
    const messages = [
      createMessage('user', 'Read one file'),
      createToolCallMessage('call-1', 'read', {
        path: 'src/index.ts',
        offset: 25,
        limit: 50,
      }),
      createToolResultMessage('call-1', 'read', {
        path: 'src/index.ts',
        content: 'file data',
      }),
    ]

    const results = runHandleSteps(messages, 50000, 10000)
    const content = results[0].input.messages[0].content[0].text

    expect(content).toContain('inspected file: src/index.ts')
    expect(content).not.toContain('used tool read')
  })

  test('summarizes various tool types correctly', () => {
    const messages = [
      createMessage('user', 'Do various tasks'),
      createToolCallMessage('call-1', 'write_file', {
        path: 'new-file.ts',
        content: 'code',
      }),
      createToolResultMessage('call-1', 'write_file', { success: true }),
      createToolCallMessage('call-2', 'run_terminal_command', {
        command: 'npm test',
      }),
      createToolResultMessage('call-2', 'run_terminal_command', {
        stdout: 'pass',
      }),
      createToolCallMessage('call-3', 'code_search', { pattern: 'function' }),
      createToolResultMessage('call-3', 'code_search', { results: [] }),
      createToolCallMessage('call-4', 'spawn_agents', {
        agents: [{ agent_type: 'file-picker' }, { agent_type: 'commander' }],
      }),
      createToolResultMessage('call-4', 'spawn_agents', { success: true }),
    ]

    const results = runHandleSteps(messages, 50000, 10000)
    const content = results[0].input.messages[0].content[0].text

    expect(content).toContain('wrote file: new-file.ts')
    expect(content).toContain('ran command: npm test')
    expect(content).toContain('code search for "function"')
    expect(content).toContain('delegated agents:')
    expect(content).toContain('- file-picker')
    expect(content).toContain('- commander')
  })

  test('includes tool errors in summary', () => {
    const messages = [
      createMessage('user', 'Try to read a file'),
      createToolCallMessage('call-1', 'read_files', { paths: ['missing.ts'] }),
      createToolResultMessage('call-1', 'read_files', {
        errorMessage: 'File not found',
      }),
    ]

    const results = runHandleSteps(messages, 50000, 10000)
    const content = results[0].input.messages[0].content[0].text

    expect(content).toContain('Tool error from read_files: File not found')
  })

  test('notes when user messages have images', () => {
    const messageWithImage: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'Look at this image' },
        { type: 'image', image: 'base64data', mediaType: 'image/png' },
      ],
    }

    const messages = [messageWithImage, createMessage('assistant', 'I see it')]

    const results = runHandleSteps(messages, 50000, 10000)
    const content = results[0].input.messages[0].content[0].text

    expect(content).toContain('[USER] [image(s) were attached]')
  })

  test('removes only INSTRUCTIONS_PROMPT and SUBAGENT_SPAWN when under context limit', () => {
    const messages: Message[] = [
      createMessage('user', 'Hello'),
      {
        role: 'user',
        content: [{ type: 'text', text: 'Instructions prompt' }],
        tags: ['INSTRUCTIONS_PROMPT'],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Spawning...' }],
        tags: ['SUBAGENT_SPAWN'],
      },
      createMessage('assistant', 'Response'),
    ]

    // Under threshold - should remove INSTRUCTIONS_PROMPT and SUBAGENT_SPAWN only
    const results = runHandleSteps(messages, 100, 200000)
    const resultMessages = results[0].input.messages

    // Should have removed the context-pruner specific tags but kept everything else
    expect(resultMessages).toHaveLength(2)
    expect(resultMessages[0]).toEqual(messages[0]) // 'Hello' message
    expect(resultMessages[1]).toEqual(messages[3]) // 'Response' message
  })

  test('removes INSTRUCTIONS_PROMPT and SUBAGENT_SPAWN when summarizing', () => {
    const messages: Message[] = [
      createMessage('user', 'Hello'),
      {
        role: 'user',
        content: [{ type: 'text', text: 'Instructions prompt' }],
        tags: ['INSTRUCTIONS_PROMPT'],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Spawning...' }],
        tags: ['SUBAGENT_SPAWN'],
      },
      createMessage('user', 'Follow up'),
    ]

    // Over threshold - should summarize and exclude tagged messages
    const results = runHandleSteps(messages, 250000, 200000)
    const resultMessages = results[0].input.messages

    // Should have summarized to single message (no remaining INSTRUCTIONS_PROMPT after step 0 removal)
    expect(resultMessages).toHaveLength(1)
    const content = (resultMessages[0].content[0] as { text: string }).text

    // Should NOT contain the tagged message content in summary
    expect(content).not.toContain('Instructions prompt')
    expect(content).not.toContain('Spawning...')

    // Should contain the non-tagged messages
    expect(content).toContain('Hello')
    expect(content).toContain('Follow up')
  })

  test('preserves last remaining INSTRUCTIONS_PROMPT as second message when summarizing', () => {
    const messages: Message[] = [
      createMessage('user', 'Hello'),
      {
        role: 'user',
        content: [{ type: 'text', text: 'Parent agent instructions' }],
        tags: ['INSTRUCTIONS_PROMPT'],
      },
      createMessage('assistant', 'Working on it'),
      {
        role: 'user',
        content: [{ type: 'text', text: 'Context pruner instructions' }],
        tags: ['INSTRUCTIONS_PROMPT'],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Spawning context pruner' }],
        tags: ['SUBAGENT_SPAWN'],
      },
    ]

    // Over threshold - should summarize
    const results = runHandleSteps(messages, 250000, 200000)
    const resultMessages = results[0].input.messages

    // Should have 2 messages: summary + the parent agent's INSTRUCTIONS_PROMPT
    expect(resultMessages).toHaveLength(2)

    // First message should be the summary
    const summaryContent = (resultMessages[0].content[0] as { text: string })
      .text
    expect(summaryContent).toContain('<conversation_summary>')
    expect(summaryContent).toContain('Hello')
    expect(summaryContent).toContain('Working on it')
    // Should NOT contain any instructions prompt content in summary
    expect(summaryContent).not.toContain('Parent agent instructions')
    expect(summaryContent).not.toContain('Context pruner instructions')

    // Second message should be the parent agent's INSTRUCTIONS_PROMPT (the first one, after last one was removed)
    const secondMessage = resultMessages[1]
    expect(secondMessage.tags).toContain('INSTRUCTIONS_PROMPT')
    const instructionsContent = (secondMessage.content[0] as { text: string })
      .text
    expect(instructionsContent).toBe('Parent agent instructions')
  })

  test('preserves tagged live user prompt as a real message after summary', () => {
    const liveUserPrompt: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'LATEST LIVE REQUEST' }],
      tags: ['USER_PROMPT'],
    }
    const instructionsPrompt: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'Parent instructions' }],
      tags: ['INSTRUCTIONS_PROMPT'],
    }
    const prunerParamsPrompt: Message = {
      role: 'user',
      content: [{ type: 'text', text: '{"maxContextLength":200000}' }],
      tags: ['USER_PROMPT'],
    }
    const messages: Message[] = [
      createMessage('user', 'Older request'),
      createMessage('assistant', 'Older answer'),
      liveUserPrompt,
      instructionsPrompt,
      prunerParamsPrompt,
    ]

    const results = runHandleSteps(messages, 250000, 200000)
    const resultMessages = results[0].input.messages

    expect(resultMessages).toHaveLength(2)
    const summaryContent = (resultMessages[0].content[0] as { text: string })
      .text
    expect(summaryContent).toContain('Older request')
    expect(summaryContent).not.toContain('LATEST LIVE REQUEST')
    expect(resultMessages[1]).toEqual(
      expect.objectContaining({
        role: 'user',
        tags: ['USER_PROMPT'],
      }),
    )
    expect((resultMessages[1].content[0] as { text: string }).text).toBe(
      'LATEST LIVE REQUEST',
    )
  })

  test('keeps live user prompt in memory and adds continuation prompt when pruning mid-turn', () => {
    const liveUserPrompt: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'PLEASE FIX THE BUG' }],
      tags: ['USER_PROMPT'],
    }
    const prunerParamsPrompt: Message = {
      role: 'user',
      content: [{ type: 'text', text: '{"maxContextLength":200000}' }],
      tags: ['USER_PROMPT'],
    }
    const messages: Message[] = [
      liveUserPrompt,
      createMessage('assistant', 'I found the likely issue.'),
      createToolCallMessage('call-1', 'read_files', {
        paths: ['src/bug.ts'],
      }),
      createToolResultMessage('call-1', 'read_files', {
        content: 'buggy code',
      }),
      prunerParamsPrompt,
    ]

    const results = runHandleSteps(messages, 250000, 200000)
    const resultMessages = results[0].input.messages

    expect(resultMessages).toHaveLength(2)
    const summaryContent = (resultMessages[0].content[0] as { text: string })
      .text
    expect(summaryContent).toContain('PLEASE FIX THE BUG')
    expect(summaryContent).toContain('I found the likely issue.')
    expect(summaryContent).toContain('inspected files: src/bug.ts')

    expect(resultMessages[1].role).toBe('user')
    expect(resultMessages[1].tags).toBeUndefined()
    const continuationText = (resultMessages[1].content[0] as { text: string })
      .text
    expect(continuationText).toContain('Continue the existing assistant turn')
    expect(continuationText).toContain('Do not restart completed work')
  })

  test('handles empty message history', () => {
    const messages: Message[] = []

    const results = runHandleSteps(messages, 0, 200000)

    expect(results).toHaveLength(1)
    expect(results[0].input.messages).toEqual([])
  })

  test('preserves all user message content in summary', () => {
    const messages = [
      createMessage('user', 'First user request with important details'),
      createMessage('assistant', 'First response'),
      createMessage('user', 'Second user request'),
      createMessage('assistant', 'Second response'),
      createMessage('user', 'Third user request'),
    ]

    const results = runHandleSteps(messages, 50000, 10000)
    const content = results[0].input.messages[0].content[0].text

    // All user messages should be in the summary
    expect(content).toContain('First user request with important details')
    expect(content).toContain('Second user request')
    expect(content).toContain('Third user request')
  })

  test('preserves assistant text content in summary', () => {
    const messages = [
      createMessage('user', 'Question'),
      createMessage('assistant', 'Here is my detailed answer to your question'),
    ]

    const results = runHandleSteps(messages, 50000, 10000)
    const content = results[0].input.messages[0].content[0].text

    expect(content).toContain('Here is my detailed answer to your question')
  })

  test('handles write_todos tool with completion status and remaining tasks', () => {
    const messages = [
      createMessage('user', 'Create a plan'),
      createToolCallMessage('call-1', 'write_todos', {
        todos: [
          { task: 'Task 1', completed: true },
          { task: 'Task 2', completed: true },
          { task: 'Task 3 - still to do', completed: false },
          { task: 'Task 4 - also remaining', completed: false },
        ],
      }),
      createToolResultMessage('call-1', 'write_todos', { success: true }),
    ]

    const results = runHandleSteps(messages, 250000, 200000)
    const content = results[0].input.messages[0].content[0].text

    // Should show completed count and list remaining tasks
    expect(content).toContain('Todos: 2/4 complete')
    expect(content).toContain('- Task 3 - still to do')
    expect(content).toContain('- Task 4 - also remaining')
  })

  test('handles spawn_agent_inline tool', () => {
    const messages = [
      createMessage('user', 'Spawn an agent'),
      createToolCallMessage('call-1', 'spawn_agent_inline', {
        agent_type: 'file-picker',
      }),
      createToolResultMessage('call-1', 'spawn_agent_inline', { output: {} }),
    ]

    const results = runHandleSteps(messages, 50000, 10000)
    const content = results[0].input.messages[0].content[0].text

    expect(content).toContain('delegated agent file-picker')
  })

  test('handles long terminal commands by truncating', () => {
    const longCommand =
      'npm run build -- --config=production --verbose --output=/very/long/path/to/output/directory'
    const messages = [
      createMessage('user', 'Run build'),
      createToolCallMessage('call-1', 'run_terminal_command', {
        command: longCommand,
      }),
      createToolResultMessage('call-1', 'run_terminal_command', { stdout: '' }),
    ]

    const results = runHandleSteps(messages, 50000, 10000)
    const content = results[0].input.messages[0].content[0].text

    // Should truncate to 50 chars + ...
    expect(content).toContain(
      'ran command: npm run build -- --config=production --verbose --o...',
    )
  })

  test('handles unknown tools gracefully', () => {
    const messages = [
      createMessage('user', 'Use some tool'),
      createToolCallMessage('call-1', 'unknown_tool_name', { param: 'value' }),
      createToolResultMessage('call-1', 'unknown_tool_name', { result: 'ok' }),
    ]

    const results = runHandleSteps(messages, 50000, 10000)
    const content = results[0].input.messages[0].content[0].text

    expect(content).toContain('used tool unknown_tool_name')
  })

  test('handles multiple tool calls in single assistant message', () => {
    const multiToolMessage: Message = {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'read_files',
          input: { paths: ['a.ts'] },
        },
        {
          type: 'tool-call',
          toolCallId: 'call-2',
          toolName: 'read_files',
          input: { paths: ['b.ts'] },
        },
      ],
    }

    const messages = [
      createMessage('user', 'Read files'),
      multiToolMessage,
      createToolResultMessage('call-1', 'read_files', { content: 'a' }),
      createToolResultMessage('call-2', 'read_files', { content: 'b' }),
    ]

    const results = runHandleSteps(messages, 50000, 10000)
    const content = results[0].input.messages[0].content[0].text

    // Both tool calls should be in the summary
    expect(content).toContain('inspected files: a.ts')
    expect(content).toContain('inspected files: b.ts')
  })

  test('handles mixed text and tool calls in assistant message', () => {
    const mixedMessage: Message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me read that file for you' },
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'read_files',
          input: { paths: ['test.ts'] },
        },
      ],
    }

    const messages = [
      createMessage('user', 'Read test.ts'),
      mixedMessage,
      createToolResultMessage('call-1', 'read_files', { content: 'data' }),
    ]

    const results = runHandleSteps(messages, 50000, 10000)
    const content = results[0].input.messages[0].content[0].text

    // Should have both text and tool summary
    expect(content).toContain('Let me read that file for you')
    expect(content).toContain('inspected files: test.ts')
  })
})

describe('context-pruner long message truncation', () => {
  let mockAgentState: AgentState

  beforeEach(() => {
    mockAgentState = createMockAgentState([], 0)
  })

  const runHandleSteps = (
    messages: Message[],
    contextTokenCount: number,
    maxContextLength: number,
    budgets?: { assistantToolBudget?: number; userBudget?: number },
  ) => {
    mockAgentState.messageHistory = messages
    mockAgentState.contextTokenCount = contextTokenCount
    const mockLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }
    const generator = contextPruner.handleSteps!({
      agentState: mockAgentState,
      logger: mockLogger,
      params: { maxContextLength, ...budgets },
    })
    const results: any[] = []
    let result = generator.next()
    while (!result.done) {
      if (typeof result.value === 'object') {
        results.push(result.value)
      }
      result = generator.next()
    }
    return results
  }

  test('truncates very long user messages with 80-20 ratio', () => {
    // Create a message that exceeds the user message token limit (~13k tokens = ~39k chars)
    const longText = 'A'.repeat(45000)
    const messages = [
      createMessage('user', longText),
      createMessage('assistant', 'Got it'),
    ]

    const results = runHandleSteps(messages, 250000, 200000)
    const content = results[0].input.messages[0].content[0].text

    // Should contain truncation notice
    expect(content).toContain('[...truncated')
    expect(content).toContain('chars...]')

    // Should have beginning (80%) and end (20%) of the message
    // The beginning should have lots of A's
    expect(content).toContain('AAAAAAAAAA')
  })

  test('truncates very long assistant messages with 80-20 ratio', () => {
    // Create an assistant message that exceeds 5k chars
    const longResponse = 'B'.repeat(8000)
    const messages = [
      createMessage('user', 'Give me a long response'),
      createMessage('assistant', longResponse),
    ]

    const results = runHandleSteps(messages, 250000, 200000)
    const content = results[0].input.messages[0].content[0].text

    // Should contain truncation notice
    expect(content).toContain('[...truncated')
    expect(content).toContain('chars...]')

    // Should have B's from beginning and end
    expect(content).toContain('BBBBBBBBBB')
  })

  test('does not truncate messages under the limit', () => {
    const shortText = 'Short message under 20k chars'
    const messages = [
      createMessage('user', shortText),
      createMessage('assistant', 'Short response under 5k chars'),
    ]

    const results = runHandleSteps(messages, 250000, 200000)
    const content = results[0].input.messages[0].content[0].text

    // Should NOT contain truncation notice
    expect(content).not.toContain('[...truncated')

    // Should contain the full messages
    expect(content).toContain(shortText)
    expect(content).toContain('Short response under 5k chars')
  })
})

describe('context-pruner code_search with flags', () => {
  let mockAgentState: AgentState

  beforeEach(() => {
    mockAgentState = createMockAgentState([], 0)
  })

  const runHandleSteps = (messages: Message[]) => {
    mockAgentState.messageHistory = messages
    mockAgentState.contextTokenCount = 250000
    const mockLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }
    const generator = contextPruner.handleSteps!({
      agentState: mockAgentState,
      logger: mockLogger,
      params: { maxContextLength: 200000 },
    })
    const results: any[] = []
    let result = generator.next()
    while (!result.done) {
      if (typeof result.value === 'object') {
        results.push(result.value)
      }
      result = generator.next()
    }
    return results
  }

  test('includes flags in code_search summary', () => {
    const messages = [
      createMessage('user', 'Search for something'),
      createToolCallMessage('call-1', 'code_search', {
        pattern: 'myFunction',
        flags: '-g *.ts -i',
      }),
      createToolResultMessage('call-1', 'code_search', { results: [] }),
    ]

    const results = runHandleSteps(messages)
    const content = results[0].input.messages[0].content[0].text

    expect(content).toContain(
      'code search for "myFunction" (-g *.ts -i)',
    )
  })
})

describe('context-pruner ask_user with questions and answers', () => {
  let mockAgentState: AgentState

  beforeEach(() => {
    mockAgentState = createMockAgentState([], 0)
  })

  const runHandleSteps = (messages: Message[]) => {
    mockAgentState.messageHistory = messages
    mockAgentState.contextTokenCount = 250000
    const mockLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }
    const generator = contextPruner.handleSteps!({
      agentState: mockAgentState,
      logger: mockLogger,
      params: { maxContextLength: 200000 },
    })
    const results: any[] = []
    let result = generator.next()
    while (!result.done) {
      if (typeof result.value === 'object') {
        results.push(result.value)
      }
      result = generator.next()
    }
    return results
  }

  test('includes question text in ask_user summary', () => {
    const messages = [
      createMessage('user', 'Help me choose'),
      createToolCallMessage('call-1', 'ask_user', {
        questions: [
          {
            question: 'Which database should we use?',
            options: [{ label: 'PostgreSQL' }, { label: 'MySQL' }],
          },
        ],
      }),
      createToolResultMessage('call-1', 'ask_user', {
        answers: [{ selectedOption: 'PostgreSQL' }],
      }),
    ]

    const results = runHandleSteps(messages)
    const content = results[0].input.messages[0].content[0].text

    expect(content).toContain('Asked user: Which database should we use?')
  })

  test('includes user answer in summary', () => {
    const messages = [
      createMessage('user', 'Help me choose'),
      createToolCallMessage('call-1', 'ask_user', {
        questions: [
          { question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] },
        ],
      }),
      createToolResultMessage('call-1', 'ask_user', {
        answers: [{ selectedOption: 'Option B was selected' }],
      }),
    ]

    const results = runHandleSteps(messages)
    const content = results[0].input.messages[0].content[0].text

    expect(content).toContain('User answered: Option B was selected')
  })

  test('includes multi-select answers', () => {
    const messages = [
      createMessage('user', 'Pick features'),
      createToolCallMessage('call-1', 'ask_user', {
        questions: [
          { question: 'Select features', options: [], multiSelect: true },
        ],
      }),
      createToolResultMessage('call-1', 'ask_user', {
        answers: [{ selectedOptions: ['Caching', 'Logging', 'Monitoring'] }],
      }),
    ]

    const results = runHandleSteps(messages)
    const content = results[0].input.messages[0].content[0].text

    expect(content).toContain('User answered: Caching, Logging, Monitoring')
  })

  test('shows when user skipped question', () => {
    const messages = [
      createMessage('user', 'Ask me something'),
      createToolCallMessage('call-1', 'ask_user', {
        questions: [{ question: 'Pick one', options: [] }],
      }),
      createToolResultMessage('call-1', 'ask_user', {
        skipped: true,
      }),
    ]

    const results = runHandleSteps(messages)
    const content = results[0].input.messages[0].content[0].text

    expect(content).toContain('User skipped question')
  })
})

describe('context-pruner terminal command exit codes', () => {
  let mockAgentState: AgentState

  beforeEach(() => {
    mockAgentState = createMockAgentState([], 0)
  })

  const runHandleSteps = (messages: Message[]) => {
    mockAgentState.messageHistory = messages
    mockAgentState.contextTokenCount = 250000
    const mockLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }
    const generator = contextPruner.handleSteps!({
      agentState: mockAgentState,
      logger: mockLogger,
      params: { maxContextLength: 200000 },
    })
    const results: any[] = []
    let result = generator.next()
    while (!result.done) {
      if (typeof result.value === 'object') {
        results.push(result.value)
      }
      result = generator.next()
    }
    return results
  }

  test('shows failed command with exit code', () => {
    const messages = [
      createMessage('user', 'Run tests'),
      createToolCallMessage('call-1', 'run_terminal_command', {
        command: 'npm test',
      }),
      createToolResultMessage('call-1', 'run_terminal_command', {
        stdout: 'Tests failed',
        exitCode: 1,
      }),
    ]

    const results = runHandleSteps(messages)
    const content = results[0].input.messages[0].content[0].text

    expect(content).toContain('Command failed with exit code: 1')
  })

  test('does not show failure for successful command (exit code 0)', () => {
    const messages = [
      createMessage('user', 'Run tests'),
      createToolCallMessage('call-1', 'run_terminal_command', {
        command: 'npm test',
      }),
      createToolResultMessage('call-1', 'run_terminal_command', {
        stdout: 'All tests passed',
        exitCode: 0,
      }),
    ]

    const results = runHandleSteps(messages)
    const content = results[0].input.messages[0].content[0].text

    expect(content).not.toContain('Command failed with exit code')
  })
})

describe('context-pruner spawn_agents with prompt and params', () => {
  let mockAgentState: AgentState

  beforeEach(() => {
    mockAgentState = createMockAgentState([], 0)
  })

  const runHandleSteps = (messages: Message[]) => {
    mockAgentState.messageHistory = messages
    mockAgentState.contextTokenCount = 250000
    const mockLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }
    const generator = contextPruner.handleSteps!({
      agentState: mockAgentState,
      logger: mockLogger,
      params: { maxContextLength: 200000 },
    })
    const results: any[] = []
    let result = generator.next()
    while (!result.done) {
      if (typeof result.value === 'object') {
        results.push(result.value)
      }
      result = generator.next()
    }
    return results
  }

  test('includes prompt in spawn_agents summary', () => {
    const messages = [
      createMessage('user', 'Find files'),
      createToolCallMessage('call-1', 'spawn_agents', {
        agents: [
          {
            agent_type: 'file-picker',
            prompt: 'Find all TypeScript files related to authentication',
          },
        ],
      }),
      createToolResultMessage('call-1', 'spawn_agents', { success: true }),
    ]

    const results = runHandleSteps(messages)
    const content = results[0].input.messages[0].content[0].text

    expect(content).toContain('file-picker')
    expect(content).toContain(
      'prompt: "Find all TypeScript files related to authentication"',
    )
  })

  test('includes params in spawn_agents summary', () => {
    const messages = [
      createMessage('user', 'Run a command'),
      createToolCallMessage('call-1', 'spawn_agents', {
        agents: [
          {
            agent_type: 'commander',
            params: { command: 'npm test' },
          },
        ],
      }),
      createToolResultMessage('call-1', 'spawn_agents', { success: true }),
    ]

    const results = runHandleSteps(messages)
    const content = results[0].input.messages[0].content[0].text

    expect(content).toContain('commander')
    expect(content).toContain('params: {"command":"npm test"}')
  })

  test('truncates very long prompts (over 1000 chars)', () => {
    const longPrompt = 'X'.repeat(1500)
    const messages = [
      createMessage('user', 'Do something'),
      createToolCallMessage('call-1', 'spawn_agent_inline', {
        agent_type: 'thinker',
        prompt: longPrompt,
      }),
      createToolResultMessage('call-1', 'spawn_agent_inline', { output: {} }),
    ]

    const results = runHandleSteps(messages)
    const content = results[0].input.messages[0].content[0].text

    // Should be truncated to 1000 chars + ...
    expect(content).toContain('...')
    expect(content).not.toContain(longPrompt) // Full prompt should not be there
  })
})

describe('context-pruner repeated compaction', () => {
  let mockAgentState: AgentState

  beforeEach(() => {
    mockAgentState = createMockAgentState([], 0)
  })

  const runHandleSteps = (
    messages: Message[],
    contextTokenCount: number,
    maxContextLength: number,
    budgets?: { assistantToolBudget?: number; userBudget?: number },
  ) => {
    mockAgentState.messageHistory = messages
    mockAgentState.contextTokenCount = contextTokenCount
    const mockLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }
    const generator = contextPruner.handleSteps!({
      agentState: mockAgentState,
      logger: mockLogger,
      params: { maxContextLength, ...budgets },
    })
    const results: any[] = []
    let result = generator.next()
    while (!result.done) {
      if (typeof result.value === 'object') {
        results.push(result.value)
      }
      result = generator.next()
    }
    return results
  }

  test('extracts and preserves content from previous summary', () => {
    // Simulate a conversation that was already summarized once
    const previousSummaryMessage: Message = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `<conversation_summary>
This is a summary of the conversation so far. The original messages have been condensed to save context space.

[USER]
First user request from earlier

---

[ASSISTANT]
First assistant response
</conversation_summary>`,
        },
      ],
    }

    const messages = [
      previousSummaryMessage,
      createMessage('user', 'New user message after summary'),
      createMessage('assistant', 'New assistant response'),
    ]

    const results = runHandleSteps(messages, 250000, 200000)
    const content = results[0].input.messages[0].content[0].text

    // Should contain the previous summary content (appended seamlessly)
    expect(content).toContain('First user request from earlier')
    expect(content).toContain('First assistant response')

    // Should also contain the new messages
    expect(content).toContain('New user message after summary')
    expect(content).toContain('New assistant response')
  })

  test('filters out old summary messages when building new summary', () => {
    const previousSummaryMessage: Message = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<conversation_summary>\nOld summary content\n</conversation_summary>',
        },
      ],
    }

    const messages = [
      previousSummaryMessage,
      createMessage('user', 'After summary message'),
    ]

    const results = runHandleSteps(messages, 250000, 200000)
    const content = results[0].input.messages[0].content[0].text

    // Should only have ONE conversation_summary tag (the new one)
    const summaryTagCount = (content.match(/<conversation_summary>/g) || [])
      .length
    expect(summaryTagCount).toBe(1)
  })

  test('drops old entries each cycle when budgets are tight', () => {
    const simulateCompaction = (
      inputMessages: Message[],
      budgets: { assistantToolBudget: number; userBudget: number },
    ): Message => {
      const result = runHandleSteps(inputMessages, 250000, 200000, budgets)
      return result[0].input.messages[0]
    }

    const tightBudgets = { assistantToolBudget: 25, userBudget: 25 }

    // === CYCLE 1: 3 pairs of messages, tight budgets drop the oldest ===
    const cycle1Messages = [
      createMessage('user', 'Cycle1-Request-A'),
      createMessage('assistant', 'Cycle1-Response-A'),
      createMessage('user', 'Cycle1-Request-B'),
      createMessage('assistant', 'Cycle1-Response-B'),
      createMessage('user', 'Cycle1-Request-C'),
      createMessage('assistant', 'Cycle1-Response-C'),
    ]
    const summary1 = simulateCompaction(cycle1Messages, tightBudgets)
    const summary1Text = (summary1.content[0] as { type: 'text'; text: string })
      .text

    // Most recent entries should survive
    expect(summary1Text).toContain('Cycle1-Request-C')
    expect(summary1Text).toContain('Cycle1-Response-C')
    // Oldest entries should be dropped
    expect(summary1Text).not.toContain('Cycle1-Request-A')
    expect(summary1Text).not.toContain('Cycle1-Response-A')

    // === CYCLE 2: Add new messages, compact again ===
    const cycle2Messages = [
      summary1,
      createMessage('user', 'Cycle2-Request-D'),
      createMessage('assistant', 'Cycle2-Response-D'),
    ]
    const summary2 = simulateCompaction(cycle2Messages, tightBudgets)
    const summary2Text = (summary2.content[0] as { type: 'text'; text: string })
      .text

    // Newest entries from cycle 2 should survive
    expect(summary2Text).toContain('Cycle2-Request-D')
    expect(summary2Text).toContain('Cycle2-Response-D')
    // Cycle 1's oldest survivors should now be dropped
    expect(summary2Text).not.toContain('Cycle1-Request-A')
    expect(summary2Text).not.toContain('Cycle1-Response-A')

    // === CYCLE 3: Add more, compact again ===
    const cycle3Messages = [
      summary2,
      createMessage('user', 'Cycle3-Request-E'),
      createMessage('assistant', 'Cycle3-Response-E'),
    ]
    const summary3 = simulateCompaction(cycle3Messages, tightBudgets)
    const summary3Text = (summary3.content[0] as { type: 'text'; text: string })
      .text

    // Newest entries from cycle 3 should survive
    expect(summary3Text).toContain('Cycle3-Request-E')
    expect(summary3Text).toContain('Cycle3-Response-E')
    // Very old entries should definitely be gone
    expect(summary3Text).not.toContain('Cycle1-Request-A')
    expect(summary3Text).not.toContain('Cycle1-Response-A')

    // Verify only one conversation_summary tag (no nesting)
    const summaryTagCount = (
      summary3Text.match(/<conversation_summary>/g) || []
    ).length
    expect(summaryTagCount).toBe(1)
  })

  test('keeps multi-part tool entries grouped across compaction cycles', () => {
    const simulateCompaction = (inputMessages: Message[]): Message => {
      const result = runHandleSteps(inputMessages, 250000, 200000)
      return result[0].input.messages[0]
    }

    // Create a tool result that produces multiple entryParts:
    // both an error AND a non-zero exit code
    const cycle1Messages: Message[] = [
      createMessage('user', 'Run tests'),
      createToolCallMessage('call-1', 'run_terminal_command', {
        command: 'npm test',
      }),
      createToolResultMessage('call-1', 'run_terminal_command', {
        errorMessage: 'Test suite failed',
        exitCode: 1,
      }),
      createMessage('user', 'Fix the tests'),
      createMessage('assistant', 'I will fix them'),
    ]

    // Cycle 1: compact
    const summary1 = simulateCompaction(cycle1Messages)
    const summary1Text = (summary1.content[0] as { type: 'text'; text: string })
      .text

    // Both parts should be present in cycle 1
    expect(summary1Text).toContain(
      'Tool error from run_terminal_command: Test suite failed',
    )
    expect(summary1Text).toContain('Command failed with exit code: 1')

    // Cycle 2: re-compact — the multi-part entry should stay as one entry
    const cycle2Messages: Message[] = [
      summary1,
      createMessage('user', 'Try again'),
      createMessage('assistant', 'Running tests again'),
    ]
    const summary2 = simulateCompaction(cycle2Messages)
    const summary2Text = (summary2.content[0] as { type: 'text'; text: string })
      .text

    // Both parts should still be present together after re-compaction
    expect(summary2Text).toContain(
      'Tool error from run_terminal_command: Test suite failed',
    )
    expect(summary2Text).toContain('Command failed with exit code: 1')

    // They should be within the same --- delimited chunk (not split apart)
    const separator = '\n\n---\n\n'
    const chunks = summary2Text
      .replace(/<conversation_summary>[\s\S]*?\n\n/, '')
      .replace(/<\/conversation_summary>[\s\S]*/, '')
      .split(separator)
    const errorChunk = chunks.find((c) => c.includes('Tool error from'))
    expect(errorChunk).toBeDefined()
    expect(errorChunk).toContain('Command failed with exit code: 1')
  })

  test('handles 3+ compaction cycles without nested PREVIOUS SUMMARY markers', () => {
    // Helper to simulate running the context pruner and getting the output
    const simulateCompaction = (inputMessages: Message[]): Message => {
      const result = runHandleSteps(inputMessages, 250000, 200000)
      return result[0].input.messages[0]
    }

    // === CYCLE 1: Initial conversation ===
    const cycle1Messages = [
      createMessage('user', 'Cycle 1: User request about feature A'),
      createMessage('assistant', 'Cycle 1: I will help with feature A'),
    ]
    const summary1 = simulateCompaction(cycle1Messages)
    const summary1Text = (summary1.content[0] as { type: 'text'; text: string })
      .text

    // Verify cycle 1 output
    expect(summary1Text).toContain('Cycle 1: User request about feature A')
    expect(summary1Text).toContain('Cycle 1: I will help with feature A')
    expect(summary1Text).not.toContain('[PREVIOUS SUMMARY]') // No previous summary yet

    // === CYCLE 2: Continue conversation after first summary ===
    const cycle2Messages = [
      summary1,
      createMessage('user', 'Cycle 2: Now work on feature B'),
      createMessage('assistant', 'Cycle 2: Starting feature B work'),
    ]
    const summary2 = simulateCompaction(cycle2Messages)
    const summary2Text = (summary2.content[0] as { type: 'text'; text: string })
      .text

    // Verify cycle 2 preserves cycle 1 content (appended seamlessly)
    expect(summary2Text).toContain('Cycle 1: User request about feature A')
    expect(summary2Text).toContain('Cycle 2: Now work on feature B')

    // === CYCLE 3: Continue conversation after second summary ===
    const cycle3Messages = [
      summary2,
      createMessage('user', 'Cycle 3: Final feature C request'),
      createMessage('assistant', 'Cycle 3: Completing feature C'),
    ]
    const summary3 = simulateCompaction(cycle3Messages)
    const summary3Text = (summary3.content[0] as { type: 'text'; text: string })
      .text

    // Verify cycle 3 preserves ALL previous content (appended seamlessly)
    expect(summary3Text).toContain('Cycle 1: User request about feature A') // From cycle 1
    expect(summary3Text).toContain('Cycle 2: Now work on feature B') // From cycle 2
    expect(summary3Text).toContain('Cycle 3: Final feature C request') // New content

    // === CYCLE 4: One more cycle to be thorough ===
    const cycle4Messages = [
      summary3,
      createMessage('user', 'Cycle 4: Additional request'),
      createMessage('assistant', 'Cycle 4: Final response'),
    ]
    const summary4 = simulateCompaction(cycle4Messages)
    const summary4Text = (summary4.content[0] as { type: 'text'; text: string })
      .text

    // Verify cycle 4 preserves everything (appended seamlessly)
    expect(summary4Text).toContain('Cycle 1: User request about feature A')
    expect(summary4Text).toContain('Cycle 2: Now work on feature B')
    expect(summary4Text).toContain('Cycle 3: Final feature C request')
    expect(summary4Text).toContain('Cycle 4: Additional request')

    // Verify only one conversation_summary tag
    const summaryTagCount = (
      summary4Text.match(/<conversation_summary>/g) || []
    ).length
    expect(summaryTagCount).toBe(1)
  })
})

describe('context-pruner image token counting', () => {
  let mockAgentState: AgentState

  beforeEach(() => {
    mockAgentState = createMockAgentState([], 0)
  })

  const runHandleSteps = (
    messages: Message[],
    contextTokenCount?: number,
    maxContextLength?: number,
  ) => {
    mockAgentState.messageHistory = messages
    mockAgentState.contextTokenCount =
      contextTokenCount ?? Math.ceil(JSON.stringify(messages).length / 3)
    const mockLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }
    const generator = contextPruner.handleSteps!({
      agentState: mockAgentState,
      logger: mockLogger,
      params: maxContextLength ? { maxContextLength } : {},
    })
    const results: any[] = []
    let result = generator.next()
    while (!result.done) {
      if (typeof result.value === 'object') {
        results.push(result.value)
      }
      result = generator.next()
    }
    return results
  }

  test('does not over-count image tokens', () => {
    // Create a message with a large base64 image
    const largeBase64Image = 'x'.repeat(300000) // Would be ~100k tokens if counted as text

    const userMessageWithImage: Message = {
      role: 'user',
      content: [
        {
          type: 'image',
          image: largeBase64Image,
          mediaType: 'image/png',
        },
      ],
    }

    // With low contextTokenCount, should not trigger pruning
    const results = runHandleSteps([userMessageWithImage], 1000, 200000)

    expect(results).toHaveLength(1)
    // Message should be preserved without summarization
    expect(results[0].input.messages).toHaveLength(1)
    expect(results[0].input.messages[0].content[0].type).toBe('image')
  })
})

describe('context-pruner threshold behavior', () => {
  let mockAgentState: AgentState

  beforeEach(() => {
    mockAgentState = createMockAgentState([], 0)
  })

  const runHandleSteps = (
    messages: Message[],
    contextTokenCount: number,
    maxContextLength: number,
    budgets?: { assistantToolBudget?: number; userBudget?: number },
  ) => {
    mockAgentState.messageHistory = messages
    mockAgentState.contextTokenCount = contextTokenCount
    const mockLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }
    const generator = contextPruner.handleSteps!({
      agentState: mockAgentState,
      logger: mockLogger,
      params: { maxContextLength, ...budgets },
    })
    const results: any[] = []
    let result = generator.next()
    while (!result.done) {
      if (typeof result.value === 'object') {
        results.push(result.value)
      }
      result = generator.next()
    }
    return results
  }

  test('does not prune when under max limit minus fudge factor', () => {
    const messages = [
      createMessage('user', 'Hello'),
      createMessage('assistant', 'Hi'),
    ]

    // Set context to max limit minus fudge factor (1000) - should NOT prune
    // contextTokenCount + 1000 <= maxContextLength => 199000 + 1000 <= 200000
    const results = runHandleSteps(messages, 199000, 200000)

    // Should preserve original messages (not summarized)
    expect(results[0].input.messages).toHaveLength(2)
    expect(results[0].input.messages[0].role).toBe('user')
    expect(results[0].input.messages[1].role).toBe('assistant')
  })

  test('prunes when at max limit due to fudge factor', () => {
    const messages = [
      createMessage('user', 'Hello'),
      createMessage('assistant', 'Hi'),
    ]

    // Set context to exactly max limit - should prune due to 1000 token fudge factor
    // contextTokenCount + 1000 > maxContextLength => 200000 + 1000 > 200000
    const results = runHandleSteps(messages, 200000, 200000)

    // Should have summarized to single message
    expect(results[0].input.messages).toHaveLength(1)
    expect(results[0].input.messages[0].content[0].text).toContain(
      '<conversation_summary>',
    )
  })
})

describe('context-pruner str_replace and write_file tool results', () => {
  let mockAgentState: AgentState

  beforeEach(() => {
    mockAgentState = createMockAgentState([], 0)
  })

  const runHandleSteps = (messages: Message[]) => {
    mockAgentState.messageHistory = messages
    mockAgentState.contextTokenCount = 250000
    const mockLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }
    const generator = contextPruner.handleSteps!({
      agentState: mockAgentState,
      logger: mockLogger,
      params: { maxContextLength: 200000 },
    })
    const results: any[] = []
    let result = generator.next()
    while (!result.done) {
      if (typeof result.value === 'object') {
        results.push(result.value)
      }
      result = generator.next()
    }
    return results
  }

  test('includes str_replace result in summary', () => {
    const messages = [
      createMessage('user', 'Edit this file'),
      createToolCallMessage('call-1', 'str_replace', {
        path: 'src/utils.ts',
        replacements: [{ old: 'foo', new: 'bar' }],
      }),
      createToolResultMessage('call-1', 'str_replace', {
        file: 'src/utils.ts',
        message: 'Updated file',
        unifiedDiff:
          '--- a/src/utils.ts\n+++ b/src/utils.ts\n@@ -1,1 +1,1 @@\n-foo\n+bar',
      }),
    ]

    const results = runHandleSteps(messages)
    const content = results[0].input.messages[0].content[0].text

    expect(content).toContain('Edit result from str_replace:')
    expect(content).toContain('unifiedDiff')
    expect(content).toContain('-foo')
    expect(content).toContain('+bar')
  })

  test('includes write_file result in summary', () => {
    const messages = [
      createMessage('user', 'Create a new file'),
      createToolCallMessage('call-1', 'write_file', {
        path: 'src/new-file.ts',
        content: 'export const hello = "world"',
      }),
      createToolResultMessage('call-1', 'write_file', {
        file: 'src/new-file.ts',
        message: 'Created file',
        unifiedDiff:
          '--- /dev/null\n+++ b/src/new-file.ts\n@@ -0,0 +1 @@\n+export const hello = "world"',
      }),
    ]

    const results = runHandleSteps(messages)
    const content = results[0].input.messages[0].content[0].text

    expect(content).toContain('Edit result from write_file:')
    expect(content).toContain('export const hello')
  })

  test('truncates very long str_replace results', () => {
    const longDiff = 'X'.repeat(3000)
    const messages = [
      createMessage('user', 'Make big changes'),
      createToolCallMessage('call-1', 'str_replace', {
        path: 'src/big-file.ts',
        replacements: [],
      }),
      createToolResultMessage('call-1', 'str_replace', {
        file: 'src/big-file.ts',
        message: 'Updated file',
        unifiedDiff: longDiff,
      }),
    ]

    const results = runHandleSteps(messages)
    const content = results[0].input.messages[0].content[0].text

    expect(content).toContain('Edit result from str_replace:')
    expect(content).toContain('...')
    // Should not contain the full diff
    expect(content).not.toContain(longDiff)
  })

  test('truncates very large tool entries to 5k token limit', () => {
    // spawn_agents with multiple non-blacklisted agents producing large outputs
    // Each agent output is capped at ~3,900 chars, but 5 agents × 3,900 = ~19,500 chars
    // which exceeds the 5k token (15k char) TOOL_ENTRY_LIMIT
    const largeAgentResults = Array.from({ length: 5 }, (_, i) => ({
      agentType: `editor`,
      value: {
        type: 'string',
        value: `AGENT_${i}_START_` + 'X'.repeat(4000) + `_AGENT_${i}_END`,
      },
    }))

    const messages: Message[] = [
      createMessage('user', 'Spawn many agents'),
      createToolCallMessage('call-1', 'spawn_agents', {
        agents: [
          { agent_type: 'editor' },
          { agent_type: 'editor' },
          { agent_type: 'editor' },
          { agent_type: 'editor' },
          { agent_type: 'editor' },
        ],
      }),
      {
        role: 'tool',
        toolCallId: 'call-1',
        toolName: 'spawn_agents',
        content: [{ type: 'json', value: largeAgentResults }],
      } as ToolMessage,
    ]

    const results = runHandleSteps(messages)
    const content = results[0].input.messages[0].content[0].text

    // Should contain truncation notice from the TOOL_ENTRY_LIMIT cap
    expect(content).toContain('[...truncated')
    // The last agent's start marker should be cut by the overall entry cap
    // (per-agent truncation only cuts within each agent's output, not across agents)
    expect(content).not.toContain('AGENT_4_START_')
    // The first agent's start should survive (80% prefix)
    expect(content).toContain('AGENT_0_START_')
  })

  test('includes all result properties even without unifiedDiff', () => {
    const messages = [
      createMessage('user', 'Edit file'),
      createToolCallMessage('call-1', 'str_replace', {
        path: 'src/file.ts',
        replacements: [],
      }),
      createToolResultMessage('call-1', 'str_replace', {
        file: 'src/file.ts',
        errorMessage: 'No match found for old string',
      }),
    ]

    const results = runHandleSteps(messages)
    const content = results[0].input.messages[0].content[0].text

    // Should have both the tool call summary and the full result
    expect(content).toContain('edited file: src/file.ts')
    expect(content).toContain('Edit result from str_replace:')
    expect(content).toContain('errorMessage')
    expect(content).toContain('No match found for old string')
  })
})

describe('context-pruner glob and list_directory tools', () => {
  let mockAgentState: AgentState

  beforeEach(() => {
    mockAgentState = createMockAgentState([], 0)
  })

  const runHandleSteps = (messages: Message[]) => {
    mockAgentState.messageHistory = messages
    mockAgentState.contextTokenCount = 50000
    const mockLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }
    const generator = contextPruner.handleSteps!({
      agentState: mockAgentState,
      logger: mockLogger,
      params: { maxContextLength: 10000 },
    })
    const results: any[] = []
    let result = generator.next()
    while (!result.done) {
      if (typeof result.value === 'object') {
        results.push(result.value)
      }
      result = generator.next()
    }
    return results
  }

  test('summarizes glob tool with pattern', () => {
    const messages = [
      createMessage('user', 'Find files'),
      createToolCallMessage('call-1', 'glob', {
        pattern: '**/*.ts',
      }),
      createToolResultMessage('call-1', 'glob', { files: [] }),
    ]

    const results = runHandleSteps(messages)
    const content = results[0].input.messages[0].content[0].text

    expect(content).toContain('glob search for **/*.ts')
  })

  test('summarizes list_directory tool with path', () => {
    const messages = [
      createMessage('user', 'List directories'),
      createToolCallMessage('call-1', 'list_directory', {
        path: 'src',
      }),
      createToolResultMessage('call-1', 'list_directory', { entries: [] }),
    ]

    const results = runHandleSteps(messages)
    const content = results[0].input.messages[0].content[0].text

    expect(content).toContain('listed directory: src')
  })

  test('summarizes read_subtree tool with paths', () => {
    const messages = [
      createMessage('user', 'Read subtree'),
      createToolCallMessage('call-1', 'read_subtree', {
        paths: ['src/components', 'src/utils'],
      }),
      createToolResultMessage('call-1', 'read_subtree', { tree: {} }),
    ]

    const results = runHandleSteps(messages)
    const content = results[0].input.messages[0].content[0].text

    expect(content).toContain(
      'inspected subtrees: src/components, src/utils',
    )
  })
})

describe('context-pruner dual-budget behavior', () => {
  let mockAgentState: AgentState

  beforeEach(() => {
    mockAgentState = createMockAgentState([], 0)
  })

  const runHandleSteps = (
    messages: Message[],
    contextTokenCount: number,
    maxContextLength: number,
    budgets?: { assistantToolBudget?: number; userBudget?: number },
  ) => {
    mockAgentState.messageHistory = messages
    mockAgentState.contextTokenCount = contextTokenCount
    const mockLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }
    const generator = contextPruner.handleSteps!({
      agentState: mockAgentState,
      logger: mockLogger,
      params: { maxContextLength, ...budgets },
    })
    const results: any[] = []
    let result = generator.next()
    while (!result.done) {
      if (typeof result.value === 'object') {
        results.push(result.value)
      }
      result = generator.next()
    }
    return results
  }

  test('includes recent messages in summary and drops older ones', () => {
    const messages = [
      createMessage('user', 'Old user message 1'),
      createMessage('assistant', 'Old assistant response 1'),
      createMessage('user', 'Old user message 2'),
      createMessage('assistant', 'Old assistant response 2'),
      createMessage('user', 'Recent user message'),
      createMessage('assistant', 'Recent assistant response'),
    ]

    // Small budgets on summarized sizes: only the most recent entries fit
    const results = runHandleSteps(messages, 250000, 200000, {
      assistantToolBudget: 15,
      userBudget: 15,
    })

    const resultMessages = results[0].input.messages

    // Should be a single summary message (no verbatim messages)
    expect(resultMessages).toHaveLength(1)

    const content = (resultMessages[0].content[0] as { text: string }).text
    expect(content).toContain('<conversation_summary>')

    // Recent messages should be in the summary
    expect(content).toContain('Recent user message')
    expect(content).toContain('Recent assistant response')

    // Older messages should be dropped entirely (not in summary)
    expect(content).not.toContain('Old user message 1')
    expect(content).not.toContain('Old assistant response 1')
    expect(content).not.toContain('Old user message 2')
    expect(content).not.toContain('Old assistant response 2')
  })

  test('summarizes all messages when they fit within budgets', () => {
    const messages = [
      createMessage('user', 'Hello'),
      createMessage('assistant', 'Hi there!'),
      createMessage('user', 'How are you?'),
      createMessage('assistant', 'I am fine!'),
    ]

    // Large budgets: all messages fit in summary
    const results = runHandleSteps(messages, 250000, 200000, {
      assistantToolBudget: 20000,
      userBudget: 50000,
    })

    const resultMessages = results[0].input.messages

    // All messages summarized into one
    expect(resultMessages).toHaveLength(1)

    const content = (resultMessages[0].content[0] as { text: string }).text
    expect(content).toContain('Hello')
    expect(content).toContain('Hi there!')
    expect(content).toContain('How are you?')
    expect(content).toContain('I am fine!')
  })

  test('respects user budget separately from assistant+tool budget', () => {
    const largeUserText = 'U'.repeat(600) // ~200 tokens
    const messages = [
      createMessage('user', largeUserText),
      createMessage('assistant', 'Short response'),
      createMessage('user', 'Recent short question'),
      createMessage('assistant', 'Recent short answer'),
    ]

    // User budget small enough to exclude the large user message
    // Assistant budget large enough to include all assistant messages
    const results = runHandleSteps(messages, 250000, 200000, {
      assistantToolBudget: 5000,
      userBudget: 100,
    })

    const resultMessages = results[0].input.messages
    expect(resultMessages).toHaveLength(1)

    const content = (resultMessages[0].content[0] as { text: string }).text
    expect(content).toContain('<conversation_summary>')
    // The large user message should be dropped (not in summary)
    expect(content).not.toContain(largeUserText)
    // Recent messages should be in the summary
    expect(content).toContain('Recent short question')
    expect(content).toContain('Recent short answer')
  })

  test('drops tool entries beyond budget at the cutoff boundary', () => {
    const messages = [
      createMessage('user', 'Old message'),
      createToolCallMessage('call-1', 'read_files', { paths: ['old.ts'] }),
      createToolResultMessage('call-1', 'read_files', { content: 'old file' }),
      createMessage('user', 'Recent message'),
      createMessage('assistant', 'Recent response'),
    ]

    // Budget that excludes the older tool call entry
    const results = runHandleSteps(messages, 250000, 200000, {
      assistantToolBudget: 15,
      userBudget: 15,
    })

    const resultMessages = results[0].input.messages
    expect(resultMessages).toHaveLength(1)

    const content = (resultMessages[0].content[0] as { text: string }).text

    // Recent messages should be in the summary
    expect(content).toContain('Recent message')
    expect(content).toContain('Recent response')

    // Tool call summary should be dropped (beyond budget)
    expect(content).not.toContain('old.ts')
  })

  test('counts tool result summaries against assistant+tool budget', () => {
    // Use str_replace with a large result — this produces a summarized edit-result entry
    const largeDiff = 'LARGE_DIFF_CONTENT_' + 'X'.repeat(900)
    const messages = [
      createMessage('user', 'Do something'),
      createToolCallMessage('call-1', 'str_replace', {
        path: 'big.ts',
        replacements: [],
      }),
      createToolResultMessage('call-1', 'str_replace', {
        file: 'big.ts',
        message: 'Updated',
        unifiedDiff: largeDiff,
      }),
      createMessage('user', 'Recent question'),
      createMessage('assistant', 'Recent answer'),
    ]

    // Assistant budget too small for the large edit-result summary entry
    const results = runHandleSteps(messages, 250000, 200000, {
      assistantToolBudget: 100,
      userBudget: 5000,
    })

    const resultMessages = results[0].input.messages
    expect(resultMessages).toHaveLength(1)

    const content = (resultMessages[0].content[0] as { text: string }).text
    expect(content).toContain('<conversation_summary>')
    // Recent messages should be in the summary
    expect(content).toContain('Recent question')
    expect(content).toContain('Recent answer')
    // Large edit result entry should be dropped (exceeds assistant+tool budget)
    expect(content).not.toContain('LARGE_DIFF_CONTENT_')
  })

  test('drops older messages and includes recent ones in summary', () => {
    const messages = [
      createMessage('user', 'First request about feature A'),
      createMessage('assistant', 'Working on feature A'),
      createMessage('user', 'Second request about feature B'),
      createMessage('assistant', 'Working on feature B'),
    ]

    // Budget only fits the last pair of summarized entries
    const results = runHandleSteps(messages, 250000, 200000, {
      assistantToolBudget: 15,
      userBudget: 15,
    })

    const resultMessages = results[0].input.messages
    expect(resultMessages).toHaveLength(1)

    const content = (resultMessages[0].content[0] as { text: string }).text
    expect(content).toContain('<conversation_summary>')

    // Recent messages should be in the summary
    expect(content).toContain('Second request about feature B')
    expect(content).toContain('Working on feature B')

    // Older messages should be dropped
    expect(content).not.toContain('First request about feature A')
    expect(content).not.toContain('Working on feature A')
  })

  test('excludes STEP_PROMPT tagged messages from budget calculation', () => {
    const largeStepPrompt = 'S'.repeat(900) // ~300 tokens
    const messages: Message[] = [
      createMessage('user', 'User request'),
      createMessage('assistant', 'Assistant response'),
      {
        role: 'user',
        content: [{ type: 'text', text: largeStepPrompt }],
        tags: ['STEP_PROMPT'],
      },
      createMessage('user', 'Recent question'),
      createMessage('assistant', 'Recent answer'),
    ]

    // Budget is small but the STEP_PROMPT should NOT count against it,
    // so both real user messages and both assistant messages should fit
    const results = runHandleSteps(messages, 250000, 200000, {
      assistantToolBudget: 200,
      userBudget: 200,
    })

    const resultMessages = results[0].input.messages
    expect(resultMessages).toHaveLength(1)

    const content = (resultMessages[0].content[0] as { text: string }).text
    // Both real messages should be in the summary
    expect(content).toContain('User request')
    expect(content).toContain('Assistant response')
    expect(content).toContain('Recent question')
    expect(content).toContain('Recent answer')
    // STEP_PROMPT content should NOT be in the summary
    expect(content).not.toContain(largeStepPrompt)
  })

  test('excludes SUBAGENT_SPAWN tagged messages from budget calculation', () => {
    const messages: Message[] = [
      createMessage('user', 'User request'),
      createMessage('assistant', 'First response'),
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'A'.repeat(900) }],
        tags: ['SUBAGENT_SPAWN'],
      },
      createMessage('user', 'Follow up'),
      createMessage('assistant', 'Second response'),
    ]

    // Budget is small but SUBAGENT_SPAWN should NOT count against it
    const results = runHandleSteps(messages, 250000, 200000, {
      assistantToolBudget: 200,
      userBudget: 200,
    })

    const resultMessages = results[0].input.messages
    expect(resultMessages).toHaveLength(1)

    const content = (resultMessages[0].content[0] as { text: string }).text
    expect(content).toContain('User request')
    expect(content).toContain('First response')
    expect(content).toContain('Follow up')
    expect(content).toContain('Second response')
  })

  test('charges old summary entries against their correct budgets', () => {
    // Previous summary with a large [USER] entry that exceeds user budget
    const largeUserContent = 'X'.repeat(900)
    const previousSummary: Message = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `<conversation_summary>\nThis is a summary of the conversation so far. The original messages have been condensed to save context space.\n\n[USER]\n${largeUserContent}\n\n---\n\n[ASSISTANT]\nOld assistant response\n</conversation_summary>`,
        },
      ],
    }

    const messages: Message[] = [
      previousSummary,
      createMessage('user', 'After summary request'),
      createMessage('assistant', 'After summary response'),
    ]

    // User budget is small — the large [USER] entry from the old summary
    // should be dropped because it exceeds the user budget.
    // The [ASSISTANT] entry from the old summary charges against assistant budget.
    const results = runHandleSteps(messages, 250000, 200000, {
      assistantToolBudget: 5000,
      userBudget: 50,
    })

    const resultMessages = results[0].input.messages
    expect(resultMessages).toHaveLength(1)

    const content = (resultMessages[0].content[0] as { text: string }).text
    // Recent messages should be in the summary
    expect(content).toContain('After summary request')
    expect(content).toContain('After summary response')
    // The old [ASSISTANT] entry fits the assistant budget and is after the cutoff
    expect(content).toContain('Old assistant response')
    // The large old [USER] entry should be dropped (exceeded user budget)
    expect(content).not.toContain(largeUserContent)
  })

  test('drops old summary entries individually based on budget walk', () => {
    // Previous summary with identifiable oldest and middle entries
    const previousSummary: Message = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `<conversation_summary>\nThis is a summary of the conversation so far. The original messages have been condensed to save context space.\n\n[USER]\nOLDEST_USER_ENTRY\n\n---\n\n[ASSISTANT]\nOLDEST_ASSISTANT_ENTRY\n\n---\n\n[USER]\nMIDDLE_USER_ENTRY\n\n---\n\n[ASSISTANT]\nMIDDLE_ASSISTANT_ENTRY\n</conversation_summary>`,
        },
      ],
    }

    const messages: Message[] = [
      previousSummary,
      createMessage('user', 'Recent request'),
      createMessage('assistant', 'Recent response'),
    ]

    // Budget large enough for middle + recent entries but not oldest
    const results = runHandleSteps(messages, 250000, 200000, {
      assistantToolBudget: 25,
      userBudget: 25,
    })

    const resultMessages = results[0].input.messages
    expect(resultMessages).toHaveLength(1)

    const content = (resultMessages[0].content[0] as { text: string }).text
    // Middle and recent entries should survive
    expect(content).toContain('MIDDLE_USER_ENTRY')
    expect(content).toContain('MIDDLE_ASSISTANT_ENTRY')
    expect(content).toContain('Recent request')
    expect(content).toContain('Recent response')
    // Oldest entries should be dropped
    expect(content).not.toContain('OLDEST_USER_ENTRY')
    expect(content).not.toContain('OLDEST_ASSISTANT_ENTRY')
  })

  test('handles complex scenario with long messages of all types and previous summary', () => {
    // Previous summary with 4 identifiable entries
    const previousSummary: Message = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `<conversation_summary>\nThis is a summary of the conversation so far. The original messages have been condensed to save context space.\n\n[USER]\nOLD_USER_REQUEST_1: The user asked about setting up authentication with OAuth2 and JWT tokens for the API.\n\n---\n\n[ASSISTANT]\nOLD_ASSISTANT_RESPONSE_1: Explained OAuth2 flow and implemented JWT token generation.\nTools: Read files: src/auth.ts, src/middleware.ts; Edited file: src/auth.ts\n\n---\n\n[USER]\nOLD_USER_REQUEST_2: Asked for unit tests for the auth module.\n\n---\n\n[ASSISTANT]\nOLD_ASSISTANT_RESPONSE_2: Created comprehensive test suite for authentication.\nTools: Wrote file: src/__tests__/auth.test.ts\n</conversation_summary>`,
        },
      ],
    }

    // Long user message (~45k chars, exceeds USER_MESSAGE_LIMIT of 13k tokens = 39k chars)
    // Middle marker placed ~85% through so it falls in the truncated gap
    // (past the 80% prefix but before the 20% suffix)
    const longUserMessage =
      'LONG_USER_START_' +
      'Here is a detailed specification for the new feature. '.repeat(650) +
      '_LONG_USER_MIDDLE_MARKER_' +
      'Here is a detailed specification for the new feature. '.repeat(150)

    // Long assistant message with text (~8k chars, exceeds ASSISTANT_MESSAGE_LIMIT of 1.3k tokens = 3.9k chars)
    // plus multiple tool calls. Middle marker placed ~60% through so it falls in the truncated gap.
    const longAssistantText =
      'LONG_ASSISTANT_START_' +
      'I will implement this step by step, starting with the data model changes. '.repeat(
        60,
      ) +
      '_LONG_ASST_MIDDLE_MARKER_' +
      'I will implement this step by step, starting with the data model changes. '.repeat(
        40,
      )
    const assistantWithToolCalls: Message = {
      role: 'assistant',
      content: [
        { type: 'text', text: longAssistantText },
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'read_files',
          input: { paths: ['src/model.ts', 'src/service.ts'] },
        },
        {
          type: 'tool-call',
          toolCallId: 'call-2',
          toolName: 'str_replace',
          input: { path: 'src/model.ts', replacements: [] },
        },
        {
          type: 'tool-call',
          toolCallId: 'call-3',
          toolName: 'spawn_agents',
          input: {
            agents: [
              { agent_type: 'editor' },
              { agent_type: 'editor' },
              { agent_type: 'editor' },
              { agent_type: 'editor' },
              { agent_type: 'editor' },
            ],
          },
        },
      ],
    }

    // str_replace result with a large diff (~3k chars, exceeds 2k truncation limit)
    const largeDiff =
      'DIFF_START_MARKER_' + '+added line\n'.repeat(250) + '_DIFF_END_MARKER'

    // spawn_agents result with 5 non-blacklisted agents producing large outputs
    // Each ~4k chars, total ~20k, exceeds TOOL_ENTRY_LIMIT of 5k tokens = 15k chars
    const largeAgentResults = Array.from({ length: 5 }, (_, i) => ({
      agentType: 'editor',
      value: {
        type: 'string',
        value:
          `AGENT_${i}_OUTPUT_START_` +
          'Implementation details. '.repeat(160) +
          `_AGENT_${i}_OUTPUT_END`,
      },
    }))

    const messages: Message[] = [
      previousSummary,
      createMessage('user', longUserMessage),
      assistantWithToolCalls,
      createToolResultMessage('call-1', 'read_files', {
        content: 'file data',
      } as JSONValue),
      createToolResultMessage('call-2', 'str_replace', {
        file: 'src/model.ts',
        message: 'Updated',
        unifiedDiff: largeDiff,
      }),
      {
        role: 'tool',
        toolCallId: 'call-3',
        toolName: 'spawn_agents',
        content: [{ type: 'json', value: largeAgentResults }],
      } as ToolMessage,
      createMessage('user', 'FINAL_USER_REQUEST: Now run the tests'),
      createMessage('assistant', 'FINAL_ASSISTANT_RESPONSE: Running tests now'),
    ]

    // Use default budgets — everything should fit
    const results = runHandleSteps(messages, 250000, 200000)
    const resultMessages = results[0].input.messages
    expect(resultMessages).toHaveLength(1)

    const content = (resultMessages[0].content[0] as { text: string }).text

    // === Structure checks ===
    expect(content).toContain('<conversation_summary>')
    expect(content).toContain('</conversation_summary>')
    const summaryTagCount = (content.match(/<conversation_summary>/g) || [])
      .length
    expect(summaryTagCount).toBe(1)

    // === Previous summary entries preserved ===
    expect(content).toContain('OLD_USER_REQUEST_1')
    expect(content).toContain('OLD_ASSISTANT_RESPONSE_1')
    expect(content).toContain('OLD_USER_REQUEST_2')
    expect(content).toContain('OLD_ASSISTANT_RESPONSE_2')

    // === Long user message: truncated with 80/20 split ===
    expect(content).toContain('LONG_USER_START_')
    expect(content).not.toContain('_LONG_USER_MIDDLE_MARKER_') // Middle marker falls in truncated gap
    expect(content).toContain('[...truncated')

    // === Long assistant text: truncated ===
    expect(content).toContain('LONG_ASSISTANT_START_')
    expect(content).not.toContain('_LONG_ASST_MIDDLE_MARKER_') // Middle marker falls in truncated gap

    // === Tool call summaries present ===
    expect(content).toContain(
      'inspected files: src/model.ts, src/service.ts',
    )
    expect(content).toContain('edited file: src/model.ts')
    expect(content).toContain('delegated agents:')

    // === str_replace result: present but truncated at 2k chars ===
    expect(content).toContain('Edit result from str_replace:')
    expect(content).toContain('DIFF_START_MARKER_')
    expect(content).not.toContain('_DIFF_END_MARKER') // Truncated by 2k result limit

    // === spawn_agents tool entry: truncated by TOOL_ENTRY_LIMIT ===
    expect(content).toContain('AGENT_0_OUTPUT_START_') // First agent's start in 80% prefix
    expect(content).not.toContain('AGENT_4_OUTPUT_START_') // Last agent's start falls in truncated gap

    // === Final messages present ===
    expect(content).toContain('FINAL_USER_REQUEST')
    expect(content).toContain('FINAL_ASSISTANT_RESPONSE')

    // === Entries are separated by --- ===
    expect(content).toContain('---')
  })

  test('with tight budgets, drops old summary entries while keeping truncated new entries', () => {
    // Same setup but with tight budgets: old summary entries get dropped,
    // new entries survive (individually truncated)
    const previousSummary: Message = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `<conversation_summary>\nThis is a summary of the conversation so far. The original messages have been condensed to save context space.\n\n[USER]\nOLD_DROPPED_USER: ${'X'.repeat(600)}\n\n---\n\n[ASSISTANT]\nOLD_DROPPED_ASSISTANT: ${'Y'.repeat(600)}\n\n---\n\n[USER]\nOLD_DROPPED_USER_2: Asked about deployment\n\n---\n\n[ASSISTANT]\nOLD_DROPPED_ASSISTANT_2: ${'Explained deployment process. '.repeat(80)}\n</conversation_summary>`,
        },
      ],
    }

    // Long user message (~12k chars, under truncation limit but uses significant budget)
    const longUserMessage =
      'SURVIVED_USER_START_' +
      'Feature request details. '.repeat(400) +
      '_SURVIVED_USER_END'

    // Assistant with tool calls
    const assistantMsg: Message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'SURVIVED_ASSISTANT: Working on it' },
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'str_replace',
          input: { path: 'src/app.ts', replacements: [] },
        },
      ],
    }

    // Tool result with a diff
    const toolResult = createToolResultMessage('call-1', 'str_replace', {
      file: 'src/app.ts',
      message: 'Updated file',
      unifiedDiff:
        '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+SURVIVED_DIFF_CONTENT',
    })

    const messages: Message[] = [
      previousSummary,
      createMessage('user', longUserMessage),
      assistantMsg,
      toolResult,
      createMessage('user', 'SURVIVED_FINAL_USER'),
      createMessage('assistant', 'SURVIVED_FINAL_ASSISTANT'),
    ]

    // Tight budgets: enough for new entries but not old summary entries
    // New assistant entries: ~25 (assistant text+tool) + ~56 (edit result JSON) + ~13 (final) = ~94 tokens
    // Old assistant entries: ~20 for OLD_DROPPED_ASSISTANT_2 would push over budget of 100
    const results = runHandleSteps(messages, 250000, 200000, {
      assistantToolBudget: 400,
      userBudget: 3400,
    })

    const resultMessages = results[0].input.messages
    expect(resultMessages).toHaveLength(1)

    const content = (resultMessages[0].content[0] as { text: string }).text

    // === New entries survived ===
    expect(content).toContain('SURVIVED_USER_START_')
    expect(content).toContain('SURVIVED_ASSISTANT')
    expect(content).toContain('SURVIVED_DIFF_CONTENT')
    expect(content).toContain('SURVIVED_FINAL_USER')
    expect(content).toContain('SURVIVED_FINAL_ASSISTANT')

    // === Old summary entries dropped by budget walk ===
    expect(content).not.toContain('OLD_DROPPED_USER:')
    expect(content).not.toContain('OLD_DROPPED_ASSISTANT:')
    expect(content).not.toContain('OLD_DROPPED_USER_2:')
    expect(content).not.toContain('OLD_DROPPED_ASSISTANT_2:')
  })

  test('fully includes conversation summary when it fits within user budget', () => {
    const previousSummary: Message = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `<conversation_summary>\nThis is a summary of the conversation so far. The original messages have been condensed to save context space.\n\n[USER]\nOld request about feature A\n\n---\n\n[ASSISTANT]\nWorked on feature A\n</conversation_summary>`,
        },
      ],
    }

    const messages: Message[] = [
      previousSummary,
      createMessage('user', 'New request about feature B'),
      createMessage('assistant', 'Working on feature B'),
    ]

    // Large budget — everything fits
    const results = runHandleSteps(messages, 250000, 200000, {
      assistantToolBudget: 20000,
      userBudget: 50000,
    })

    const resultMessages = results[0].input.messages
    expect(resultMessages).toHaveLength(1)

    const content = (resultMessages[0].content[0] as { text: string }).text
    // Previous summary content should be fully included
    expect(content).toContain('Old request about feature A')
    expect(content).toContain('Worked on feature A')
    // New messages should also be included
    expect(content).toContain('New request about feature B')
    expect(content).toContain('Working on feature B')
  })
})
