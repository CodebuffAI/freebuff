import { toolNames } from '@codebuff/common/tools/constants'
import { buildArray } from '@codebuff/common/util/array'
import { STREAM_RECOVERY_EVENT } from '@codebuff/common/util/axiom-only-log'
import { AbortError } from '@codebuff/common/util/error'
import { assistantMessage, userMessage } from '@codebuff/common/util/messages'
import { generateCompactId } from '@codebuff/common/util/string'

import { processStreamWithTools } from '../tool-stream-parser'
import { INCLUDE_REASONING_IN_MESSAGE_HISTORY } from '../constants'
import {
  executeCustomToolCall,
  executeToolCall,
  parseRawToolCall,
  tryTransformAgentToolCall,
} from './tool-executor'
import { withSystemTags } from '../util/messages'
import {
  historyHasUnclosedOpen,
  historyLeaksThinkTags,
  stripThinkScaffolding,
  ThinkTagStream,
} from '../util/think-tag-stream'
import type { CustomToolCall, ExecuteToolCallParams } from './tool-executor'
import type { ThinkStreamSegment } from '../util/think-tag-stream'
import type { AgentTemplate } from '../templates/types'
import type { FileProcessingState } from './handlers/tool/write-file'
import type { ToolName } from '@codebuff/common/tools/constants'
import type { CodebuffToolCall } from '@codebuff/common/tools/list'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { StreamRecoverySource } from '@codebuff/common/types/contracts/llm'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type {
  Message,
  ToolMessage,
} from '@codebuff/common/types/messages/codebuff-message'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { Subgoal } from '@codebuff/common/types/session-state'
import type { ProjectFileContext } from '@codebuff/common/util/file'

/** History tags for the notes appended when a step's stream ends without a
 *  usable response and the loop auto-retries (see
 *  sdk/src/impl/stream-interruption.ts for detection): the connection was cut
 *  mid-response, or the model ended after reasoning without an answer. */
export const STREAM_INTERRUPTED_TAG = 'STREAM_INTERRUPTED'
export const OUTPUT_LIMIT_TAG = 'OUTPUT_LIMIT'

/** How many back-to-back recovery retries (nothing but the model's partial
 *  output between them, interruption and reasoning-only combined) run before
 *  the turn fails loudly. One covers the deploy/network blip or one-off
 *  thinking overrun this retry exists for; a run of them means every attempt
 *  is failing the same way. */
export const MAX_CONSECUTIVE_STREAM_RECOVERIES = 3

export const REPEATED_STREAM_INTERRUPTIONS_MESSAGE =
  'The connection kept dropping mid-response after several retries. Please check your network connection and try again.'

export const REPEATED_OUTPUT_LIMIT_MESSAGE =
  'The model kept ending after reasoning without producing a response. Try a simpler request or a different model.'

const RECOVERY_BY_SOURCE: Record<
  StreamRecoverySource,
  { tag: string; giveUpMessage: string }
> = {
  'stream-interrupted': {
    tag: STREAM_INTERRUPTED_TAG,
    giveUpMessage: REPEATED_STREAM_INTERRUPTIONS_MESSAGE,
  },
  'output-limit': {
    tag: OUTPUT_LIMIT_TAG,
    giveUpMessage: REPEATED_OUTPUT_LIMIT_MESSAGE,
  },
}

// Map (not a plain object) so an arbitrary message tag like 'constructor'
// can't match via the prototype chain.
const SOURCE_BY_RECOVERY_TAG: ReadonlyMap<string, StreamRecoverySource> =
  new Map(
    Object.entries(RECOVERY_BY_SOURCE).map(([source, recovery]) => [
      recovery.tag,
      source as StreamRecoverySource,
    ]),
  )

export interface TrailingStreamRecoveryStreak {
  /** How many recovery notes (either kind) are stacked at the tail. */
  count: number
  /** The kind of the most recent one, or undefined if count is 0. A streak
   *  can mix both kinds; this is the one immediately preceding wherever the
   *  caller is looking from — e.g. the step that's about to give up, or the
   *  step that just succeeded. */
  lastSource: StreamRecoverySource | undefined
}

