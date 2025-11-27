import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { endsAgentStepParam } from '@codebuff/common/tools/constants'
import { getToolCallString } from '@codebuff/common/tools/utils'
import { beforeEach, describe, expect, it } from 'bun:test'

import { globalStopSequence } from '../constants'
import { processStreamWithTools } from '../tool-stream-parser'

import type { AgentRuntimeDeps } from '@codebuff/common/types/contracts/agent-runtime'

describe('processStreamWithTags', () => {
  async function* createMockStream(chunks: string[]) {
    for (const chunk of chunks) {
      yield { type: 'text' as const, text: chunk }
    }

    return 'mock-message-id'
  }

  let agentRuntimeImpl: AgentRuntimeDeps

  beforeEach(() => {
    agentRuntimeImpl = { ...TEST_AGENT_RUNTIME_IMPL }
  })

  it('should handle basic tool call parsing', async () => {
    const streamChunks = [
      '<codebuff_tool_call>\n{\n  "cb_tool_name": "test_tool",\n  "param1": "value1"\n}\n</codebuff_tool_call>',
    ]
    const stream = createMockStream(streamChunks)

    const events: any[] = []

    const processors = {
      test_tool: {
        params: ['param1'] as string[],
        onTagStart: (tagName: string, attributes: Record<string, string>) => {
          events.push({ tagName, type: 'start', attributes })
        },
        onTagEnd: (tagName: string, params: Record<string, string>) => {
          events.push({ tagName, type: 'end', params })
        },
      },
    }

    function onError(name: string, error: string) {
      events.push({ name, error })
    }

    const result: string[] = []
    const responseChunks: any[] = []

    function onResponseChunk(chunk: any) {
      responseChunks.push(chunk)
    }

    function defaultProcessor(toolName: string) {
      return {
        onTagStart: () => {},
        onTagEnd: () => {},
      }
    }

    for await (const chunk of processStreamWithTools({
      ...agentRuntimeImpl,
      stream,
      processors,
      defaultProcessor,
      onError,
      onResponseChunk,
    })) {
      if (chunk.type === 'text') {
        result.push(chunk.text)
      }
    }

    expect(events).toEqual([
      {
        tagName: 'test_tool',
        type: 'start',
        attributes: {},
      },
      {
        tagName: 'test_tool',
        type: 'end',
        params: { param1: 'value1' },
      },
    ])
    expect(result).toEqual(streamChunks)
  })

  it('should handle tool calls split across chunks', async () => {
    const streamChunks = [
      '<codebuff_tool_call>\n{\n  "cb_tool_name": "test',
      '_tool",\n  "param1": "val',
      'ue1"\n}\n</codebuff_tool_call>',
    ]
    const stream = createMockStream(streamChunks)

    const events: any[] = []

    const processors = {
      test_tool: {
        params: ['param1'] as string[],
        onTagStart: (tagName: string, attributes: Record<string, string>) => {
          events.push({ tagName, type: 'start', attributes })
        },
        onTagEnd: (tagName: string, params: Record<string, string>) => {
          events.push({ tagName, type: 'end', params })
        },
      },
    }

    function onError(name: string, error: string) {
      events.push({ name, error })
    }

    const result: string[] = []
    const responseChunks: any[] = []

    function onResponseChunk(chunk: any) {
      responseChunks.push(chunk)
    }

    function defaultProcessor(toolName: string) {
      return {
        onTagStart: () => {},
        onTagEnd: () => {},
      }
    }

    for await (const chunk of processStreamWithTools({
      ...agentRuntimeImpl,
      stream,
      processors,
      defaultProcessor,
      onError,
      onResponseChunk,
    })) {
      if (chunk.type === 'text') {
        result.push(chunk.text)
      }
    }

    expect(events).toEqual([
      {
        tagName: 'test_tool',
        type: 'start',
        attributes: {},
      },
      {
        tagName: 'test_tool',
        type: 'end',
        params: { param1: 'value1' },
      },
    ])
    expect(result).toEqual(streamChunks)
  })

  it('should handle multiple tool calls in sequence', async () => {
    const streamChunks = [
      '<codebuff_tool_call>\n{\n  "cb_tool_name": "tool1",\n  "param1": "value1"\n}\n</codebuff_tool_call>',
      'text between tools',
      '<codebuff_tool_call>\n{\n  "cb_tool_name": "tool2",\n  "param2": "value2"\n}\n</codebuff_tool_call>',
    ]
    const stream = createMockStream(streamChunks)

    const events: any[] = []

    const processors = {
      tool1: {
        params: ['param1'] as string[],
        onTagStart: (tagName: string, attributes: Record<string, string>) => {
          events.push({ tagName, type: 'start', attributes })
        },
        onTagEnd: (tagName: string, params: Record<string, string>) => {
          events.push({ tagName, type: 'end', params })
        },
      },
      tool2: {
        params: ['param2'] as string[],
        onTagStart: (tagName: string, attributes: Record<string, string>) => {
          events.push({ tagName, type: 'start', attributes })
        },
        onTagEnd: (tagName: string, params: Record<string, string>) => {
          events.push({ tagName, type: 'end', params })
        },
      },
    }

    function onError(name: string, error: string) {
      events.push({ name, error })
    }

    const result: string[] = []
    const responseChunks: any[] = []

    function onResponseChunk(chunk: any) {
      responseChunks.push(chunk)
    }

    function defaultProcessor(toolName: string) {
      return {
        onTagStart: () => {},
        onTagEnd: () => {},
      }
    }

    for await (const chunk of processStreamWithTools({
      ...agentRuntimeImpl,
      stream,
      processors,
      defaultProcessor,
      onError,
      onResponseChunk,
    })) {
      if (chunk.type === 'text') {
        result.push(chunk.text)
      }
    }

    expect(events).toEqual([
      {
        tagName: 'tool1',
        type: 'start',
        attributes: {},
      },
      {
        tagName: 'tool1',
        type: 'end',
        params: { param1: 'value1' },
      },
      {
        tagName: 'tool2',
        type: 'start',
        attributes: {},
      },
      {
        tagName: 'tool2',
        type: 'end',
        params: { param2: 'value2' },
      },
    ])
    expect(result).toEqual(streamChunks)
  })

  it('should handle malformed JSON and call onError', async () => {
    const streamChunks = [
      '<codebuff_tool_call>\n{\n  "cb_tool_name": "test_tool",\n  "param1": invalid_json\n}\n</codebuff_tool_call>',
    ]
    const stream = createMockStream(streamChunks)

    const events: any[] = []

    const processors = {
      test_tool: {
        params: ['param1'] as string[],
        onTagStart: (tagName: string, attributes: Record<string, string>) => {
          events.push({ tagName, type: 'start', attributes })
        },
        onTagEnd: (tagName: string, params: Record<string, string>) => {
          events.push({ tagName, type: 'end', params })
        },
      },
    }

    function onError(name: string, error: string) {
      events.push({ name, error, type: 'error' })
    }

    const result: string[] = []
    const responseChunks: any[] = []

    function onResponseChunk(chunk: any) {
      responseChunks.push(chunk)
    }

    function defaultProcessor(toolName: string) {
      return {
        onTagStart: () => {},
        onTagEnd: () => {},
      }
    }

    for await (const chunk of processStreamWithTools({
      ...agentRuntimeImpl,
      stream,
      processors,
      defaultProcessor,
      onError,
      onResponseChunk,
    })) {
      if (chunk.type === 'text') {
        result.push(chunk.text)
      }
    }

    expect(events).toEqual([
      {
        name: 'parse_error',
        error: expect.stringContaining('Unexpected identifier'),
        type: 'error',
      },
    ])
    expect(result).toEqual(streamChunks)
  })

  it('should handle unknown tool names and call onError', async () => {
    const streamChunks = [
      '<codebuff_tool_call>\n{\n  "cb_tool_name": "unknown_tool",\n  "param1": "value1"\n}\n</codebuff_tool_call>',
    ]
    const stream = createMockStream(streamChunks)

    const events: any[] = []

    const processors = {
      test_tool: {
        params: ['param1'] as string[],
        onTagStart: (tagName: string, attributes: Record<string, string>) => {
          events.push({ tagName, type: 'start', attributes })
        },
        onTagEnd: (tagName: string, params: Record<string, string>) => {
          events.push({ tagName, type: 'end', params })
        },
      },
    }

    function onError(name: string, error: string) {
      events.push({ name, error, type: 'error' })
    }

    const result: string[] = []
    const responseChunks: any[] = []

    function onResponseChunk(chunk: any) {
      responseChunks.push(chunk)
    }

    function defaultProcessor(toolName: string) {
      // For unknown tools, still return a processor but track the error
      events.push({
        name: toolName,
        error: `Tool not found: ${toolName}`,
        type: 'error',
      })
      return {
        onTagStart: () => {},
        onTagEnd: () => {},
      }
    }

    for await (const chunk of processStreamWithTools({
      ...agentRuntimeImpl,
      stream,
      processors,
      defaultProcessor,
      onError,
      onResponseChunk,
    })) {
      if (chunk.type === 'text') {
        result.push(chunk.text)
      }
    }

    expect(events).toEqual([
      {
        name: 'unknown_tool',
        error: 'Tool not found: unknown_tool',
        type: 'error',
      },
    ])
    expect(result).toEqual(streamChunks)
  })

  it('should handle tool calls with complex parameters', async () => {
    const streamChunks = [
      '<codebuff_tool_call>\n{\n  "cb_tool_name": "complex_tool",\n  "array_param": ["item1", "item2"],\n  "object_param": {"nested": "value"},\n  "boolean_param": true,\n  "number_param": 42\n}\n</codebuff_tool_call>',
    ]
    const stream = createMockStream(streamChunks)

    const events: any[] = []

    const processors = {
      complex_tool: {
        params: [
          'array_param',
          'object_param',
          'boolean_param',
          'number_param',
        ] as string[],
        onTagStart: (tagName: string, attributes: Record<string, string>) => {
          events.push({ tagName, type: 'start', attributes })
        },
        onTagEnd: (tagName: string, params: Record<string, any>) => {
          events.push({ tagName, type: 'end', params })
        },
      },
    }

    function onError(name: string, error: string) {
      events.push({ name, error, type: 'error' })
    }

    const result: string[] = []
    const responseChunks: any[] = []

    function onResponseChunk(chunk: any) {
      responseChunks.push(chunk)
    }

    function defaultProcessor(toolName: string) {
      return {
        onTagStart: () => {},
        onTagEnd: () => {},
      }
    }

    for await (const chunk of processStreamWithTools({
      ...agentRuntimeImpl,
      stream,
      processors,
      defaultProcessor,
      onError,
      onResponseChunk,
    })) {
      if (chunk.type === 'text') {
        result.push(chunk.text)
      }
    }

    expect(events).toEqual([
      {
        tagName: 'complex_tool',
        type: 'start',
        attributes: {},
      },
      {
        tagName: 'complex_tool',
        type: 'end',
        params: {
          array_param: ['item1', 'item2'],
          object_param: { nested: 'value' },
          boolean_param: true,
          number_param: 42,
        },
      },
    ])
    expect(result).toEqual(streamChunks)
  })

  it('should handle text content mixed with tool calls', async () => {
    const streamChunks = [
      'Some text before',
      '<codebuff_tool_call>\n{\n  "cb_tool_name": "test_tool",\n  "param1": "value1"\n}\n</codebuff_tool_call>',
      'Some text after',
    ]
    const stream = createMockStream(streamChunks)

    const events: any[] = []

    const processors = {
      test_tool: {
        params: ['param1'] as string[],
        onTagStart: (tagName: string, attributes: Record<string, string>) => {
          events.push({ tagName, type: 'start', attributes })
        },
        onTagEnd: (tagName: string, params: Record<string, string>) => {
          events.push({ tagName, type: 'end', params })
        },
      },
    }

    function onError(name: string, error: string) {
      events.push({ name, error, type: 'error' })
    }

    const result: string[] = []
    const responseChunks: any[] = []

    function onResponseChunk(chunk: any) {
      responseChunks.push(chunk)
    }

    function defaultProcessor(toolName: string) {
      return {
        onTagStart: () => {},
        onTagEnd: () => {},
      }
    }

    for await (const chunk of processStreamWithTools({
      ...agentRuntimeImpl,
      stream,
      processors,
      defaultProcessor,
      onError,
      onResponseChunk,
    })) {
      if (chunk.type === 'text') {
        result.push(chunk.text)
      }
    }

    expect(events).toEqual([
      {
        tagName: 'test_tool',
        type: 'start',
        attributes: {},
      },
      {
        tagName: 'test_tool',
        type: 'end',
        params: { param1: 'value1' },
      },
    ])
    expect(result).toEqual(streamChunks)
  })

  it('should handle incomplete tool calls at end of stream due to stop sequence', async () => {
    const streamChunks = [
      '<codebuff_tool_call>\n{\n  "cb_tool_name": "test_tool",\n  "param1": "value1",\n  ',
      // Missing closing tag
    ]
    const stream = createMockStream(streamChunks)

    const events: any[] = []

    const processors = {
      test_tool: {
        params: ['param1'] as string[],
        onTagStart: (tagName: string, attributes: Record<string, string>) => {
          events.push({ tagName, type: 'start', attributes })
        },
        onTagEnd: (tagName: string, params: Record<string, string>) => {
          events.push({ tagName, type: 'end', params })
        },
      },
    }

    function onError(name: string, error: string) {
      events.push({ name, error, type: 'error' })
    }

    const result: string[] = []
    const responseChunks: any[] = []

    function onResponseChunk(chunk: any) {
      responseChunks.push(chunk)
    }

    function defaultProcessor(toolName: string) {
      return {
        onTagStart: () => {},
        onTagEnd: () => {},
      }
    }

    for await (const chunk of processStreamWithTools({
      ...agentRuntimeImpl,
      stream,
      processors,
      defaultProcessor,
      onError,
      onResponseChunk,
    })) {
      if (chunk.type === 'text') {
        result.push(chunk.text)
      }
    }

    // Should complete the tool call with the completion suffix
    expect(events).toEqual([
      {
        tagName: 'test_tool',
        type: 'start',
        attributes: {},
      },
      {
        tagName: 'test_tool',
        type: 'end',
        params: { param1: 'value1', [endsAgentStepParam]: true },
      },
    ])

    // Should include the completion suffix in the result
    expect(result.join('')).toContain(globalStopSequence)
  })

  it('should handle empty stream', async () => {
    const streamChunks: string[] = []
    const stream = createMockStream(streamChunks)

    const events: any[] = []

    const processors = {}

    function onError(name: string, error: string) {
      events.push({ name, error, type: 'error' })
    }

    const result: string[] = []
    const responseChunks: any[] = []

    function onResponseChunk(chunk: any) {
      responseChunks.push(chunk)
    }

    function defaultProcessor(toolName: string) {
      return {
        onTagStart: () => {},
        onTagEnd: () => {},
      }
    }

    for await (const chunk of processStreamWithTools({
      ...agentRuntimeImpl,
      stream,
      processors,
      defaultProcessor,
      onError,
      onResponseChunk,
    })) {
      if (chunk.type === 'text') {
        result.push(chunk.text)
      }
    }

    expect(events).toEqual([])
    expect(result).toEqual([])
  })

  it('should handle stream with only text content', async () => {
    const streamChunks = ['Just some text', ' with no tool calls']
    const stream = createMockStream(streamChunks)

    const events: any[] = []

    const processors = {}

    function onError(name: string, error: string) {
      events.push({ name, error, type: 'error' })
    }

    const result: string[] = []
    const responseChunks: any[] = []

    function onResponseChunk(chunk: any) {
      responseChunks.push(chunk)
    }

    function defaultProcessor(toolName: string) {
      return {
        onTagStart: () => {},
        onTagEnd: () => {},
      }
    }

    for await (const chunk of processStreamWithTools({
      ...agentRuntimeImpl,
      stream,
      processors,
      defaultProcessor,
      onError,
      onResponseChunk,
    })) {
      if (chunk.type === 'text') {
        result.push(chunk.text)
      }
    }

    expect(events).toEqual([])
    expect(result).toEqual(streamChunks)
  })

  it('should handle tool call with missing cb_tool_name', async () => {
    const streamChunks = [
      '<codebuff_tool_call>\n{\n  "param1": "value1"\n}\n</codebuff_tool_call>',
    ]
    const stream = createMockStream(streamChunks)

    const events: any[] = []

    const processors = {
      test_tool: {
        params: ['param1'] as string[],
        onTagStart: (tagName: string, attributes: Record<string, string>) => {
          events.push({ tagName, type: 'start', attributes })
        },
        onTagEnd: (tagName: string, params: Record<string, string>) => {
          events.push({ tagName, type: 'end', params })
        },
      },
    }

    function onError(name: string, error: string) {
      events.push({ name, error, type: 'error' })
    }

    const result: string[] = []
    const responseChunks: any[] = []

    function onResponseChunk(chunk: any) {
      responseChunks.push(chunk)
    }

    function defaultProcessor(toolName: string) {
      // Track when defaultProcessor is called (which means tool not found in processors)
      events.push({
        name: toolName,
        error: `Tool not found: ${toolName}`,
        type: 'error',
      })
      return {
        onTagStart: () => {},
        onTagEnd: () => {},
      }
    }

    for await (const chunk of processStreamWithTools({
      ...agentRuntimeImpl,
      stream,
      processors,
      defaultProcessor,
      onError,
      onResponseChunk,
    })) {
      if (chunk.type === 'text') {
        result.push(chunk.text)
      }
    }

    expect(events).toEqual([
      {
        name: 'parse_error',
        error:
          'Unknown tool undefined for tool call: {\n  "param1": "value1"\n}',
        type: 'error',
      },
    ])
    expect(result).toEqual(streamChunks)
  })

  describe('real world examples', () => {
    it('should handle </codebuff_tool_call> within tool contents', async () => {
      const toolName = 'write_file'
      const streamChunks = [
        getToolCallString(toolName, {
          path: 'backend/src/__tests__/xml-stream-parser.test.ts',
          instructions:
            'Write comprehensive unit tests for the processStreamWithTags function',
          content:
            "import { describe, expect, it } from 'bun:test'\nimport { toolSchema } from '@codebuff/common/constants/tools'\nimport { processStreamWithTags } from '../xml-stream-parser'\n\ndescribe('processStreamWithTags', () => {\n  async function* createMockStream(chunks: string[]) {\n    for (const chunk of chunks) {\n      yield chunk\n    }\n  }\n\n  it('should handle basic tool call parsing', async () => {\n    const streamChunks = [\n      '<codebuff_tool_call>\\n{\\n  \"cb_tool_name\": \"test_tool\",\\n  \"param1\": \"value1\"\\n}\\n</codebuff_tool_call>',\n    ]\n    const stream = createMockStream(streamChunks)\n\n    const events: any[] = []\n\n    const processors = {\n      test_tool: {\n        params: ['param1'] as string[],\n        onTagStart: (tagName: string, attributes: Record<string, string>) => {\n          events.push({ tagName, type: 'start', attributes })\n        },\n        onTagEnd: (tagName: string, params: Record<string, string>) => {\n          events.push({ tagName, type: 'end', params })\n        },\n      },\n    }\n\n    function onError(name: string, error: string) {\n      events.push({ name, error })\n    }\n\n    const result = []\n    for await (const chunk of processStreamWithTags(\n      stream,\n      processors,\n      onError\n    )) {\n      result.push(chunk)\n    }\n\n    expect(events).toEqual([\n      {\n        tagName: 'test_tool',\n        type: 'start',\n        attributes: {},\n      },\n      {\n        tagName: 'test_tool',\n        type: 'end',\n        params: { param1: 'value1' },\n      },\n    ])\n    expect(result).toEqual(streamChunks)\n  })\n\n  it('should handle tool calls split across chunks', async () => {\n    const streamChunks = [\n      '<codebuff_tool_call>\\n{\\n  \"cb_tool_name\": \"test',\n      '_tool\",\\n  \"param1\": \"val',\n      'ue1\"\\n}\\n</codebuff_tool_call>',\n    ]\n    const stream = createMockStream(streamChunks)\n\n    const events: any[] = []\n\n    const processors = {\n      test_tool: {\n        params: ['param1'] as string[],\n        onTagStart: (tagName: string, attributes: Record<string, string>) => {\n          events.push({ tagName, type: 'start', attributes })\n        },\n        onTagEnd: (tagName: string, params: Record<string, string>) => {\n          events.push({ tagName, type: 'end', params })\n        },\n      },\n    }\n\n    function onError(name: string, error: string) {\n      events.push({ name, error })\n    }\n\n    const result = []\n    for await (const chunk of processStreamWithTags(\n      stream,\n      processors,\n      onError\n    )) {\n      result.push(chunk)\n    }\n\n    expect(events).toEqual([\n      {\n        tagName: 'test_tool',\n        type: 'start',\n        attributes: {},\n      },\n      {\n        tagName: 'test_tool',\n        type: 'end',\n        params: { param1: 'value1' },\n      },\n    ])\n    expect(result).toEqual(streamChunks)\n  })\n\n  it('should handle multiple tool calls in sequence', async () => {\n    const streamChunks = [\n      '<codebuff_tool_call>\\n{\\n  \"cb_tool_name\": \"tool1\",\\n  \"param1\": \"value1\"\\n}\\n</codebuff_tool_call>',\n      'text between tools',\n      '<codebuff_tool_call>\\n{\\n  \"cb_tool_name\": \"tool2\",\\n  \"param2\": \"value2\"\\n}\\n</codebuff_tool_call>',\n    ]\n    const stream = createMockStream(streamChunks)\n\n    const events: any[] = []\n\n    const processors = {\n      tool1: {\n        params: ['param1'] as string[],\n        onTagStart: (tagName: string, attributes: Record<string, string>) => {\n          events.push({ tagName, type: 'start', attributes })\n        },\n        onTagEnd: (tagName: string, params: Record<string, string>) => {\n          events.push({ tagName, type: 'end', params })\n        },\n      },\n      tool2: {\n        params: ['param2'] as string[],\n        onTagStart: (tagName: string, attributes: Record<string, string>) => {\n          events.push({ tagName, type: 'start', attributes })\n        },\n        onTagEnd: (tagName: string, params: Record<string, string>) => {\n          events.push({ tagName, type: 'end', params })\n        },\n      },\n    }\n\n    function onError(name: string, error: string) {\n      events.push({ name, error })\n    }\n\n    const result = []\n    for await (const chunk of processStreamWithTags(\n      stream,\n      processors,\n      onError\n    )) {\n      result.push(chunk)\n    }\n\n    expect(events).toEqual([\n      {\n        tagName: 'tool1',\n        type: 'start',\n        attributes: {},\n      },\n      {\n        tagName: 'tool1',\n        type: 'end',\n        params: { param1: 'value1' },\n      },\n      {\n        tagName: 'tool2',\n        type: 'start',\n        attributes: {},\n      },\n      {\n        tagName: 'tool2',\n        type: 'end',\n        params: { param2: 'value2' },\n      },\n    ])\n    expect(result).toEqual(streamChunks)\n  })\n\n  it('should handle malformed JSON and call onError', async () => {\n    const streamChunks = [\n      '<codebuff_tool_call>\\n{\\n  \"cb_tool_name\": \"test_tool\",\\n  \"param1\": invalid_json\\n}\\n</codebuff_tool_call>',\n    ]\n    const stream = createMockStream(streamChunks)\n\n    const events: any[] = []\n\n    const processors = {\n      test_tool: {\n        params: ['param1'] as string[],\n        onTagStart: (tagName: string, attributes: Record<string, string>) => {\n          events.push({ tagName, type: 'start', attributes })\n        },\n        onTagEnd: (tagName: string, params: Record<string, string>) => {\n          events.push({ tagName, type: 'end', params })\n        },\n      },\n    }\n\n    function onError(name: string, error: string) {\n      events.push({ name, error, type: 'error' })\n    }\n\n    const result = []\n    for await (const chunk of processStreamWithTags(\n      stream,\n      processors,\n      onError\n    )) {\n      result.push(chunk)\n    }\n\n    expect(events).toEqual([\n      {\n        name: 'parse_error',\n        error: expect.stringContaining('Unexpected token'),\n        type: 'error',\n      },\n    ])\n    expect(result).toEqual(streamChunks)\n  })\n\n  it('should handle unknown tool names and call onError', async () => {\n    const streamChunks = [\n      '<codebuff_tool_call>\\n{\\n  \"cb_tool_name\": \"unknown_tool\",\\n  \"param1\": \"value1\"\\n}\\n</codebuff_tool_call>',\n    ]\n    const stream = createMockStream(streamChunks)\n\n    const events: any[] = []\n\n    const processors = {\n      test_tool: {\n        params: ['param1'] as string[],\n        onTagStart: (tagName: string, attributes: Record<string, string>) => {\n          events.push({ tagName, type: 'start', attributes })\n        },\n        onTagEnd: (tagName: string, params: Record<string, string>) => {\n          events.push({ tagName, type: 'end', params })\n        },\n      },\n    }\n\n    function onError(name: string, error: string) {\n      events.push({ name, error, type: 'error' })\n    }\n\n    const result = []\n    for await (const chunk of processStreamWithTags(\n      stream,\n      processors,\n      onError\n    )) {\n      result.push(chunk)\n    }\n\n    expect(events).toEqual([\n      {\n        name: 'unknown_tool',\n        error: 'Tool not found: unknown_tool',\n        type: 'error',\n      },\n    ])\n    expect(result).toEqual(streamChunks)\n  })\n\n  it('should handle tool calls with complex parameters', async () => {\n    const streamChunks = [\n      '<codebuff_tool_call>\\n{\\n  \"cb_tool_name\": \"complex_tool\",\\n  \"array_param\": [\"item1\", \"item2\"],\\n  \"object_param\": {\"nested\": \"value\"},\\n  \"boolean_param\": true,\\n  \"number_param\": 42\\n}\\n</codebuff_tool_call>',\n    ]\n    const stream = createMockStream(streamChunks)\n\n    const events: any[] = []\n\n    const processors = {\n      complex_tool: {\n        params: ['array_param', 'object_param', 'boolean_param', 'number_param'] as string[],\n        onTagStart: (tagName: string, attributes: Record<string, string>) => {\n          events.push({ tagName, type: 'start', attributes })\n        },\n        onTagEnd: (tagName: string, params: Record<string, any>) => {\n          events.push({ tagName, type: 'end', params })\n        },\n      },\n    }\n\n    function onError(name: string, error: string) {\n      events.push({ name, error, type: 'error' })\n    }\n\n    const result = []\n    for await (const chunk of processStreamWithTags(\n      stream,\n      processors,\n      onError\n    )) {\n      result.push(chunk)\n    }\n\n    expect(events).toEqual([\n      {\n        tagName: 'complex_tool',\n        type: 'start',\n        attributes: {},\n      },\n      {\n        tagName: 'complex_tool',\n        type: 'end',\n        params: {\n          array_param: ['item1', 'item2'],\n          object_param: { nested: 'value' },\n          boolean_param: true,\n          number_param: 42,\n        },\n      },\n    ])\n    expect(result).toEqual(streamChunks)\n  })\n\n  it('should handle text content mixed with tool calls', async () => {\n    const streamChunks = [\n      'Some text before',\n      '<codebuff_tool_call>\\n{\\n  \"cb_tool_name\": \"test_tool\",\\n  \"param1\": \"value1\"\\n}\\n</codebuff_tool_call>',\n      'Some text after',\n    ]\n    const stream = createMockStream(streamChunks)\n\n    const events: any[] = []\n\n    const processors = {\n      test_tool: {\n        params: ['param1'] as string[],\n        onTagStart: (tagName: string, attributes: Record<string, string>) => {\n          events.push({ tagName, type: 'start', attributes })\n        },\n        onTagEnd: (tagName: string, params: Record<string, string>) => {\n          events.push({ tagName, type: 'end', params })\n        },\n      },\n    }\n\n    function onError(name: string, error: string) {\n      events.push({ name, error, type: 'error' })\n    }\n\n    const result = []\n    for await (const chunk of processStreamWithTags(\n      stream,\n      processors,\n      onError\n    )) {\n      result.push(chunk)\n    }\n\n    expect(events).toEqual([\n      {\n        tagName: 'test_tool',\n        type: 'start',\n        attributes: {},\n      },\n      {\n        tagName: 'test_tool',\n        type: 'end',\n        params: { param1: 'value1' },\n      },\n    ])\n    expect(result).toEqual(streamChunks)\n  })\n\n  it('should handle incomplete tool calls at end of stream', async () => {\n    const streamChunks = [\n      '<codebuff_tool_call>\\n{\\n  \"cb_tool_name\": \"test_tool\",\\n  \"param1\": \"value1\"\\n}',\n      // Missing closing tag\n    ]\n    const stream = createMockStream(streamChunks)\n\n    const events: any[] = []\n\n    const processors = {\n      test_tool: {\n        params: ['param1'] as string[],\n        onTagStart: (tagName: string, attributes: Record<string, string>) => {\n          events.push({ tagName, type: 'start', attributes })\n        },\n        onTagEnd: (tagName: string, params: Record<string, string>) => {\n          events.push({ tagName, type: 'end', params })\n        },\n      },\n    }\n\n    function onError(name: string, error: string) {\n      events.push({ name, error, type: 'error' })\n    }\n\n    const result = []\n    for await (const chunk of processStreamWithTags(\n      stream,\n      processors,\n      onError\n    )) {\n      result.push(chunk)\n    }\n\n    // Should complete the tool call with the completion suffix\n    expect(events).toEqual([\n      {\n        tagName: 'test_tool',\n        type: 'start',\n        attributes: {},\n      },\n      {\n        tagName: 'test_tool',\n        type: 'end',\n        params: { param1: 'value1' },\n      },\n    ])\n    \n    // Should include the completion suffix in the result\n    expect(result.join('')).toContain('\"codebuff_easp\": true')\n  })\n\n  it('should handle empty stream', async () => {\n    const streamChunks: string[] = []\n    const stream = createMockStream(streamChunks)\n\n    const events: any[] = []\n\n    const processors = {}\n\n    function onError(name: string, error: string) {\n      events.push({ name, error, type: 'error' })\n    }\n\n    const result = []\n    for await (const chunk of processStreamWithTags(\n      stream,\n      processors,\n      onError\n    )) {\n      result.push(chunk)\n    }\n\n    expect(events).toEqual([])\n    expect(result).toEqual([])\n  })\n\n  it('should handle stream with only text content', async () => {\n    const streamChunks = ['Just some text', ' with no tool calls']\n    const stream = createMockStream(streamChunks)\n\n    const events: any[] = []\n\n    const processors = {}\n\n    function onError(name: string, error: string) {\n      events.push({ name, error, type: 'error' })\n    }\n\n    const result = []\n    for await (const chunk of processStreamWithTags(\n      stream,\n      processors,\n      onError\n    )) {\n      result.push(chunk)\n    }\n\n    expect(events).toEqual([])\n    expect(result).toEqual(streamChunks)\n  })\n\n  it('should handle tool call with missing cb_tool_name', async () => {\n    const streamChunks = [\n      '<codebuff_tool_call>\\n{\\n  \"param1\": \"value1\"\\n}\\n</codebuff_tool_call>',\n    ]\n    const stream = createMockStream(streamChunks)\n\n    const events: any[] = []\n\n    const processors = {\n      test_tool: {\n        params: ['param1'] as string[],\n        onTagStart: (tagName: string, attributes: Record<string, string>) => {\n          events.push({ tagName, type: 'start', attributes })\n        },\n        onTagEnd: (tagName: string, params: Record<string, string>) => {\n          events.push({ tagName, type: 'end', params })\n        },\n      },\n    }\n\n    function onError(name: string, error: string) {\n      events.push({ name, error, type: 'error' })\n    }\n\n    const result = []\n    for await (const chunk of processStreamWithTags(\n      stream,\n      processors,\n      onError\n    )) {\n      result.push(chunk)\n    }\n\n    expect(events).toEqual([\n      {\n        name: 'undefined',\n        error: 'Tool not found: undefined',\n        type: 'error',\n      },\n    ])\n    expect(result).toEqual(streamChunks)\n  })\n})",
        }),
      ]

      const stream = createMockStream(streamChunks)

      const events: any[] = []

      const processors = {
        write_file: {
          params: ['path', 'instructions', 'content'] as string[],
          onTagStart: (tagName: string, attributes: Record<string, string>) => {
            events.push({ tagName, type: 'start', attributes })
          },
          onTagEnd: (tagName: string, params: Record<string, string>) => {
            events.push({ tagName, type: 'end', params })
          },
        },
      }

      function onError(name: string, error: string) {
        events.push({ name, error })
      }

      const result: string[] = []
      const responseChunks: any[] = []

      function onResponseChunk(chunk: any) {
        responseChunks.push(chunk)
      }

      function defaultProcessor(toolName: string) {
        return {
          onTagStart: () => {},
          onTagEnd: () => {},
        }
      }

      for await (const chunk of processStreamWithTools({
        ...agentRuntimeImpl,
        stream,
        processors,
        defaultProcessor,
        onError,
        onResponseChunk,
      })) {
        if (chunk.type === 'text') {
          result.push(chunk.text)
        }
      }

      expect(events).toEqual([
        {
          attributes: {},
          tagName: 'write_file',
          type: 'start',
        },
        {
          params: {
            content: expect.stringContaining('<codebuff_tool_call>'),
            instructions:
              'Write comprehensive unit tests for the processStreamWithTags function',
            path: 'backend/src/__tests__/xml-stream-parser.test.ts',
          },
          tagName: 'write_file',
          type: 'end',
        },
      ])
      expect(result).toEqual(streamChunks)
    })
  })
})
