import { match } from 'ts-pattern'

import {
  appendTextToRootStream,
  appendToolToAgentBlock,
  closeNativeReasoningBlock,
  closeNativeReasoningInAgent,
  markAgentComplete,
} from './block-operations'
import { shouldHideAgent } from './constants'
import {
  createAgentBlock,
  extractPlanFromBuffer,
  extractSpawnAgentResultContent,
  findAgentTypeById,
  insertPlanBlock,
  nestBlockUnderParent,
  transformAskUserBlocks,
  updateToolBlockWithOutput,
} from './message-block-helpers'
import {
  findMatchingSpawnAgent,
  resolveSpawnAgentToReal,
} from './spawn-agent-matcher'
import {
  destinationFromChunkEvent,
  processTextChunk,
} from './stream-chunk-processor'

import type { AgentMode } from './constants'
import type { MessageUpdater } from './message-updater'
import type { StreamController } from '../hooks/stream-state'
import type { StreamStatus } from '../hooks/use-message-queue'
import type { ContentBlock, ToolContentBlock } from '../types/chat'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type {
  PrintModeError,
  PrintModeEvent as SDKEvent,
  PrintModeFinish,
  PrintModeSubagentFinish,
  PrintModeSubagentStart,
  PrintModeToolCall,
  PrintModeToolResult,
} from '@codebuff/common/types/print-mode'
import type { ToolName } from '@codebuff/sdk'
import type { MutableRefObject } from 'react'

export type SetStreamingAgentsFn = (
  updater: (prev: Set<string>) => Set<string>,
) => void

export type SetStreamStatusFn = (status: StreamStatus) => void

export type StreamChunkEvent =
  | string
  | {
      type: 'subagent_chunk'
      agentId: string
      agentType: string
      chunk: string
    }
  | {
      type: 'reasoning_chunk'
      agentId: string
      ancestorRunIds: string[]
      chunk: string
    }

export type StreamingState = {
  streamRefs: StreamController
  setStreamingAgents: SetStreamingAgentsFn
  setStreamStatus: SetStreamStatusFn
}

export type MessageState = {
  aiMessageId: string
  updater: MessageUpdater
  hasReceivedContentRef: MutableRefObject<boolean>
}

export type SubagentState = {
  addActiveSubagent: (id: string) => void
  removeActiveSubagent: (id: string) => void
}

export type ModeState = {
  agentMode: AgentMode
  setHasReceivedPlanResponse: (value: boolean) => void
}

export type EventHandlerState = {
  /** Reject late SDK callbacks after this run loses chat ownership. */
  isActive?: () => boolean
  streaming: StreamingState
  message: MessageState
  subagents: SubagentState
  mode: ModeState
  logger: Logger
  setIsRetrying: (retrying: boolean) => void
  onTotalCost?: (cost: number) => void
}

type TextDelta = { type: 'text' | 'reasoning'; text: string }

const hiddenToolNames = new Set<ToolName | 'spawn_agent_inline'>([
  'spawn_agent_inline',
  'end_turn',
  'spawn_agents',
])

const isHiddenToolName = (
  toolName: string,
): toolName is ToolName | 'spawn_agent_inline' =>
  hiddenToolNames.has(toolName as ToolName | 'spawn_agent_inline')

const ensureStreaming = (state: EventHandlerState) => {
  if (!state.message.hasReceivedContentRef.current) {
    state.message.hasReceivedContentRef.current = true
    state.streaming.setStreamStatus('streaming')
  }
}

const appendRootChunk = (state: EventHandlerState, delta: TextDelta) => {
  if (!delta.text) {
    return
  }

  state.message.updater.updateAiMessageBlocks((blocks) =>
    appendTextToRootStream(blocks, delta),
  )

  if (
    state.mode.agentMode === 'PLAN' &&
    delta.type === 'text' &&
    !state.streaming.streamRefs.state.planExtracted &&
    state.streaming.streamRefs.state.rootStreamBuffer.includes('</PLAN>')
  ) {
    const rawPlan = extractPlanFromBuffer(
      state.streaming.streamRefs.state.rootStreamBuffer,
    )
    if (rawPlan !== null) {
      state.streaming.streamRefs.setters.setPlanExtracted(true)
      state.mode.setHasReceivedPlanResponse(true)
      state.message.updater.updateAiMessageBlocks((blocks) =>
        insertPlanBlock(blocks, rawPlan),
      )
    }
  }
}

