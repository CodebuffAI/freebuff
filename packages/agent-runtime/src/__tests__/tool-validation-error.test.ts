import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { promptSuccess } from '@codebuff/common/util/error'
import { jsonToolResult } from '@codebuff/common/util/messages'
import { beforeEach, describe, expect, it } from 'bun:test'

import { mockFileContext } from './test-utils'
import { processStream } from '../tools/stream-parser'
import { parseRawToolCall } from '../tools/tool-executor'

import type { AgentTemplate } from '../templates/types'
import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
} from '@codebuff/common/types/contracts/agent-runtime'
import type { StreamChunk } from '@codebuff/common/types/contracts/llm'
import type {
  AssistantMessage,
  ToolMessage,
} from '@codebuff/common/types/messages/codebuff-message'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

describe('tool validation error handling', () => {
  let agentRuntimeImpl: AgentRuntimeDeps & AgentRuntimeScopedDeps

  beforeEach(() => {
    agentRuntimeImpl = { ...TEST_AGENT_RUNTIME_IMPL, sendAction: () => {} }
  })

  const testAgentTemplate: AgentTemplate = {
    id: 'test-agent',
    displayName: 'Test Agent',
    spawnerPrompt: 'Test agent',
    model: 'claude-3-5-sonnet-20241022',
    inputSchema: {},
    outputMode: 'structured_output',
    includeMessageHistory: true,
    inheritParentSystemPrompt: false,
    mcpServers: {},
    toolNames: ['spawn_agents', 'end_turn'],
    spawnableAgents: [],
    systemPrompt: 'Test system prompt',
    instructionsPrompt: 'Test instructions',
    stepPrompt: 'Test step prompt',
  }

  it('should parse repeatedly stringified native tool input before validation', () => {
    const input = {
      path: 'test.ts',
      instructions: 'Writes a test file',
      content: 'console.log("test")\n',
    }

    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'write_file',
        toolCallId: 'double-stringified-tool-call-id',
        input: JSON.stringify(JSON.stringify(input)),
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input).toEqual(input)
    }
  })

  it('should repair bare path values for list_directory string input', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'list_directory',
        toolCallId: 'bare-path-tool-call-id',
        input: '{"path": web/src/app/api/agents}',
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input).toEqual({ path: 'web/src/app/api/agents' })
    }
  })

  it('should repair bare pattern values for glob string input', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'glob',
        toolCallId: 'bare-pattern-tool-call-id',
        input: '{"pattern": backend/src/templates/agents/git-committer.ts}',
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input).toEqual({
        pattern: 'backend/src/templates/agents/git-committer.ts',
      })
    }
  })

  it('should repair bare paths values for read_files string input', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'read_files',
        toolCallId: 'bare-paths-tool-call-id',
        input: '{"paths": sdk/src/client.ts}',
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input).toEqual({ paths: ['sdk/src/client.ts'] })
    }
  })

  it('should not repair bare path values for unrelated tools', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'write_file',
        toolCallId: 'unrelated-bare-path-tool-call-id',
        input: '{"path": web/src/app/api/agents}',
      },
    })

    expect('error' in result).toBe(true)
  })

  it('should parse stringified params for spawn_agents entries', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'spawn_agents',
        toolCallId: 'spawn-agents-stringified-params-tool-call-id',
        input: {
          agents: [
            {
              agent_type: 'basher',
              prompt: 'Run tests',
              params: '{"command":"bun test"}',
            },
          ],
        },
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input.agents[0].params).toEqual({ command: 'bun test' })
    }
  })

  it('should parse stringified params for spawn_agent_inline', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'spawn_agent_inline',
        toolCallId: 'spawn-agent-inline-stringified-params-tool-call-id',
        input: {
          agent_type: 'basher',
          prompt: 'Run tests',
          params: '{"command":"bun test"}',
        },
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input.params).toEqual({ command: 'bun test' })
    }
  })

  it('should accept old_str/new_str aliases for str_replace replacements', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'str_replace',
        toolCallId: 'alias-tool-call-id',
        input: {
          path: 'test.ts',
          replacements: [
            {
              old_str: 'before',
              new_str: 'after',
            },
          ],
        },
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input.replacements).toEqual([
        { oldString: 'before', newString: 'after', allowMultiple: false },
      ])
    }
  })

  it('should accept old/new aliases for str_replace replacements', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'str_replace',
        toolCallId: 'short-alias-tool-call-id',
        input: {
          path: 'test.ts',
          replacements: [
            {
              old: 'before',
              new: 'after',
            },
          ],
        },
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input.replacements).toEqual([
        { oldString: 'before', newString: 'after', allowMultiple: false },
      ])
    }
  })

  it('should accept old_string/new_string aliases for str_replace replacements', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'str_replace',
        toolCallId: 'long-alias-tool-call-id',
        input: {
          path: 'test.ts',
          replacements: [
            {
              old_string: 'before',
              new_string: 'after',
            },
          ],
        },
      },
    })

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input.replacements).toEqual([
        { oldString: 'before', newString: 'after', allowMultiple: false },
      ])
    }
  })

  it('should summarize missing replacement fields without implying deletion', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'str_replace',
        toolCallId: 'missing-new-tool-call-id',
        input: {
          path: 'test.ts',
          replacements: [
            { oldString: 'before', newString: 'after' },
            { oldString: 'delete me' },
            { oldString: 'delete me too' },
          ],
        },
      },
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('Missing required replacement fields:')
      expect(result.error).toContain('- replacements[1].newString')
      expect(result.error).toContain('- replacements[2].newString')
      expect(result.error).toContain(
        'If the intent is deletion, set "newString": "" explicitly.',
      )
      expect(result.error).toContain('Raw validation issues:')
    }
  })

  it('should include JSON parse details for incomplete stringified input', () => {
    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'write_file',
        toolCallId: 'incomplete-stringified-tool-call-id',
        input:
          '{"path": ".agents/deep-thinkers/meta-coordinator.ts", "instructions": "Creates a meta-coordinator"',
      },
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain(
        'expected the tool arguments to be an object, but received a string',
      )
      expect(result.error).toContain('Parsing as JSON failed:')
      expect(result.error).toContain(
        'The arguments may be malformed or incomplete',
      )
    }
  })

  it('should explain when parsed tool input remains a string', () => {
    const input = JSON.stringify(
      JSON.stringify(
        JSON.stringify(
          JSON.stringify({
            path: 'test.ts',
            instructions: 'Writes a test file',
            content: 'console.log("test")\n',
          }),
        ),
      ),
    )

    const result = parseRawToolCall({
      rawToolCall: {
        toolName: 'write_file',
        toolCallId: 'over-encoded-tool-call-id',
        input,
      },
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain(
        'expected the tool arguments to be an object, but received a string',
      )
      expect(result.error).toContain(
        'Parsing succeeded, but the parsed value was still a string',
      )
      expect(result.error).not.toContain('malformed or incomplete')
    }
  })

  it('should emit error event instead of tool result when spawn_agents receives invalid parameters', async () => {
    // This simulates what happens when the LLM passes a string instead of an array to spawn_agents
    // The error from Anthropic was: "Invalid parameters for spawn_agents: expected array, received string"
    const invalidToolCallChunk: StreamChunk = {
      type: 'tool-call',
      toolName: 'spawn_agents',
      toolCallId: 'test-tool-call-id',
      input: {
        agents: 'this should be an array not a string', // Invalid - should be array
      },
    }

    async function* mockStream() {
      yield invalidToolCallChunk
      return promptSuccess('mock-message-id')
    }

    const sessionState = getInitialSessionState(mockFileContext)
    const agentState = sessionState.mainAgentState

    const responseChunks: (string | PrintModeEvent)[] = []

    const result = await processStream({
      ...agentRuntimeImpl,
      agentContext: {},
      agentState,
      agentStepId: 'test-step-id',
      agentTemplate: testAgentTemplate,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: mockFileContext,
      fingerprintId: 'test-fingerprint',
      fullResponse: '',
      localAgentTemplates: { 'test-agent': testAgentTemplate },
      messages: [],
      prompt: 'test prompt',
      repoId: undefined,
      repoUrl: undefined,
      runId: 'test-run-id',
      signal: new AbortController().signal,
      stream: mockStream(),
      system: 'test system',
      tools: {},
      userId: 'test-user',
      userInputId: 'test-input-id',
      onCostCalculated: async () => {},
      onResponseChunk: (chunk) => {
        responseChunks.push(chunk)
      },
    })

    // Verify an error event was emitted (not a tool result)
    const errorEvents = responseChunks.filter(
      (chunk): chunk is Extract<PrintModeEvent, { type: 'error' }> =>
        typeof chunk !== 'string' && chunk.type === 'error',
    )
    expect(errorEvents.length).toBe(1)
    expect(errorEvents[0].message).toContain(
      'Invalid parameters for spawn_agents',
    )
    expect(errorEvents[0].message).toContain('Original tool call input:')
    expect(errorEvents[0].message).toContain(
      'this should be an array not a string',
    )

    // Verify hadToolCallError is true so the agent loop continues
    expect(result.hadToolCallError).toBe(true)

    // Verify NO tool_call event was emitted (since validation failed before that point)
    const toolCallEvents = responseChunks.filter(
      (chunk): chunk is Extract<PrintModeEvent, { type: 'tool_call' }> =>
        typeof chunk !== 'string' && chunk.type === 'tool_call',
    )
    expect(toolCallEvents.length).toBe(0)

    // Verify NO tool_result event was emitted
    const toolResultEvents = responseChunks.filter(
      (chunk): chunk is Extract<PrintModeEvent, { type: 'tool_result' }> =>
        typeof chunk !== 'string' && chunk.type === 'tool_result',
    )
    expect(toolResultEvents.length).toBe(0)

    // Verify the message history doesn't contain orphan tool results
    // It should NOT have any tool messages since no tool call was made
    const toolMessages = agentState.messageHistory.filter(
      (m) => m.role === 'tool',
    )
    const assistantToolCalls = agentState.messageHistory.filter(
      (m) =>
        m.role === 'assistant' && m.content.some((c) => c.type === 'tool-call'),
    )

    // There should be no tool messages at all (the key fix!)
    expect(toolMessages.length).toBe(0)
    // And no assistant tool calls either
    expect(assistantToolCalls.length).toBe(0)

    // Verify error message was added to message history for the LLM to see
    const userMessages = agentState.messageHistory.filter(
      (m) => m.role === 'user',
    )
    const errorUserMessage = userMessages.find((m) => {
      const contentStr = Array.isArray(m.content)
        ? m.content.map((p) => ('text' in p ? p.text : '')).join('')
        : typeof m.content === 'string'
          ? m.content
          : ''
      return (
        contentStr.includes('Error during tool call') &&
        contentStr.includes('Invalid parameters for spawn_agents')
      )
    })
    expect(errorUserMessage).toBeDefined()
  })

  it('should still emit tool_call and tool_result for valid tool calls', async () => {
    // Create an agent that has read_files tool
    const agentWithReadFiles: AgentTemplate = {
      ...testAgentTemplate,
      toolNames: ['read_files', 'end_turn'],
    }

    const validToolCallChunk: StreamChunk = {
      type: 'tool-call',
      toolName: 'read_files',
      toolCallId: 'valid-tool-call-id',
      input: {
        paths: ['test.ts'], // Valid array parameter
      },
    }

    async function* mockStream() {
      yield validToolCallChunk
      return promptSuccess('mock-message-id')
    }

    const sessionState = getInitialSessionState(mockFileContext)
    const agentState = sessionState.mainAgentState

    // Mock requestFiles to return a file
    agentRuntimeImpl.requestFiles = async () => ({
      'test.ts': 'console.log("test")',
    })

    const responseChunks: (string | PrintModeEvent)[] = []

    await processStream({
      ...agentRuntimeImpl,
      agentContext: {},
      agentState,
      agentStepId: 'test-step-id',
      agentTemplate: agentWithReadFiles,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: mockFileContext,
      fingerprintId: 'test-fingerprint',
      fullResponse: '',
      localAgentTemplates: { 'test-agent': agentWithReadFiles },
      messages: [],
      prompt: 'test prompt',
      repoId: undefined,
      repoUrl: undefined,
      runId: 'test-run-id',
      signal: new AbortController().signal,
      stream: mockStream(),
      system: 'test system',
      tools: {},
      userId: 'test-user',
      userInputId: 'test-input-id',
      onCostCalculated: async () => {},
      onResponseChunk: (chunk) => {
        responseChunks.push(chunk)
      },
    })

    // Verify tool_call event was emitted
    const toolCallEvents = responseChunks.filter(
      (chunk): chunk is Extract<PrintModeEvent, { type: 'tool_call' }> =>
        typeof chunk !== 'string' && chunk.type === 'tool_call',
    )
    expect(toolCallEvents.length).toBe(1)
    expect(toolCallEvents[0].toolName).toBe('read_files')
    expect(toolCallEvents[0].toolCallId).toBe('functions.read_files.0')

    // Verify tool_result event was emitted
    const toolResultEvents = responseChunks.filter(
      (chunk): chunk is Extract<PrintModeEvent, { type: 'tool_result' }> =>
        typeof chunk !== 'string' && chunk.type === 'tool_result',
    )
    expect(toolResultEvents.length).toBe(1)
    expect(toolResultEvents[0].toolName).toBe('read_files')
    expect(toolResultEvents[0].toolCallId).toBe('functions.read_files.0')

    // Verify NO error events
    const errorEvents = responseChunks.filter(
      (chunk): chunk is Extract<PrintModeEvent, { type: 'error' }> =>
        typeof chunk !== 'string' && chunk.type === 'error',
    )
    expect(errorEvents.length).toBe(0)
  })

  it('should parse input JSON string from AI SDK before validation', async () => {
    // The AI SDK can emit tool-call chunks with `input` as a raw JSON string
    // when upstream schema validation fails and the repair function returns
    // the original tool call unchanged. The stream parser should parse the
    // string into an object before handing it to the tool executor.
    const agentWithReadFiles: AgentTemplate = {
      ...testAgentTemplate,
      toolNames: ['read_files', 'end_turn'],
    }

    const stringInputToolCallChunk = {
      type: 'tool-call' as const,
      toolName: 'read_files',
      toolCallId: 'string-input-tool-call-id',
      input: JSON.stringify({ paths: ['test.ts'] }) as any,
    }

    async function* mockStream() {
      yield stringInputToolCallChunk
      return promptSuccess('mock-message-id')
    }

    const sessionState = getInitialSessionState(mockFileContext)
    const agentState = sessionState.mainAgentState

    agentRuntimeImpl.requestFiles = async () => ({
      'test.ts': 'console.log("test")',
    })

    const responseChunks: (string | PrintModeEvent)[] = []

    await processStream({
      ...agentRuntimeImpl,
      agentContext: {},
      agentState,
      agentStepId: 'test-step-id',
      agentTemplate: agentWithReadFiles,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: mockFileContext,
      fingerprintId: 'test-fingerprint',
      fullResponse: '',
      localAgentTemplates: { 'test-agent': agentWithReadFiles },
      messages: [],
      prompt: 'test prompt',
      repoId: undefined,
      repoUrl: undefined,
      runId: 'test-run-id',
      signal: new AbortController().signal,
      stream: mockStream(),
      system: 'test system',
      tools: {},
      userId: 'test-user',
      userInputId: 'test-input-id',
      onCostCalculated: async () => {},
      onResponseChunk: (chunk) => {
        responseChunks.push(chunk)
      },
    })

    const toolCallEvents = responseChunks.filter(
      (chunk): chunk is Extract<PrintModeEvent, { type: 'tool_call' }> =>
        typeof chunk !== 'string' && chunk.type === 'tool_call',
    )
    expect(toolCallEvents.length).toBe(1)
    expect(toolCallEvents[0].toolName).toBe('read_files')
    expect(toolCallEvents[0].input).toEqual({ paths: ['test.ts'] })

    const errorEvents = responseChunks.filter(
      (chunk): chunk is Extract<PrintModeEvent, { type: 'error' }> =>
        typeof chunk !== 'string' && chunk.type === 'error',
    )
    expect(errorEvents.length).toBe(0)
  })

  it('should emit a clear error when tool input is an unparseable string', async () => {
    const agentWithReadFiles: AgentTemplate = {
      ...testAgentTemplate,
      toolNames: ['read_files', 'end_turn'],
    }

    const invalidStringToolCallChunk = {
      type: 'tool-call' as const,
      toolName: 'read_files',
      toolCallId: 'invalid-string-tool-call-id',
      input: '{"paths": ["test.ts"' as any, // truncated/malformed JSON
    }

    async function* mockStream() {
      yield invalidStringToolCallChunk
      return promptSuccess('mock-message-id')
    }

    const sessionState = getInitialSessionState(mockFileContext)
    const agentState = sessionState.mainAgentState

    const responseChunks: (string | PrintModeEvent)[] = []

    const result = await processStream({
      ...agentRuntimeImpl,
      agentContext: {},
      agentState,
      agentStepId: 'test-step-id',
      agentTemplate: agentWithReadFiles,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: mockFileContext,
      fingerprintId: 'test-fingerprint',
      fullResponse: '',
      localAgentTemplates: { 'test-agent': agentWithReadFiles },
      messages: [],
      prompt: 'test prompt',
      repoId: undefined,
      repoUrl: undefined,
      runId: 'test-run-id',
      signal: new AbortController().signal,
      stream: mockStream(),
      system: 'test system',
      tools: {},
      userId: 'test-user',
      userInputId: 'test-input-id',
      onCostCalculated: async () => {},
      onResponseChunk: (chunk) => {
        responseChunks.push(chunk)
      },
    })

    const errorEvents = responseChunks.filter(
      (chunk): chunk is Extract<PrintModeEvent, { type: 'error' }> =>
        typeof chunk !== 'string' && chunk.type === 'error',
    )
    expect(errorEvents.length).toBe(1)
    expect(errorEvents[0].message).toContain(
      'expected the tool arguments to be an object, but received a string',
    )
    expect(errorEvents[0].message).toContain('Parsing as JSON failed:')
    expect(errorEvents[0].message).toContain('Original tool call input:')

    expect(result.hadToolCallError).toBe(true)

    const toolCallEvents = responseChunks.filter(
      (chunk): chunk is Extract<PrintModeEvent, { type: 'tool_call' }> =>
        typeof chunk !== 'string' && chunk.type === 'tool_call',
    )
    expect(toolCallEvents.length).toBe(0)
  })

  it('should preserve tool_call/tool_result ordering when custom tool setup is async', async () => {
    const toolName = 'delayed_custom_tool'
    const agentWithCustomTool: AgentTemplate = {
      ...testAgentTemplate,
      toolNames: [toolName, 'end_turn'],
    }

    const delayedToolCallChunk: StreamChunk = {
      type: 'tool-call',
      toolName,
      toolCallId: 'delayed-custom-tool-call-id',
      input: {
        query: 'test',
      },
    }

    async function* mockStream() {
      yield delayedToolCallChunk
      return promptSuccess('mock-message-id')
    }

    const fileContextWithCustomTool = {
      ...mockFileContext,
      customToolDefinitions: {
        [toolName]: {
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
            },
            required: ['query'],
            additionalProperties: false,
          },
          endsAgentStep: false,
          description: 'A delayed custom tool for ordering tests',
        },
      },
    }

    const sessionState = getInitialSessionState(fileContextWithCustomTool)
    const agentState = sessionState.mainAgentState

    agentRuntimeImpl.requestMcpToolData = async () => {
      // Force an async gap so tool_call emission happens after stream completion.
      await new Promise((resolve) => setTimeout(resolve, 20))
      return []
    }
    agentRuntimeImpl.requestToolCall = async () => ({
      output: jsonToolResult({ ok: true }),
    })

    await processStream({
      ...agentRuntimeImpl,
      agentContext: {},
      agentState,
      agentStepId: 'test-step-id',
      agentTemplate: agentWithCustomTool,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: fileContextWithCustomTool,
      fingerprintId: 'test-fingerprint',
      fullResponse: '',
      localAgentTemplates: { 'test-agent': agentWithCustomTool },
      messages: [],
      prompt: 'test prompt',
      repoId: undefined,
      repoUrl: undefined,
      runId: 'test-run-id',
      signal: new AbortController().signal,
      stream: mockStream(),
      system: 'test system',
      tools: {},
      userId: 'test-user',
      userInputId: 'test-input-id',
      onCostCalculated: async () => {},
      onResponseChunk: () => {},
    })

    const assistantToolCallMessages = agentState.messageHistory.filter(
      (m): m is AssistantMessage =>
        m.role === 'assistant' &&
        m.content.some(
          (c) => c.type === 'tool-call' && c.toolName === toolName,
        ),
    )
    const toolMessages = agentState.messageHistory.filter(
      (m): m is ToolMessage => m.role === 'tool' && m.toolName === toolName,
    )

    expect(assistantToolCallMessages.length).toBe(1)
    expect(toolMessages.length).toBe(1)

    const assistantToolCallPart = assistantToolCallMessages[0].content.find(
      (
        c,
      ): c is Extract<
        AssistantMessage['content'][number],
        { type: 'tool-call' }
      > => c.type === 'tool-call' && c.toolName === toolName,
    )
    expect(assistantToolCallPart).toBeDefined()
    expect(toolMessages[0].toolCallId).toBe(assistantToolCallPart!.toolCallId)

    const assistantIndex = agentState.messageHistory.indexOf(
      assistantToolCallMessages[0],
    )
    const toolResultIndex = agentState.messageHistory.indexOf(toolMessages[0])
    expect(assistantIndex).toBeGreaterThanOrEqual(0)
    expect(toolResultIndex).toBeGreaterThan(assistantIndex)

    const assistantToolCallIds = new Set(
      agentState.messageHistory.flatMap((message) => {
        if (message.role !== 'assistant') {
          return []
        }
        return message.content.flatMap((part) =>
          part.type === 'tool-call' ? [part.toolCallId] : [],
        )
      }),
    )
    const orphanToolResults = agentState.messageHistory.filter(
      (message): message is ToolMessage =>
        message.role === 'tool' &&
        !assistantToolCallIds.has(message.toolCallId),
    )
    expect(orphanToolResults.length).toBe(0)
  })
})
