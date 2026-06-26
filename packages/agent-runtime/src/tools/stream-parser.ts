import { toolNames } from '@codebuff/common/tools/constants'
import { buildArray } from '@codebuff/common/util/array'
import { AbortError } from '@codebuff/common/util/error'
import {
  assistantMessage,
  userMessage,
} from '@codebuff/common/util/messages'

import { processStreamWithTools } from '../tool-stream-parser'
import { INCLUDE_REASONING_IN_MESSAGE_HISTORY } from '../constants'
import {
  executeCustomToolCall,
  executeToolCall,
  tryTransformAgentToolCall,
} from './tool-executor'
import { createToolCallIdGenerator } from '../util/tool-call-id'
import { withSystemTags } from '../util/messages'

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
    | 'toolCallsToAddToMessageHistory'
    | 'toolName'
    | 'toolResults'
    | 'toolResultsToAddToMessageHistory'
  > &
    ParamsExcluding<
      typeof processStreamWithTools,
      | 'processors'
      | 'defaultProcessor'
      | 'loggerOptions'
      | 'executeXmlToolCall'
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
  } = params
  const fullResponseChunks: string[] = [fullResponse]

  // === MUTABLE STATE ===
  const toolResults: ToolMessage[] = []
  const toolResultsToAddToMessageHistory: ToolMessage[] = []
  const toolCalls: (CodebuffToolCall | CustomToolCall)[] = []
  const toolCallsToAddToMessageHistory: (CodebuffToolCall | CustomToolCall)[] = []
  const assistantMessages: Message[] = []
  const getToolCallId = createToolCallIdGenerator(agentState)
  let hadToolCallError = false
  const errorMessages: Message[] = []
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

  // === RESPONSE HANDLER ===
  // Creates a response handler that captures tool events into assistantMessages.
  // When isXmlMode=true, also captures tool_result events for interleaved ordering.
  function createResponseHandler() {
    return (chunk: string | PrintModeEvent) => {
      if (typeof chunk !== 'string') {
        if (chunk.type === 'error') {
          hadToolCallError = true
          errorMessages.push(
            userMessage({
              content: withSystemTags(
                `Error during tool call: ${chunk.message}. Please check the tool name and arguments and try again.`,
              ),
              tags: ['TOOL_CALL_ERROR'],
            }),
          )
        }
      }
      return onResponseChunk(chunk)
    }
  }

  // === TOOL EXECUTION ===
  // Unified callback factory for both native and custom tools.
  function createToolExecutionCallback(toolName: string, isXmlMode: boolean) {
    const responseHandler = createResponseHandler()
    return {
      onTagStart: () => { },
      onTagEnd: async (_: string, input: Record<string, string>) => {
        if (signal.aborted) {
          return
        }
        const isNativeTool = toolNames.includes(toolName as ToolName)

        // Check if this is an agent tool call that should be transformed to spawn_agents
        const transformed = !isNativeTool
          ? tryTransformAgentToolCall({
            toolName,
            input,
            spawnableAgents: agentTemplate.spawnableAgents,
          })
          : null

        // Read previousToolCallFinished at execution time to ensure proper sequential chaining.
        // For XML mode, if this is the first tool call (still pointing to streamDonePromise),
        // start with a resolved promise so we don't wait for the stream to complete.
        const previousPromise =
          isXmlMode && previousToolCallFinished === streamDonePromise
            ? Promise.resolve()
            : previousToolCallFinished

        // Determine which executor to use and with what parameters
        let toolPromise: Promise<void>
        if (isNativeTool || transformed) {
          const effectiveToolName = transformed
            ? transformed.toolName
            : (toolName as ToolName)
          // Use executeToolCall for native tools or transformed agent calls
          toolPromise = executeToolCall({
            ...params,
            toolName: effectiveToolName,
            input: transformed ? transformed.input : input,
            fromHandleSteps: false,

            fileProcessingState,
            fullResponse: fullResponseChunks.join(''),
            previousToolCallFinished: previousPromise,
            toolCallId: getToolCallId(effectiveToolName),
            toolCalls,
            toolCallsToAddToMessageHistory,
            toolResults,
            toolResultsToAddToMessageHistory,
            excludeToolFromMessageHistory: false,
            onCostCalculated,
            onResponseChunk: responseHandler,
          })
        } else {
          // Use executeCustomToolCall for custom/MCP tools
          toolPromise = executeCustomToolCall({
            ...params,
            toolName,
            input,

            fileProcessingState,
            fullResponse: fullResponseChunks.join(''),
            previousToolCallFinished: previousPromise,
            toolCallId: getToolCallId(toolName),
            toolCalls,
            toolCallsToAddToMessageHistory,
            toolResults,
            toolResultsToAddToMessageHistory,
            excludeToolFromMessageHistory: false,
            onResponseChunk: responseHandler,
          })
        }

        previousToolCallFinished = toolPromise

        // For XML mode, await execution so results appear inline before stream continues
        if (isXmlMode) {
          await toolPromise
        }
      },
    }
  }

  // === STREAM PROCESSING ===
  const streamWithTags = processStreamWithTools({
    ...params,
    processors: Object.fromEntries([
      ...toolNames.map((name) => [
        name,
        createToolExecutionCallback(name, false),
      ]),
      ...Object.keys(fileContext.customToolDefinitions ?? {}).map((name) => [
        name,
        createToolExecutionCallback(name, false),
      ]),
    ]),
    defaultProcessor: (name: string) =>
      createToolExecutionCallback(name, false),
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
          `Internal error: unhandled chunk type: ${(chunk as { type: unknown }).type}`,
        )
      }
      return onResponseChunk(chunk)
    },
    // Execute XML-parsed tool calls immediately during streaming
    executeXmlToolCall: async ({ toolName, input }) => {
      if (signal.aborted) {
        return
      }
      const callback = createToolExecutionCallback(toolName, true)
      await callback.onTagEnd(toolName, input as Record<string, string>)
    },
  })

  // === STREAM CONSUMPTION LOOP ===
  let messageId: string | null = null

  // Wrap in try/finally so that the finalization (message history update) always
  // runs even when the stream throws an AbortError mid-iteration.
  try {
    while (true) {
      if (signal.aborted) {
        break
      }
      const { value: chunk, done } = await streamWithTags.next()
      if (done) {
        // Handle PromptResult: extract value if success, null if aborted
        if (chunk && typeof chunk === 'object' && 'aborted' in chunk) {
          messageId = chunk.aborted ? null : chunk.value
        } else {
          messageId = chunk
        }
        break
      }

      if (chunk.type === 'reasoning') {
        if (INCLUDE_REASONING_IN_MESSAGE_HISTORY && chunk.text) {
          const last = assistantMessages[assistantMessages.length - 1]
          const lastPart =
            last?.role === 'assistant' && Array.isArray(last.content)
              ? last.content[last.content.length - 1]
              : undefined
          if (lastPart && lastPart.type === 'reasoning') {
            lastPart.text += chunk.text
          } else {
            assistantMessages.push(
              assistantMessage({ type: 'reasoning', text: chunk.text }),
            )
          }
        }
        onResponseChunk({
          type: 'reasoning_delta',
          text: chunk.text,
          ancestorRunIds,
          runId,
          agentId: agentState.agentId,
        })
      } else if (chunk.type === 'text') {
        onResponseChunk(chunk.text)
        fullResponseChunks.push(chunk.text)
      } else if (chunk.type === 'error') {
        onResponseChunk(chunk)
        hadToolCallError = true
        errorMessages.push(
          userMessage({
            content: withSystemTags(
              `Error during tool call: ${chunk.message}. Please check the tool name and arguments and try again.`,
            ),
            tags: ['TOOL_CALL_ERROR'],
          }),
        )
      } else if (chunk.type === 'tool-call') {
      } else {
        chunk satisfies never
        throw new Error(
          `Unhandled chunk type: ${(chunk as { type: unknown }).type}`,
        )
      }
    }

    if (!signal.aborted) {
      resolveStreamDonePromise()
      await previousToolCallFinished
    }
  } finally {
    // === FINALIZATION ===
    // Trigger cleanup of the processStreamWithTools generator so it flushes any
    // remaining buffered text to assistantMessages before we build the history.
    // On path B (AbortError thrown mid-stream) the generator is already completed
    // so .return() is a no-op. On path A (cooperative signal.aborted break) the
    // generator is still suspended and .return() triggers its finally → flush().
    try {
      await streamWithTags.return({ aborted: true })
    } catch {
      // Generator cleanup failed; assistantMessages may be incomplete but
      // we must not swallow the original error.
    }

    // This runs even when the stream throws (e.g., AbortError mid-iteration).
    // Build message history from the current agentState.messageHistory so that
    // inline agent modifications (e.g. set_messages) are preserved, while
    // tool_calls and tool_results are still appended in deterministic order.
    //
    // When the signal was aborted, tool calls are added synchronously but tool
    // results arrive asynchronously via .then(). Because we skip awaiting
    // previousToolCallFinished on abort, some tool calls may not have matching
    // tool results yet. Including orphaned tool calls in the message history
    // causes provider errors ("unexpected tool_use_id found in tool_result
    // blocks"). Filter them out so every tool_call has a corresponding
    // tool_result.
    const completedToolCallIds = new Set(
      toolResultsToAddToMessageHistory.map((r) => r.toolCallId),
    )
    const filteredToolCalls =
      toolCallsToAddToMessageHistory.filter((tc) =>
        completedToolCallIds.has(tc.toolCallId),
      )

    agentState.messageHistory = buildArray<Message>([
      ...agentState.messageHistory,
      ...assistantMessages,
      ...filteredToolCalls.map((toolCall) => assistantMessage({ ...toolCall, type: 'tool-call' })),
      ...toolResultsToAddToMessageHistory,
      ...errorMessages,
    ])
  }

  if (signal.aborted) {
    throw new AbortError()
  }

  return {
    fullResponse: fullResponseChunks.join(''),
    fullResponseChunks,
    hadToolCallError,
    messageId,
    toolCalls,
    toolResults,
  }
}