const updateStreamingAgents = (
  state: EventHandlerState,
  op: { add?: string; remove?: string },
) => {
  state.streaming.setStreamingAgents((prev) => {
    const next = new Set(prev)
    if (op.remove) {
      next.delete(op.remove)
    }
    if (op.add) {
      next.add(op.add)
    }
    return next
  })
}

const handleSubagentStart = (
  state: EventHandlerState,
  event: PrintModeSubagentStart,
) => {
  if (shouldHideAgent(event.agentType)) {
    return
  }

  state.subagents.addActiveSubagent(event.agentId)

  const spawnAgentMatch = findMatchingSpawnAgent(
    state.streaming.streamRefs.state.spawnAgentsMap,
    event.agentType || '',
  )

  if (spawnAgentMatch) {
    state.message.updater.updateAiMessageBlocks((blocks) =>
      resolveSpawnAgentToReal({
        blocks,
        match: spawnAgentMatch,
        realAgentId: event.agentId,
        realAgentType: event.agentType,
        parentAgentId: event.parentAgentId,
        params: event.params,
        prompt: event.prompt,
      }),
    )

    updateStreamingAgents(state, {
      remove: spawnAgentMatch.tempId,
      add: event.agentId,
    })
    state.streaming.streamRefs.setters.removeSpawnAgentInfo(
      spawnAgentMatch.tempId,
    )
    return
  }

  state.logger.info(
    {
      agentId: event.agentId,
      agentType: event.agentType,
      parentAgentId: event.parentAgentId || 'ROOT',
    },
    'Creating new agent block (no spawn_agents match)',
  )

  state.message.updater.updateAiMessageBlocks((blocks) => {
    // Look up the parent agent's type if there's a parent agent ID
    const parentAgentType = event.parentAgentId
      ? findAgentTypeById(blocks, event.parentAgentId)
      : undefined

    const newAgentBlock = createAgentBlock({
      agentId: event.agentId,
      agentType: event.agentType || '',
      prompt: event.prompt,
      params: event.params,
      parentAgentType,
    })

    if (event.parentAgentId) {
      const { blocks: nestedBlocks, parentFound } = nestBlockUnderParent(
        blocks,
        event.parentAgentId,
        newAgentBlock,
      )
      if (parentFound) {
        return nestedBlocks
      }
    }
    return [...blocks, newAgentBlock]
  })

  updateStreamingAgents(state, { add: event.agentId })
}

const handleSubagentFinish = (
  state: EventHandlerState,
  event: PrintModeSubagentFinish,
) => {
  if (shouldHideAgent(event.agentType)) {
    return
  }

  state.streaming.streamRefs.setters.removeAgentAccumulator(event.agentId)
  state.subagents.removeActiveSubagent(event.agentId)

  state.message.updater.updateAiMessageBlocks((blocks) =>
    markAgentComplete(blocks, event.agentId),
  )

  updateStreamingAgents(state, { remove: event.agentId })
}

