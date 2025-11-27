import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'

import type { Model } from '@codebuff/common/old-constants'
import type { TrackEventFn } from '@codebuff/common/types/contracts/analytics'
import type { StreamChunk } from '@codebuff/common/types/contracts/llm'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type {
  PrintModeError,
  PrintModeText,
} from '@codebuff/common/types/print-mode'

export async function* processStreamWithTools(params: {
  stream: AsyncGenerator<StreamChunk, string | null>
  processors: Record<
    string,
    {
      onTagStart: (tagName: string, attributes: Record<string, string>) => void
      onTagEnd: (tagName: string, params: Record<string, any>) => void
    }
  >
  defaultProcessor: (toolName: string) => {
    onTagStart: (tagName: string, attributes: Record<string, string>) => void
    onTagEnd: (tagName: string, params: Record<string, any>) => void
  }
  onError: (tagName: string, errorMessage: string) => void
  onResponseChunk: (chunk: PrintModeText | PrintModeError) => void
  logger: Logger
  loggerOptions?: {
    userId?: string
    model?: Model
    agentName?: string
  }
  trackEvent: TrackEventFn
}): AsyncGenerator<StreamChunk, string | null> {
  const {
    stream,
    processors,
    defaultProcessor,
    onError,
    onResponseChunk,
    logger,
    loggerOptions,
    trackEvent,
  } = params
  let streamCompleted = false
  let buffer = ''
  let autocompleted = false

  function processToolCallObject(params: {
    toolName: string
    input: any
    contents?: string
  }): void {
    const { toolName, input, contents } = params

    const processor = processors[toolName] ?? defaultProcessor(toolName)

    trackEvent({
      event: AnalyticsEvent.TOOL_USE,
      userId: loggerOptions?.userId ?? '',
      properties: {
        toolName,
        contents,
        parsedParams: input,
        autocompleted,
        model: loggerOptions?.model,
        agent: loggerOptions?.agentName,
      },
      logger,
    })

    processor.onTagStart(toolName, {})
    processor.onTagEnd(toolName, input)
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

  function* processChunk(
    chunk: StreamChunk | undefined,
  ): Generator<StreamChunk> {
    if (chunk === undefined) {
      flush()
      streamCompleted = true
      return
    }

    if (chunk.type === 'text') {
      buffer += chunk.text
    } else {
      flush()
    }

    if (chunk.type === 'tool-call') {
      processToolCallObject(chunk)
    }

    yield chunk
  }

  let messageId: string | null = null
  while (true) {
    const { value, done } = await stream.next()
    if (done) {
      messageId = value
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
  return messageId
}
