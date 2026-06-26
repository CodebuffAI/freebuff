import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'

import {
  createStreamParserState,
  parseStreamChunk,
} from './util/stream-xml-parser'

import type { StreamParserState } from './util/stream-xml-parser'
import type { Model } from '@codebuff/common/old-constants'
import type { TrackEventFn } from '@codebuff/common/types/contracts/analytics'
import type { StreamChunk } from '@codebuff/common/types/contracts/llm'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type {
  PrintModeError,
  PrintModeText,
} from '@codebuff/common/types/print-mode'
import type { PromptResult } from '@codebuff/common/util/error'

function summarizeToolInput(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    return {
      inputType: 'string',
      inputLength: input.length,
    }
  }

  if (Array.isArray(input)) {
    return {
      inputType: 'array',
      inputLength: input.length,
    }
  }

  if (input && typeof input === 'object') {
    const keys = Object.keys(input as Record<string, unknown>)
    return {
      inputType: 'object',
      inputKeyCount: keys.length,
      inputKeys: keys.slice(0, 25),
    }
  }

  return {
    inputType: input === null ? 'null' : typeof input,
  }
}

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
    ) => void | Promise<void>
  }
  onResponseChunk: (chunk: PrintModeText | PrintModeError) => void
  logger: Logger
  loggerOptions?: {
    userId?: string
    model?: Model
    agentName?: string
  }
  trackEvent: TrackEventFn
  executeXmlToolCall: (params: {
    toolName: string
    input: Record<string, unknown>
  }) => Promise<void>
}): AsyncGenerator<StreamChunk, PromptResult<string | null>> {
  const {
    stream,
    processors,
    defaultProcessor,
    onResponseChunk,
    logger,
    loggerOptions,
    trackEvent,
    executeXmlToolCall,
  } = params
  let streamCompleted = false
  let buffer = ''
  let autocompleted = false

  // State for parsing XML tool calls from text stream
  const xmlParserState: StreamParserState = createStreamParserState()

  async function processToolCallObject(params: {
    toolName: string
    input: any
    contents?: string
  }): Promise<void> {
    const { toolName, contents } = params
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

    trackEvent({
      event: AnalyticsEvent.TOOL_USE,
      userId: loggerOptions?.userId ?? '',
      properties: {
        toolName,
        ...summarizeToolInput(input),
        hasContents: typeof contents === 'string' && contents.length > 0,
        contentsLength: contents?.length ?? 0,
        autocompleted,
        model: loggerOptions?.model,
        agent: loggerOptions?.agentName,
      },
      logger,
    })

    await processor.onTagStart(toolName, {})
    await processor.onTagEnd(toolName, input)
  }

  function flush() {
    if (buffer) {
      onResponseChunk({
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
      flush()
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
        flush()
      }

      // Then process and yield any XML tool calls found
      for (const toolCall of toolCalls) {
        // Execute the tool immediately if callback provided, pausing the stream
        // The callback handles emitting tool_call and tool_result events
        await executeXmlToolCall({
          toolName: toolCall.toolName,
          input: toolCall.input,
        })
      }
      return
    } else {
      flush()
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
    flush()
  }
  return result
}