const handleSpawnAgentsToolCall = (
  state: EventHandlerState,
  event: PrintModeToolCall,
) => {
  const agents = Array.isArray(event.input?.agents) ? event.input?.agents : []

  // Hidden agents get no block, so give them no spawn info or streaming id
  // either — an id with no block would linger until the tool result clears it.
  // Indices stay the original array positions so results still line up.
  const visibleAgents = agents
    .map((agent: any, index: number) => ({ agent, index }))
    .filter(({ agent }: any) => !shouldHideAgent(agent?.agent_type || ''))

  visibleAgents.forEach(({ agent, index }: any) => {
    const tempAgentId = `${event.toolCallId}-${index}`
    state.streaming.streamRefs.setters.setSpawnAgentInfo(tempAgentId, {
      index,
      agentType: agent.agent_type || 'unknown',
    })
  })

  state.message.updater.updateAiMessageBlocks((blocks) => {
    // Look up the parent agent's type if there's a parent agent ID
    const parentAgentType = event.agentId
      ? findAgentTypeById(blocks, event.agentId)
      : undefined

    const newAgentBlocks: ContentBlock[] = visibleAgents.map(
      ({ agent, index }: any) =>
        createAgentBlock({
          agentId: `${event.toolCallId}-${index}`,
          agentType: agent.agent_type || '',
          prompt: agent.prompt,
          params: agent.params,
          spawnToolCallId: event.toolCallId,
          spawnIndex: index,
          parentAgentType,
        }),
    )

    return [...blocks, ...newAgentBlocks]
  })

  visibleAgents.forEach(({ index }: any) => {
    updateStreamingAgents(state, { add: `${event.toolCallId}-${index}` })
  })
}

const handleRegularToolCall = (
  state: EventHandlerState,
  event: PrintModeToolCall,
) => {
  const newToolBlock: ToolContentBlock = {
    type: 'tool',
    toolCallId: event.toolCallId,
    toolName: event.toolName as ToolName,
    input: event.input,
    agentId: event.agentId,
    ...(event.includeToolCall !== undefined && {
      includeToolCall: event.includeToolCall,
    }),
  }

  if (event.parentAgentId && event.agentId) {
    state.message.updater.updateAiMessageBlocks((blocks) =>
      appendToolToAgentBlock(blocks, event.agentId as string, newToolBlock),
    )
    return
  }

  state.message.updater.updateAiMessageBlocks((blocks) => [
    ...blocks,
    newToolBlock,
  ])
}

const handleToolCall = (state: EventHandlerState, event: PrintModeToolCall) => {
  // Close any open native reasoning blocks when a tool call happens
  // (agent may go directly from thinking to tool calls without emitting text)
  // This must happen BEFORE any early returns (spawn_agents, hidden tools)
  if (event.parentAgentId && event.agentId) {
    // For agent tool calls, close reasoning in that specific agent
    state.message.updater.updateAiMessageBlocks((blocks) =>
      closeNativeReasoningInAgent(blocks, event.agentId as string),
    )
  } else if (!event.parentAgentId) {
    // For root tool calls, close reasoning at root level
    state.message.updater.updateAiMessageBlocks(closeNativeReasoningBlock)
  }

  if (event.toolName === 'spawn_agents' && event.input?.agents) {
    handleSpawnAgentsToolCall(state, event)
    return
  }

  if (isHiddenToolName(event.toolName)) {
    return
  }

  handleRegularToolCall(state, event)
  updateStreamingAgents(state, { add: event.toolCallId })
}

/**
 * Recursively finds and updates agent blocks that match a spawn_agents tool call.
 */
const updateSpawnAgentBlock = (
  block: ContentBlock,
  toolCallId: string,
  results: any[],
): ContentBlock | null => {
  if (block.type !== 'agent') {
    return block
  }

  const spawnIndex = block.spawnIndex
  const childBlocks = block.blocks
  const isSpawnResultTarget =
    block.spawnToolCallId === toolCallId &&
    spawnIndex !== undefined &&
    childBlocks

  if (isSpawnResultTarget) {
    const result = results[spawnIndex]
    if (result?.value) {
      const { content, hasError } = extractSpawnAgentResultContent(result.value)

      if (hasError) {
        if (childBlocks.length === 0) {
          return null
        }

        return {
          ...block,
          blocks: content
            ? [...childBlocks, { type: 'text', content } as ContentBlock]
            : childBlocks,
          status: 'complete' as const,
        }
      }

      // Agents like thinker return all output at the end via lastMessage,
      // while agents like basher may have already streamed their text.
      const hasStreamedTextContent = childBlocks.some(
        (b) => b.type === 'text' && b.textType === 'text',
      )
      const finalBlocks =
        content && !hasStreamedTextContent
          ? [...childBlocks, { type: 'text', content } as ContentBlock]
          : childBlocks

      if (finalBlocks.length > 0) {
        return {
          ...block,
          blocks: finalBlocks,
          status: 'complete' as const,
        }
      }
    }
  }

  if (!childBlocks?.length) {
    return block
  }

  return {
    ...block,
    blocks: updateSpawnAgentBlocks(childBlocks, toolCallId, results),
  }
}

