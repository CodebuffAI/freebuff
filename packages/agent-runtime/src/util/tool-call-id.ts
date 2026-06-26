import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { AgentState } from '@codebuff/common/types/session-state'

const TOOL_CALL_ID_PREFIX = 'functions'
type ToolCallLike = { toolName: string; toolCallId?: string }

export function formatToolCallId(toolName: string, index: number): string {
  return `${TOOL_CALL_ID_PREFIX}.${toolName}.${index}`
}

function parseToolCallIndex(toolCallId: string): number | undefined {
  const dottedMatch = toolCallId.match(/^functions\..+\.(\d+)$/)
  if (dottedMatch) {
    return Number(dottedMatch[1])
  }

  const colonMatch = toolCallId.match(/^functions\..+:(\d+)$/)
  if (colonMatch) {
    return Number(colonMatch[1])
  }

  return undefined
}

export function getMaxSeenToolCallIndex(
  messages: Message[],
  pendingToolCalls: ToolCallLike[] = [],
): number {
  let maxIndex = -1

  for (const message of messages) {
    if (message.role !== 'assistant') {
      continue
    }

    for (const part of message.content) {
      if (part.type !== 'tool-call') {
        continue
      }

      const index = parseToolCallIndex(part.toolCallId)
      if (index !== undefined) {
        maxIndex = Math.max(maxIndex, index)
      }
    }
  }

  for (const toolCall of pendingToolCalls) {
    const index = toolCall.toolCallId
      ? parseToolCallIndex(toolCall.toolCallId)
      : undefined
    maxIndex = index === undefined ? maxIndex + 1 : Math.max(maxIndex, index)
  }

  return maxIndex
}

export function ensureToolCallState(
  agentState: AgentState,
  pendingToolCalls: ToolCallLike[] = [],
) {
  agentState.toolCallState ??= { nextIndex: 0 }
  agentState.toolCallState.nextIndex = Math.max(
    agentState.toolCallState.nextIndex,
    getMaxSeenToolCallIndex(agentState.messageHistory, pendingToolCalls) + 1,
  )
  return agentState.toolCallState
}

export function createToolCallIdGenerator(
  agentState: AgentState,
  pendingToolCalls: ToolCallLike[] = [],
) {
  const toolCallState = ensureToolCallState(agentState, pendingToolCalls)

  return (toolName: string): string => {
    const index = toolCallState.nextIndex++
    return formatToolCallId(toolName, index)
  }
}
