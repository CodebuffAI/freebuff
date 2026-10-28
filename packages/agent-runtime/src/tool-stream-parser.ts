import {
  createStreamParserState,
  parseStreamChunk,
} from './util/stream-xml-parser'

import type { StreamParserState } from './util/stream-xml-parser'
import type { StreamChunk } from '@codebuff/common/types/contracts/llm'
import type { ProviderMetadata } from '@codebuff/common/types/messages/provider-metadata'
import type {
  PrintModeError,
  PrintModeText,
} from '@codebuff/common/types/print-mode'
import type { PromptResult } from '@codebuff/common/util/error'

export async function* processStreamWithTools(params: {
  stream: AsyncGenerator<StreamChunk, PromptResult<string | null>>
  processors: Record<
    string,
    {
      onTagStart: (
        tagName: string,
        attributes: Record<string, string>,
      ) => void | Promise<void>
      onTagEnd: (
        tagName: string,
        params: Record<string, any>,
        providerOptions?: ProviderMetadata,
      ) => void | Promise<void>
    }
  >
  defaultProcessor: (toolName: string) => {
    onTagStart: (
      tagName: string,
      attributes: Record<string, string>,
    ) => void | Promise<void>
    onTagEnd: (
      tagName: string,
      params: Record<string, any>,
      providerOptions?: ProviderMetadata,
    ) => void | Promise<void>
  }
  onResponseChunk: (chunk: PrintModeText | PrintModeError) => void
  executeXmlToolCall: (params: {
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
  }) => Promise<void>
}): AsyncGenerator<StreamChunk, PromptResult<string | null>> {
  const {
    stream,
    processors,
    defaultProcessor,
    onResponseChunk,
    executeXmlToolCall,
  } = params
  let streamCompleted = false
  let buffer = ''

  // State for parsing XML tool calls from text stream
  const xmlParserState: StreamParserState = createStreamParserState()

  async function processToolCallObject(params: {
    toolName: string
    input: any
    providerOptions?: ProviderMetadata
  }): Promise<void> {
    const { toolName, providerOptions } = params
    let { input } = params

    // AI SDK sometimes emits tool-call chunks with a raw JSON string as `input`
    // when its repair pass can't produce a parsed object. Try to parse; if it
    // fails, leave as string — the executor surfaces a clear error.
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input)
      } catch {}
    }

    const processor = processors[toolName] ?? defaultProcessor(toolName)

    await processor.onTagStart(toolName, {})
    await processor.onTagEnd(toolName, input, providerOptions)
  }

  async function flush() {
    if (buffer) {
      await onResponseChunk({
        type: 'text',
        text: buffer,
      })
    }
    buffer = ''
  }

  async function* processChunk(
    chunk: StreamChunk | undefined,
  ): AsyncGenerator<StreamChunk> {
    if (chunk === undefined) {
      await flush()
      streamCompleted = true
      return
    }

    if (chunk.type === 'text') {
      // Parse XML tool calls from the text stream
      const { filteredText, toolCalls } = parseStreamChunk(
        chunk.text,
        xmlParserState,
      )

      if (filteredText) {
        buffer += filteredText
        yield {
          type: 'text',
          text: filteredText,
        }
      }

      // Flush buffer before yielding tool calls so text event is sent first
      if (toolCalls.length > 0) {
        await flush()
      }

      // Then process and yield any XML tool calls found
      for (const toolCall of toolCalls) {
        const toolCallId = `xml-${crypto.randomUUID().slice(0, 8)}`

        // Execute the tool immediately if callback provided, pausing the stream
        // The callback handles emitting tool_call and tool_result events
        await executeXmlToolCall({
          toolCallId,
          toolName: toolCall.toolName,
          input: toolCall.input,
        })
      }
      return
    } else {
      await flush()
    }

    if (chunk.type === 'tool-call') {
      await processToolCallObject(chunk)
    }

    yield chunk
  }

  let result: PromptResult<string | null> = { aborted: false, value: null }
  try {
    while (true) {
      const { value, done } = await stream.next()
      if (done) {
        result = value
        break
      }
      if (streamCompleted) {
        break
      }
      yield* processChunk(value)
    }
    if (!streamCompleted) {
      // After the stream ends, try parsing one last time in case there's leftover text
      yield* processChunk(undefined)
    }
  } finally {
    // Flush any remaining buffered text so it reaches onResponseChunk even on
    // abort. Without this, text streamed after the last tool call would be lost
    // from the message history.
    await flush()
  }
  return result
}
