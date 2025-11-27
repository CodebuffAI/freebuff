import * as bigquery from '@codebuff/bigquery'
import * as analytics from '@codebuff/common/analytics'
import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getToolCallString } from '@codebuff/common/tools/utils'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import * as stringUtils from '@codebuff/common/util/string'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'

import { mockFileContext } from './test-utils'
import { processStream } from '../tools/stream-parser'

import type { AgentTemplate } from '../templates/types'
import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
} from '@codebuff/common/types/contracts/agent-runtime'
import type { ParamsOf } from '@codebuff/common/types/function-params'
import type {
  Message,
  ToolMessage,
} from '@codebuff/common/types/messages/codebuff-message'

let agentRuntimeImpl: AgentRuntimeDeps = { ...TEST_AGENT_RUNTIME_IMPL }

describe('malformed tool call error handling', () => {
  let testAgent: AgentTemplate
  let agentRuntimeImpl: AgentRuntimeDeps & AgentRuntimeScopedDeps
  let defaultParams: ParamsOf<typeof processStream>

  beforeEach(() => {
    agentRuntimeImpl = { ...TEST_AGENT_RUNTIME_IMPL }

    testAgent = {
      id: 'test-agent',
      displayName: 'Test Agent',
      spawnerPrompt: 'Testing malformed tool calls',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'all_messages' as const,
      includeMessageHistory: true,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['read_files', 'end_turn'],
      spawnableAgents: [],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test instructions prompt',
      stepPrompt: 'Test agent step prompt',
    }

    const sessionState = getInitialSessionState(mockFileContext)
    const agentState = sessionState.mainAgentState

    defaultParams = {
      ...agentRuntimeImpl,
      stream: createMockStream([]),
      runId: 'test-run-id',
      ancestorRunIds: [],
      agentStepId: 'test-step',
      clientSessionId: 'test-session',
      fingerprintId: 'test-fingerprint',
      userInputId: 'test-input',
      userId: TEST_USER_ID,
      repoId: 'test-repo',
      repoUrl: undefined,
      agentTemplate: testAgent,
      agentState,
      localAgentTemplates: { 'test-agent': testAgent },
      fileContext: mockFileContext,
      messages: [],
      system: 'Test system prompt',
      agentContext: {},
      onResponseChunk: mock(() => {}),
      onCostCalculated: mock(async () => {}),
      fullResponse: '',
      prompt: '',
      signal: new AbortController().signal,
    }

    // Mock analytics and tracing
    spyOn(analytics, 'initAnalytics').mockImplementation(() => {})
    analytics.initAnalytics(TEST_AGENT_RUNTIME_IMPL)
    spyOn(analytics, 'trackEvent').mockImplementation(() => {})
    spyOn(bigquery, 'insertTrace').mockImplementation(() =>
      Promise.resolve(true),
    )

    // Mock websocket actions
    agentRuntimeImpl.requestFiles = async () => ({})
    agentRuntimeImpl.requestOptionalFile = async () => null
    agentRuntimeImpl.requestToolCall = async () => ({
      output: [
        {
          type: 'json',
          value: 'Tool call success',
        },
      ],
    })

    // Mock LLM APIs
    agentRuntimeImpl.promptAiSdk = async function () {
      return 'Test response'
    }

    // Mock generateCompactId for consistent test results
    spyOn(stringUtils, 'generateCompactId').mockReturnValue('test-tool-call-id')
  })

  afterEach(() => {
    mock.restore()
    agentRuntimeImpl = { ...TEST_AGENT_RUNTIME_IMPL }
  })

  function createMockStream(chunks: string[]) {
    async function* generator() {
      for (const chunk of chunks) {
        yield { type: 'text' as const, text: chunk }
      }
      return 'mock-message-id'
    }
    return generator()
  }

  test('should add tool result errors to message history after stream completes', async () => {
    const chunks = [
      // Malformed JSON tool call
      '<codebuff_tool_call>\n{\n  "cb_tool_name": "read_files",\n  "paths": ["test.ts"\n}\n</codebuff_tool_call>',
      // Valid end turn
      getToolCallString('end_turn', {}),
    ]

    const stream = createMockStream(chunks)

    await processStream({
      ...defaultParams,
      stream,
    })

    // Should have tool result errors in the final message history
    const toolMessages: ToolMessage[] =
      defaultParams.agentState.messageHistory.filter(
        (m: Message) => m.role === 'tool',
      )

    expect(toolMessages.length).toBeGreaterThan(0)

    // Find the error tool result
    const errorToolResult = toolMessages.find(
      (m) =>
        m.content?.[0]?.type === 'json' &&
        (m.content[0] as any)?.value?.errorMessage,
    )

    expect(errorToolResult).toBeDefined()
    expect(
      (errorToolResult?.content?.[0] as any)?.value?.errorMessage,
    ).toContain('Invalid JSON')
  })

  test('should handle multiple malformed tool calls', async () => {
    const chunks = [
      // First malformed call
      '<codebuff_tool_call>\n{\n  "cb_tool_name": "read_files",\n  invalid\n}\n</codebuff_tool_call>',
      'Some text between calls',
      // Second malformed call
      '<codebuff_tool_call>\n{\n  missing_quotes: value\n}\n</codebuff_tool_call>',
      getToolCallString('end_turn', {}),
    ]

    const stream = createMockStream(chunks)

    await processStream({
      ...defaultParams,
      stream,
    })

    // Should have multiple error tool results
    const toolMessages = defaultParams.agentState.messageHistory.filter(
      (m: Message) => m.role === 'tool',
    ) as ToolMessage[]

    const errorMessages = toolMessages.filter(
      (m) =>
        m.content?.[0]?.type === 'json' &&
        (m.content[0] as any)?.value?.errorMessage,
    )

    expect(errorMessages.length).toBe(2)
  })

  test('should preserve original toolResults array alongside message history', async () => {
    const chunks = [
      '<codebuff_tool_call>\n{\n  "cb_tool_name": "read_files",\n  malformed\n}\n</codebuff_tool_call>',
      getToolCallString('end_turn', {}),
    ]

    const stream = createMockStream(chunks)

    const result = await processStream({
      ...defaultParams,
      stream,
    })

    // Should have error in both toolResults and message history
    expect(result.toolResults.length).toBeGreaterThan(0)

    const errorToolResult = result.toolResults.find(
      (tr) =>
        tr.content?.[0]?.type === 'json' &&
        (tr.content[0] as any)?.value?.errorMessage,
    )

    expect(errorToolResult).toBeDefined()

    const toolMessages = defaultParams.agentState.messageHistory.filter(
      (m: Message) => m.role === 'tool',
    ) as ToolMessage[]

    expect(toolMessages.length).toBeGreaterThan(0)
  })

  test('should handle unknown tool names and add error to message history', async () => {
    const chunks = [
      '<codebuff_tool_call>\n{\n  "cb_tool_name": "unknown_tool",\n  "param": "value"\n}\n</codebuff_tool_call>',
      getToolCallString('end_turn', {}),
    ]

    const stream = createMockStream(chunks)

    await processStream({
      ...defaultParams,
      stream,
    })

    const toolMessages = defaultParams.agentState.messageHistory.filter(
      (m: Message) => m.role === 'tool',
    ) as ToolMessage[]

    const errorMessage = toolMessages.find(
      (m) =>
        m.toolName === 'unknown_tool' &&
        m.content?.[0]?.type === 'json' &&
        (m.content[0] as any)?.value?.errorMessage,
    )

    expect(errorMessage).toBeDefined()
    expect((errorMessage?.content?.[0] as any)?.value?.errorMessage).toContain(
      'Tool unknown_tool not found',
    )
  })

  test('should not affect valid tool calls in message history', async () => {
    const chunks = [
      // Valid tool call
      getToolCallString('read_files', { paths: ['test.ts'] }),
      // Malformed tool call
      '<codebuff_tool_call>\n{\n  "cb_tool_name": "read_files",\n  invalid\n}\n</codebuff_tool_call>',
      getToolCallString('end_turn', {}),
    ]

    const stream = createMockStream(chunks)

    await processStream({
      ...defaultParams,
      requestFiles: async ({ filePaths }) => {
        return Object.fromEntries(
          filePaths.map((path) => [path, `${path} content`]),
        )
      },
      stream,
    })

    const toolMessages = defaultParams.agentState.messageHistory.filter(
      (m: Message) => m.role === 'tool',
    ) as ToolMessage[]

    // Should have both valid and error tool results
    const validResults = toolMessages.filter(
      (m) =>
        m.toolName === 'read_files' &&
        !(m.content?.[0] as any)?.value?.errorMessage,
    )

    const errorResults = toolMessages.filter(
      (m) =>
        m.content?.[0]?.type === 'json' &&
        (m.content[0] as any)?.value?.errorMessage,
    )

    expect(validResults.length).toBeGreaterThan(0)
    expect(errorResults.length).toBeGreaterThan(0)
  })

  test('should handle stream with only malformed calls', async () => {
    const chunks = [
      '<codebuff_tool_call>\n{\n  invalid1\n}\n</codebuff_tool_call>',
      '<codebuff_tool_call>\n{\n  invalid2\n}\n</codebuff_tool_call>',
    ]

    const stream = createMockStream(chunks)

    await processStream({
      ...defaultParams,
      stream,
    })

    const toolMessages = defaultParams.agentState.messageHistory.filter(
      (m: Message) => m.role === 'tool',
    ) as ToolMessage[]

    expect(toolMessages.length).toBe(2)
    toolMessages.forEach((msg) => {
      expect(msg.content?.[0]?.type).toBe('json')
      expect((msg.content?.[0] as any)?.value?.errorMessage).toContain(
        'Invalid JSON',
      )
    })
  })
})
