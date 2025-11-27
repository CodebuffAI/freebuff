import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type {
  AgentState,
  AgentOutput,
} from '@codebuff/common/types/session-state'

/**
 * Get the last assistant turn messages, which includes the last assistant message
 * and any subsequent tool messages that are responses to its tool calls.
 */
function getLastAssistantTurnMessages(messageHistory: Message[]): Message[] {
  // Find the index of the last assistant message
  let lastAssistantIndex = -1
  for (let i = messageHistory.length - 1; i >= 0; i--) {
    if (messageHistory[i].role === 'assistant') {
      lastAssistantIndex = i
      break
    }
  }

  for (let i = lastAssistantIndex; i >= 0; i--) {
    if (messageHistory[i].role === 'assistant') {
      lastAssistantIndex = i
    } else break
  }

  if (lastAssistantIndex === -1) {
    return []
  }

  // Collect the assistant message and all subsequent tool messages
  const result: Message[] = []
  for (let i = lastAssistantIndex; i < messageHistory.length; i++) {
    const message = messageHistory[i]
    if (message.role === 'assistant' || message.role === 'tool') {
      result.push(message)
    } else {
      // Stop if we hit a user or system message
      break
    }
  }

  return result
}

export function getAgentOutput(
  agentState: AgentState,
  agentTemplate: AgentTemplate,
): AgentOutput {
  if (agentTemplate.outputMode === 'structured_output') {
    return {
      type: 'structuredOutput',
      value: agentState.output ?? null,
    }
  }
  if (agentTemplate.outputMode === 'last_message') {
    const lastTurnMessages = getLastAssistantTurnMessages(
      agentState.messageHistory,
    )
    if (lastTurnMessages.length === 0) {
      return {
        type: 'error',
        message: 'No response from agent',
      }
    }
    return {
      type: 'lastMessage',
      value: lastTurnMessages,
    }
  }
  if (agentTemplate.outputMode === 'all_messages') {
    // Remove the first message, which includes the previous conversation history.
    const agentMessages = agentState.messageHistory.slice(1)
    return {
      type: 'allMessages',
      value: agentMessages,
    }
  }
  agentTemplate.outputMode satisfies never
  throw new Error(
    `Unknown output mode: ${'outputMode' in agentTemplate ? agentTemplate.outputMode : 'undefined'}`,
  )
}
