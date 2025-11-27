import { toolNames } from '@codebuff/common/tools/constants'
import { buildArray } from '@codebuff/common/util/array'
import {
  jsonToolResult,
  assistantMessage,
} from '@codebuff/common/util/messages'
import { generateCompactId } from '@codebuff/common/util/string'
import { cloneDeep } from 'lodash'

import { processStreamWithTools } from '../tool-stream-parser'
import { executeCustomToolCall, executeToolCall } from './tool-executor'
import { expireMessages } from '../util/messages'

import type { CustomToolCall, ExecuteToolCallParams } from './tool-executor'
import type { AgentTemplate } from '../templates/types'
import type { FileProcessingState } from './handlers/tool/write-file'
import type { ToolName } from '@codebuff/common/tools/constants'
import type { CodebuffToolCall } from '@codebuff/common/tools/list'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type {
  Message,
  ToolMessage,
} from '@codebuff/common/types/messages/codebuff-message'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { Subgoal } from '@codebuff/common/types/session-state'
import type { ProjectFileContext } from '@codebuff/common/util/file'
import type { ToolCallPart } from 'ai'

export type ToolCallError = {
  toolName?: string
  args: Record<string, unknown>
  error: string
} & Omit<ToolCallPart, 'type'>

export async function processStream(
  params: {
    agentContext: Record<string, Subgoal>
    agentTemplate: AgentTemplate
    ancestorRunIds: string[]
    fileContext: ProjectFileContext
    fingerprintId: string
    fullResponse: string
    logger: Logger
    messages: Message[]
    repoId: string | undefined
    runId: string
    signal: AbortSignal
    userId: string | undefined

    onCostCalculated: (credits: number) => Promise<void>
    onResponseChunk: (chunk: string | PrintModeEvent) => void
  } & Omit<
    ExecuteToolCallParams<any>,
    | 'fileProcessingState'
    | 'fromHandleSteps'
    | 'fullResponse'
    | 'input'
    | 'previousToolCallFinished'
    | 'state'
    | 'toolCallId'
    | 'toolCalls'
    | 'toolName'
    | 'toolResults'
    | 'toolResultsToAddAfterStream'
  > &
    ParamsExcluding<
      typeof processStreamWithTools,
      'processors' | 'defaultProcessor' | 'onError' | 'loggerOptions'
    >,
) {
  const {
    agentState,
    agentTemplate,
    ancestorRunIds,
    fileContext,
    fullResponse,
    onCostCalculated,
    onResponseChunk,
    runId,
    signal,
    userId,
    logger,
  } = params
  const fullResponseChunks: string[] = [fullResponse]

  const toolResults: ToolMessage[] = []
  const toolResultsToAddAfterStream: ToolMessage[] = []
  const toolCalls: (CodebuffToolCall | CustomToolCall)[] = []
  const assistantMessages: Message[] = []
  const { promise: streamDonePromise, resolve: resolveStreamDonePromise } =
    Promise.withResolvers<void>()
  let previousToolCallFinished = streamDonePromise

  const fileProcessingState: FileProcessingState = {
    promisesByPath: {},
    allPromises: [],
    fileChangeErrors: [],
    fileChanges: [],
    firstFileProcessed: false,
  }

  function toolCallback<T extends ToolName>(toolName: T) {
    return {
      onTagStart: () => {},
      onTagEnd: async (_: string, input: Record<string, string>) => {
        if (signal.aborted) {
          return
        }
        const toolCallId = generateCompactId()
        // delegated to reusable helper
        previousToolCallFinished = executeToolCall({
          ...params,
          toolName,
          input,
          fromHandleSteps: false,

          fileProcessingState,
          fullResponse: fullResponseChunks.join(''),
          previousToolCallFinished,
          toolCallId,
          toolCalls,
          toolResults,
          toolResultsToAddAfterStream,

          onCostCalculated,
          onResponseChunk: (chunk) => {
            if (typeof chunk !== 'string' && chunk.type === 'tool_call') {
              assistantMessages.push(
                assistantMessage({ ...chunk, type: 'tool-call' }),
              )
            }
            return onResponseChunk(chunk)
          },
        })
      },
    }
  }
  function customToolCallback(toolName: string) {
    return {
      onTagStart: () => {},
      onTagEnd: async (_: string, input: Record<string, string>) => {
        if (signal.aborted) {
          return
        }
        const toolCallId = generateCompactId()
        // delegated to reusable helper
        previousToolCallFinished = executeCustomToolCall({
          ...params,
          toolName,
          input,

          fileProcessingState,
          fullResponse: fullResponseChunks.join(''),
          previousToolCallFinished,
          toolCallId,
          toolCalls,
          toolResults,
          toolResultsToAddAfterStream,

          onResponseChunk: (chunk) => {
            if (typeof chunk !== 'string' && chunk.type === 'tool_call') {
              assistantMessages.push(
                assistantMessage({ ...chunk, type: 'tool-call' }),
              )
            }
            return onResponseChunk(chunk)
          },
        })
      },
    }
  }

  const streamWithTags = processStreamWithTools({
    ...params,
    processors: Object.fromEntries([
      ...toolNames.map((toolName) => [toolName, toolCallback(toolName)]),
      ...Object.keys(fileContext.customToolDefinitions ?? {}).map(
        (toolName) => [toolName, customToolCallback(toolName)],
      ),
    ]),
    defaultProcessor: customToolCallback,
    onError: (toolName, error) => {
      const toolResult: ToolMessage = {
        role: 'tool',
        toolName,
        toolCallId: generateCompactId(),
        content: jsonToolResult({
          errorMessage: error,
        }),
      }
      toolResults.push(cloneDeep(toolResult))
      toolResultsToAddAfterStream.push(cloneDeep(toolResult))
    },
    loggerOptions: {
      userId,
      model: agentTemplate.model,
      agentName: agentTemplate.id,
    },
    onResponseChunk: (chunk) => {
      if (chunk.type === 'text') {
        if (chunk.text) {
          assistantMessages.push(assistantMessage(chunk.text))
        }
      } else if (chunk.type === 'error') {
        // do nothing
      } else {
        chunk satisfies never
        throw new Error(
          `Internal error: unhandled chunk type: ${(chunk as any).type}`,
        )
      }
      return onResponseChunk(chunk)
    },
  })

  let messageId: string | null = null
  while (true) {
    if (signal.aborted) {
      break
    }
    const { value: chunk, done } = await streamWithTags.next()
    if (done) {
      messageId = chunk
      break
    }

    if (chunk.type === 'reasoning') {
      onResponseChunk({
        type: 'reasoning_delta',
        text: chunk.text,
        ancestorRunIds,
        runId,
      })
    } else if (chunk.type === 'text') {
      onResponseChunk(chunk.text)
      fullResponseChunks.push(chunk.text)
    } else if (chunk.type === 'error') {
      onResponseChunk(chunk)
    } else if (chunk.type === 'tool-call') {
      // Do nothing, the onResponseChunk for tool is handled in the processor
    } else {
      chunk satisfies never
      throw new Error(`Unhandled chunk type: ${(chunk as any).type}`)
    }
  }

  agentState.messageHistory = buildArray<Message>([
    ...expireMessages(agentState.messageHistory, 'agentStep'),
    ...assistantMessages,
    ...toolResultsToAddAfterStream,
  ])

  if (!signal.aborted) {
    resolveStreamDonePromise()
    await previousToolCallFinished
  }
  return {
    fullResponse: fullResponseChunks.join(''),
    fullResponseChunks,
    messageId,
    toolCalls,
    toolResults,
  }
}