const updateSpawnAgentBlocks = (
  blocks: ContentBlock[],
  toolCallId: string,
  results: any[],
): ContentBlock[] => {
  return blocks
    .map((block) => updateSpawnAgentBlock(block, toolCallId, results))
    .filter((block): block is ContentBlock => block !== null)
}

const handleSpawnAgentsResult = (
  state: EventHandlerState,
  toolCallId: string,
  results: any[],
) => {
  // Replace placeholder spawn agent blocks with their final text/status output.
  state.message.updater.updateAiMessageBlocks((blocks) =>
    updateSpawnAgentBlocks(blocks, toolCallId, results),
  )

  results.forEach((_, index: number) => {
    const agentId = `${toolCallId}-${index}`
    updateStreamingAgents(state, { remove: agentId })
  })
}

const handleToolResult = (
  state: EventHandlerState,
  event: PrintModeToolResult,
) => {
  const askUserResult = (event.output?.[0] as any)?.value
  state.message.updater.updateAiMessageBlocks((blocks) =>
    transformAskUserBlocks(blocks, {
      toolCallId: event.toolCallId,
      resultValue: askUserResult,
    }),
  )

  const firstOutput = event.output?.[0]
  const firstOutputValue =
    firstOutput && 'value' in firstOutput ? firstOutput.value : undefined
  const isSpawnAgentsResult =
    Array.isArray(firstOutputValue) &&
    firstOutputValue.some((v: any) => v?.agentName || v?.agentType)

  if (isSpawnAgentsResult && Array.isArray(firstOutputValue)) {
    handleSpawnAgentsResult(state, event.toolCallId, firstOutputValue)
    return
  }

  state.message.updater.updateAiMessageBlocks((blocks) =>
    updateToolBlockWithOutput(blocks, {
      toolCallId: event.toolCallId,
      toolOutput: event.output,
    }),
  )

  updateStreamingAgents(state, { remove: event.toolCallId })
}

const handleFinish = (state: EventHandlerState, event: PrintModeFinish) => {
  if (typeof event.totalCost === 'number' && state.onTotalCost) {
    state.onTotalCost(event.totalCost)
  }
}

const handleStreamError = (state: EventHandlerState, event: PrintModeError) => {
  if (!event.source) {
    // Sourceless error chunks already surface to the model as inline
    // tool-error messages; the UI intentionally stays quiet about them.
    return
  }
  // A `source` means an auto-recovered stream ending (connection cut, or
  // output budget burned on reasoning): the agent loop is taking another
  // step to continue. Show the transient retrying status; the next content
  // chunk (or run completion) clears it.
  state.logger.warn({ event }, 'Stream recovery; agent loop is retrying')
  state.setIsRetrying(true)
}

// ---------------------------------------------------------------- UI isolation
//
// These handlers only project SDK events onto the chat UI, but they run INSIDE
// the SDK's stream callback chain (sdk run.ts -> agent-runtime tool executor ->
// stream parser). A throw from a UI state update therefore escaped as an
// unhandled rejection, and the process-level handler turned it into a fatal
// exit: the agent run, the chat and the Freebuff session all died with it.
// Reported on Arch after 29 hours of uptime: React's "Maximum update depth
// exceeded" (#185), raised by the store notification inside
// `setStreamingAgents` (updateStreamingAgents <- handleToolCall).
//
// React raises #185 AFTER the store has taken the new value and resets its
// nested-update counter before throwing, so dropping one render notification is
// harmless: the next update renders the latest state. A missed repaint is
// always better than killing the run, so a failing UI update is logged (with
// its stack, to Axiom) and the run continues.

