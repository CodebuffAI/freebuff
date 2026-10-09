/**
 * Typed stream mock factory for testing LLM streaming.
 *
 * Provides type-safe utilities for creating mock LLM streams
 * and testing streaming behavior.
 *
 * @example
 * ```typescript
 * import { createMockStream, createToolCallChunk } from '@codebuff/common/testing/mocks/stream'
 *
 * // Create a mock stream with text and tool calls
 * const stream = createMockStream([
 *   { type: 'text', text: 'Hello ' },
 *   { type: 'text', text: 'world!' },
 *   createToolCallChunk('end_turn', {}),
 * ])
 *
 * // Use in tests
 * for await (const chunk of stream) {
 *   console.log(chunk)
 * }
 * ```
 */

import { mock } from 'bun:test'

import type { Mock } from 'bun:test'

/**
 * A text chunk from an LLM stream.
 */
export interface TextChunk {
  type: 'text'
  text: string
  agentId?: string
}

/**
 * A tool call chunk from an LLM stream.
 */
export interface ToolCallChunk {
  type: 'tool-call'
  toolName: string
  toolCallId: string
  input: Record<string, unknown>
}

/**
 * A reasoning chunk from an LLM stream.
 */
export interface ReasoningChunk {
  type: 'reasoning'
  text: string
}

/**
 * Union of all stream chunk types.
 */
export type StreamChunk = TextChunk | ToolCallChunk | ReasoningChunk

/**
 * Options for creating a tool call chunk.
 */
export interface CreateToolCallOptions {
  /**
   * Custom tool call ID. If not provided, a random one is generated.
   */
  toolCallId?: string
}

let toolCallIdCounter = 0

/**
 * Creates a tool call chunk for testing.
 *
 * @param toolName - The name of the tool being called
 * @param input - The input parameters for the tool
 * @param options - Additional options
 * @returns A properly typed tool call chunk
 *
 * @example
 * ```typescript
 * const chunk = createToolCallChunk('read_files', { paths: ['file.ts'] })
 * // { type: 'tool-call', toolName: 'read_files', toolCallId: 'tool-call-1', input: { paths: ['file.ts'] } }
 * ```
 */
export function createToolCallChunk(
  toolName: string,
  input: Record<string, unknown>,
  options: CreateToolCallOptions = {},
): ToolCallChunk {
  const { toolCallId = `tool-call-${++toolCallIdCounter}` } = options
  return {
    type: 'tool-call',
    toolName,
    toolCallId,
    input,
  }
}

/**
 * Creates a text chunk for testing.
 *
 * @param text - The text content
 * @param agentId - Optional agent ID for subagent chunks
 * @returns A text chunk
 *
 * @example
 * ```typescript
 * const chunk = createTextChunk('Hello world!')
 * // { type: 'text', text: 'Hello world!' }
 * ```
 */
export function createTextChunk(text: string, agentId?: string): TextChunk {
  const chunk: TextChunk = { type: 'text', text }
  if (agentId) {
    chunk.agentId = agentId
  }
  return chunk
}

/**
 * Creates a mock async generator that yields the provided chunks.
 *
 * @param chunks - The chunks to yield
 * @param returnValue - The value to return when the generator completes
 * @returns An async generator that yields the chunks
 *
 * @example
 * ```typescript
 * const stream = createMockStream([
 *   createTextChunk('Processing...'),
 *   createToolCallChunk('read_files', { paths: ['test.ts'] }),
 *   createTextChunk('Done!'),
 *   createToolCallChunk('end_turn', {}),
 * ])
 *
 * // Consume the stream
 * const chunks = []
 * for await (const chunk of stream) {
 *   chunks.push(chunk)
 * }
 * ```
 */
export function createMockStream(
  chunks: StreamChunk[],
  returnValue: string | null = 'mock-message-id',
): AsyncGenerator<StreamChunk, string | null, undefined> {
  async function* generator(): AsyncGenerator<
    StreamChunk,
    string | null,
    undefined
  > {
    for (const chunk of chunks) {
      yield chunk
    }
    return returnValue
  }
  return generator()
}

/**
 * Creates a mock stream that yields text in multiple chunks.
 * Useful for testing streaming text display.
 *
 * @param text - The complete text to stream
 * @param chunkSize - Size of each chunk
 * @param endWithTool - Whether to end with an end_turn tool call
 * @returns A mock stream
 *
 * @example
 * ```typescript
 * const stream = createMockTextStream('Hello world!', 3)
 * // Yields: 'Hel', 'lo ', 'wor', 'ld!'
 * ```
 */
export function createMockTextStream(
  text: string,
  chunkSize: number = 10,
  endWithTool: boolean = true,
): AsyncGenerator<StreamChunk, string | null, undefined> {
  const chunks: StreamChunk[] = []

  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(createTextChunk(text.slice(i, i + chunkSize)))
  }

  if (endWithTool) {
    chunks.push(createToolCallChunk('end_turn', {}))
  }

  return createMockStream(chunks)
}

/**
 * Options for creating a mock prompt function.
 */
export interface MockPromptOptions {
  /**
   * Default response text.
   */
  defaultResponse?: string

  /**
   * Whether to include an end_turn tool call.
   */
  includeEndTurn?: boolean

  /**
   * Custom chunks to yield.
   */
  chunks?: StreamChunk[]
}

/**
 * Mock prompt function result type.
 */
export type MockPromptFn = Mock<
  (
    params: Record<string, unknown>,
  ) => AsyncGenerator<StreamChunk, string | null>
>

/**
 * Creates a mock promptAiSdkStream function for testing.
 *
 * @param options - Configuration options
 * @returns A mock function that returns streams
 *
 * @example
 * ```typescript
 * const mockPrompt = createMockPromptAiSdkStream({
 *   defaultResponse: 'I understand your request.',
 * })
 *
 * loopAgentStepsBaseParams.promptAiSdkStream = mockPrompt
 *
 * await loopAgentSteps({ ...params })
 *
 * expect(mockPrompt).toHaveBeenCalledTimes(1)
 * ```
 */
export function createMockPromptAiSdkStream(
  options: MockPromptOptions = {},
): MockPromptFn {
  const {
    defaultResponse = 'Mock response\n\n',
    includeEndTurn = true,
    chunks,
  } = options

  return mock(async function* () {
    if (chunks) {
      for (const chunk of chunks) {
        yield chunk
      }
    } else {
      yield createTextChunk(defaultResponse)
      if (includeEndTurn) {
        yield createToolCallChunk('end_turn', {})
      }
    }
    return 'mock-message-id'
  })
}

/**
 * Collects all chunks from a stream into an array.
 * Useful for testing stream content.
 *
 * @param stream - The stream to collect from
 * @returns An array of all chunks and the return value
 *
 * @example
 * ```typescript
 * const stream = createMockStream([...])
 * const { chunks, returnValue } = await collectStreamChunks(stream)
 *
 * expect(chunks).toHaveLength(3)
 * expect(returnValue).toBe('mock-message-id')
 * ```
 */
export async function collectStreamChunks<T, R>(
  stream: AsyncGenerator<T, R, undefined>,
): Promise<{ chunks: T[]; returnValue: R }> {
  const chunks: T[] = []

  let result = await stream.next()
  while (!result.done) {
    chunks.push(result.value)
    result = await stream.next()
  }

  return { chunks, returnValue: result.value }
}