/**
 * Walk the tail of the conversation and measure the current recovery streak.
 * Assistant/system content between notes is the retries' partial output, and
 * STEP_PROMPT messages are per-step scaffolding (run-agent-step appends one
 * to the history before every step) — neither breaks the streak. A completed
 * tool exchange or any other user message (a real prompt, a tool-error note)
 * means a step fully succeeded or failed differently in between, so the
 * streak resets there.
 */
export function trailingStreamRecoveryStreak(
  messages: Message[],
): TrailingStreamRecoveryStreak {
  let count = 0
  let lastSource: StreamRecoverySource | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === 'tool') break
    if (message.role !== 'user') continue
    if (message.tags?.includes('STEP_PROMPT')) continue
    const tag = message.tags?.find((t) => SOURCE_BY_RECOVERY_TAG.has(t))
    if (!tag) break
    if (count === 0) lastSource = SOURCE_BY_RECOVERY_TAG.get(tag)
    count++
  }
  return { count, lastSource }
}

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
    | 'currentAssistantMessages'
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
      'processors' | 'defaultProcessor' | 'executeXmlToolCall'
    >,
) {
  const {
    agentState,
    agentTemplate,
    ancestorRunIds,
    fileContext,
    fullResponse,
    logger,
    onCostCalculated,
    onResponseChunk,
    runId,
    signal,
    userId,
  } = params
  const fullResponseChunks: string[] = [fullResponse]

  // === LEAKED-REASONING SPLIT ===
  // Reasoning that a lane failed to put in its native field arrives here as
  // ordinary text, tags and all. Reclassify it before it reaches a surface, so
  // the thinking box is the only place a chain of thought is ever rendered.
  // See util/think-tag-stream.ts for the three shapes and why the hold rules
  // are armed from the history rather than from a model id.
  const thinkTagStream = new ThinkTagStream({
    implicitOpen: historyLeaksThinkTags(agentState.messageHistory),
    holdExplicitOpens: historyHasUnclosedOpen(agentState.messageHistory),
  })
  const emitThinkSegments = (segments: ThinkStreamSegment[]): void => {
    for (const segment of segments) {
      if (segment.type === 'text') {
        onResponseChunk(segment.text)
      } else {
        onResponseChunk({
          type: 'reasoning_delta',
          text: segment.text,
          ancestorRunIds,
          runId,
          agentId: agentState.agentId,
        })
      }
    }
  }

  // === MUTABLE STATE ===
  const toolResults: ToolMessage[] = []
  const toolResultsToAddToMessageHistory: ToolMessage[] = []
  const toolCalls: (CodebuffToolCall | CustomToolCall)[] = []
  const toolCallsToAddToMessageHistory: (CodebuffToolCall | CustomToolCall)[] =
    []
  const assistantMessages: Message[] = []
  // Inline agents replace the parent's history with their result. Track which
  // current-step messages they inherited so finalization does not append them
  // a second time. Object identity is local to this stream and never serialized.
  const claimedByInlineAgent = new Set<Message>()
  let hadToolCallError = false
  let sawStreamRecovery = false
  const errorMessages: Message[] = []
  let resolveStreamDonePromise!: () => void
  const streamDonePromise = new Promise<void>((resolve) => {
    resolveStreamDonePromise = resolve
  })
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
      onTagStart: () => {},
      onTagEnd: async (_: string, input: Record<string, string>) => {
        if (signal.aborted) {
          return
        }
        const toolCallId = generateCompactId()
        const isNativeTool = toolNames.includes(toolName as ToolName)

        // Check if this is an agent tool call that should be transformed to spawn_agents
        const transformed = !isNativeTool
          ? tryTransformAgentToolCall({
              toolName,
              input,
              spawnableAgents: agentTemplate.spawnableAgents,
            })
          : null
        const isSpawnCall =
          Boolean(transformed) ||
          toolName === 'spawn_agents' ||
          toolName === 'spawn_agent_inline'
        const currentAssistantMessages = isSpawnCall
          ? assistantMessages.filter(
              (message) => !claimedByInlineAgent.has(message),
            )
          : []
        const parsedInlineCall =
          toolName === 'spawn_agent_inline'
            ? parseRawToolCall({
                rawToolCall: { toolName, toolCallId, input },
              })
            : null
        const inlineWillConsumeHistory = Boolean(
          parsedInlineCall &&
          !('error' in parsedInlineCall) &&
          agentTemplate.toolNames.includes('spawn_agent_inline'),
        )
        if (inlineWillConsumeHistory) {
          currentAssistantMessages.forEach((message) =>
            claimedByInlineAgent.add(message),
          )
        }

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
          // Use executeToolCall for native tools or transformed agent calls
          toolPromise = executeToolCall({
            ...params,
            toolName: transformed
              ? transformed.toolName
              : (toolName as ToolName),
            input: transformed ? transformed.input : input,
            fromHandleSteps: false,

            fileProcessingState,
            currentAssistantMessages: isSpawnCall
              ? structuredClone(currentAssistantMessages)
              : undefined,
            fullResponse: fullResponseChunks.join(''),
            previousToolCallFinished: previousPromise,
            toolCallId,
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
            toolCallId,
            toolCalls,
            toolCallsToAddToMessageHistory,
            toolResults,
            toolResultsToAddToMessageHistory,
            excludeToolFromMessageHistory: false,
            onResponseChunk: responseHandler,
          })
        }

        if (inlineWillConsumeHistory) {
          toolPromise = toolPromise.catch((error) => {
            currentAssistantMessages.forEach((message) =>
              claimedByInlineAgent.delete(message),
            )
            throw error
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
    onResponseChunk: (chunk) => {
      if (chunk.type === 'text') {
        if (chunk.text) {
          // Raw, like fullResponse: the history is where the leak evidence and
          // the thinking-only turn-end signal live.
          assistantMessages.push(assistantMessage(chunk.text))
        }
        // This event is the CONSOLIDATED fallback for consumers that did not
        // take the streamed deltas — the desktop harness renders it only when
        // nothing streamed, which is exactly the thinking-only step where every
        // delta above went to the thinking box instead. Forwarding it raw would
        // put the scaffolding back on screen through the side door.
        const visible = stripThinkScaffolding(chunk.text)
        if (visible !== chunk.text) {
          return onResponseChunk({ ...chunk, text: visible })
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
        if (
          INCLUDE_REASONING_IN_MESSAGE_HISTORY &&
          (chunk.text || chunk.providerOptions)
        ) {
          const last = assistantMessages[assistantMessages.length - 1]
          const lastPart =
            last?.role === 'assistant' && Array.isArray(last.content)
              ? last.content[last.content.length - 1]
              : undefined
          if (
            lastPart &&
            lastPart.type === 'reasoning' &&
            !claimedByInlineAgent.has(last)
          ) {
            lastPart.text += chunk.text
            if (chunk.providerOptions) {
              lastPart.providerOptions = chunk.providerOptions
            }
          } else {
            assistantMessages.push(
              assistantMessage({
                type: 'reasoning',
                text: chunk.text,
                ...(chunk.providerOptions
                  ? { providerOptions: chunk.providerOptions }
                  : {}),
              }),
            )
          }
        }
        if (chunk.text) {
          // A lane that populates the native reasoning field is by definition
          // not putting the thought in `content`, so this step is not leaking
          // and anything held on speculation is the answer.
          emitThinkSegments(thinkTagStream.disarmImplicitOpen())
          onResponseChunk({
            type: 'reasoning_delta',
            text: chunk.text,
            ancestorRunIds,
            runId,
            agentId: agentState.agentId,
          })
        }
      } else if (chunk.type === 'text') {
        // Deliberately the RAW text into fullResponse and the message history:
        // isThinkOnlyResponse reads it to keep a thinking-only step from ending
        // the turn, and historyLeaksThinkTags reads it to arm the next step.
        // Stripping it here would erase both signals.
        emitThinkSegments(thinkTagStream.push(chunk.text))
        fullResponseChunks.push(chunk.text)
      } else if (chunk.type === 'error') {
        onResponseChunk(chunk)
        if (chunk.source) {
          const recovery = RECOVERY_BY_SOURCE[chunk.source]
          sawStreamRecovery = true
          const { count: priorRecoveries } = trailingStreamRecoveryStreak(
            agentState.messageHistory,
          )
          // Every attempt is failing the same way (not the one-off
          // deploy/network blip or thinking overrun this retry exists for).
          // Fail the turn with a clear message instead of burning up to
          // maxAgentSteps (200) requests.
          if (priorRecoveries >= MAX_CONSECUTIVE_STREAM_RECOVERIES) {
            logger.error(
              {
                metric: 'stream_recovery_gave_up',
                source: chunk.source,
                model: agentTemplate.model,
                agentId: agentTemplate.id,
                userId,
                runId,
                consecutive: priorRecoveries + 1,
              },
              'Giving up after repeated stream recoveries',
            )
            throw new Error(recovery.giveUpMessage)
          }
          // Setting hadToolCallError makes run-agent-step force another step
          // instead of ending the turn — that next step IS the retry: the
          // model sees its partial output plus this note and continues. (No
          // per-retry telemetry: detection in promptAiSdkStream already logs
          // one stream_recovery_detected per occurrence.)
          hadToolCallError = true
          errorMessages.push(
            userMessage({
              content: withSystemTags(chunk.message),
              tags: [recovery.tag],
            }),
          )
        } else {
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
      } else if (chunk.type === 'tool-call') {
      } else {
        chunk satisfies never
        throw new Error(
          `Unhandled chunk type: ${(chunk as { type: unknown }).type}`,
        )
      }
    }

    // The step's content is complete: release anything the split still holds,
    // before the tool-completion await below, so a released head keeps its
    // place ahead of this step's tool events. `flush` is idempotent, so the
    // safety-net call in `finally` is a no-op on this path.
    emitThinkSegments(thinkTagStream.flush())

    // Retry-outcome signal: this step streamed to completion (no new
    // recovery, no user abort) while the history tail still carries a
    // recovery streak — meaning the forced-step retry rescued the turn.
    // Checked before finalization appends this step's messages, so the count
    // is the streak being recovered from.
    if (!sawStreamRecovery && !signal.aborted) {
      const { count: recoveredFrom, lastSource } = trailingStreamRecoveryStreak(
        agentState.messageHistory,
      )
      if (recoveredFrom > 0) {
        logger.info(
          {
            // See common/src/util/axiom-only-log.ts: without axiomEvent,
            // info-level fields below ship to Axiom as a shape summary, not
            // real values.
            axiomEvent: STREAM_RECOVERY_EVENT,
            metric: 'stream_recovery_rescued',
            // The kind resolved by this step specifically; a streak can mix
            // both kinds, so this is the last note before the success, not
            // necessarily every note in the streak.
            source: lastSource,
            model: agentTemplate.model,
            agentId: agentTemplate.id,
            userId,
            runId,
            consecutive: recoveredFrom,
          },
          'Stream-interruption retry succeeded; turn continued normally',
        )
      }
    }

    if (!signal.aborted) {
      resolveStreamDonePromise()
      await previousToolCallFinished
    }
  } finally {
    // === FINALIZATION ===
    // Release anything the think-tag split is still holding — a partial tag
    // that never completed, or a head held for an orphan `</think>` that never
    // came. Runs on the abort paths too, so speculation can never lose text.
    emitThinkSegments(thinkTagStream.flush())

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
    const filteredToolCalls = toolCallsToAddToMessageHistory.filter((tc) =>
      completedToolCallIds.has(tc.toolCallId),
    )

    agentState.messageHistory = buildArray<Message>([
      ...agentState.messageHistory,
      ...assistantMessages.filter(
        (message) => !claimedByInlineAgent.has(message),
      ),
      ...filteredToolCalls.map((toolCall) =>
        assistantMessage({ ...toolCall, type: 'tool-call' }),
      ),
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