const MAX_UI_HANDLER_FAILURE_LOGS_PER_RUN = 3
const uiHandlerFailures = new WeakMap<EventHandlerState, number>()

const describeHandlerError = (error: unknown) => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message.slice(0, 500),
      stack: error.stack?.split('\n').slice(0, 20).join('\n'),
    }
  }
  return { message: String(error).slice(0, 500) }
}

const isolateUiHandler =
  <E>(
    state: EventHandlerState,
    handler: string,
    describe: (event: E) => string,
    handle: (event: E) => void,
  ) =>
  (event: E): void => {
    try {
      handle(event)
    } catch (error) {
      const failures = (uiHandlerFailures.get(state) ?? 0) + 1
      uiHandlerFailures.set(state, failures)
      if (failures > MAX_UI_HANDLER_FAILURE_LOGS_PER_RUN) return
      try {
        state.logger.error(
          {
            handler,
            sdkEvent: describe(event),
            failures,
            error: describeHandlerError(error),
          },
          'SDK event handler failed; the run continues',
        )
      } catch {
        // Reporting must never turn a UI failure back into a crash.
      }
    }
  }

export const createStreamChunkHandler = (state: EventHandlerState) =>
  isolateUiHandler<StreamChunkEvent>(
    state,
    'stream_chunk',
    (event) => (typeof event === 'string' ? 'text' : event.type),
    (event) => handleStreamChunk(state, event),
  )

const handleStreamChunk = (
  state: EventHandlerState,
  event: StreamChunkEvent,
): void => {
  if (state.isActive?.() === false) return
  const destination = destinationFromChunkEvent(event)
  let text: string | undefined
  if (typeof event === 'string') {
    text = event
  } else {
    text = event.chunk
  }

  if (!destination) {
    state.logger.warn({ event }, 'Unhandled stream chunk event')
    return
  }

  if (!text) {
    return
  }

  ensureStreaming(state)
  // Content is flowing (again) — clear any stream-interrupted retry status.
  // Terminal paths (run completion, error, abort) already reset it in
  // use-send-message/send-message, so the indicator can't outlive its run.
  // (No-op when already false: the immer store returns the same state.)
  state.setIsRetrying(false)

  if (destination.type === 'root') {
    if (destination.textType === 'text') {
      state.streaming.streamRefs.setters.appendRootStreamBuffer(text)
    }
    state.streaming.streamRefs.setters.setRootStreamSeen(true)
    appendRootChunk(state, { type: destination.textType, text })
    return
  }

  state.message.updater.updateAiMessageBlocks((blocks) =>
    processTextChunk(blocks, destination, text),
  )
}

export const createEventHandler = (state: EventHandlerState) =>
  isolateUiHandler<SDKEvent>(
    state,
    'event',
    (event) => event.type,
    (event) => handleSdkEvent(state, event),
  )

const handleSdkEvent = (state: EventHandlerState, event: SDKEvent): void => {
  // A cancelled run may still report its final billed cost. Keep that
  // accounting event, but reject every callback that could mutate the chat
  // or shared streaming UI after ownership has moved to another run.
  if (state.isActive?.() === false) {
    if (event.type === 'finish') handleFinish(state, event)
    return
  }
  return match(event)
    .with({ type: 'subagent_start' }, (e) => handleSubagentStart(state, e))
    .with({ type: 'subagent_finish' }, (e) => handleSubagentFinish(state, e))
    .with({ type: 'tool_call' }, (e) => handleToolCall(state, e))
    .with({ type: 'tool_result' }, (e) => handleToolResult(state, e))
    .with({ type: 'finish' }, (e) => handleFinish(state, e))
    .with({ type: 'error' }, (e) => handleStreamError(state, e))
    .otherwise(() => undefined)
}
