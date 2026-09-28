import { assistantContent } from '@codebuff/common/util/messages'

import { stripThinkScaffolding } from './think-tag-stream'

import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type {
  AgentState,
  AgentOutput,
} from '@codebuff/common/types/session-state'

/** Messages tagged with these tags are stripped from agent output. */
const EXCLUDED_OUTPUT_TAGS = ['TOOL_CALL_ERROR'] as const

function isExcludedFromOutput(message: Message): boolean {
  return !!message.tags?.some((t) =>
    (EXCLUDED_OUTPUT_TAGS as readonly string[]).includes(t),
  )
}

/**
 * Get the last assistant turn messages, which includes the last assistant
 * message and any subsequent tool messages that are responses to its tool
 * calls.
 *
 * Turn selection walks the raw `messageHistory` so that user-role messages
 * (including synthesized TOOL_CALL_ERROR ones) correctly bound the turn —
 * otherwise a failed attempt + its retry would get conflated into a single
 * "turn". Exclusion filtering is applied *after* selection: TOOL_CALL_ERROR
 * messages are user-role so they never enter `result` anyway (the role check
 * below stops at user messages), but keeping the filter explicit documents
 * the contract that no excluded tags leak into agent output.
 */
function getLastAssistantTurnMessages(messageHistory: Message[]): Message[] {
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

  const result: Message[] = []
  for (let i = lastAssistantIndex; i < messageHistory.length; i++) {
    const message = messageHistory[i]
    if (message.role === 'assistant' || message.role === 'tool') {
      result.push(message)
    } else {
      // Stop if we hit a user or system message.
      break
    }
  }

  return result.filter((m) => !isExcludedFromOutput(m))
}

const noResponse = (): AgentOutput => ({
  type: 'error',
  message: 'No response from agent',
})

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
      return noResponse()
    }
    return {
      type: 'lastMessage',
      value: lastTurnMessages,
    }
  }
  if (agentTemplate.outputMode === 'all_messages') {
    // Remove the first message, which includes the previous conversation history.
    const agentMessages = agentState.messageHistory
      .slice(1)
      .filter((m) => !isExcludedFromOutput(m))
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

/** A spawned agent's output as its parent receives it: a `last_message`
 *  agent's answer as plain text, or an error if it wrote none. */
export function outputForParent(output: AgentOutput): AgentOutput | string {
  if (output.type !== 'lastMessage') return output
  return answerText(output.value as Message[]) || noResponse()
}

/** The text of a turn's assistant messages, without reasoning or think tags. */
function answerText(messages: Message[]): string {
  return messages
    .flatMap((message) =>
      // set_messages stores messages as given, so content can be a bare string.
      message.role === 'assistant' ? assistantContent(message.content) : [],
    )
    .map((part) =>
      part.type === 'text' ? stripThinkScaffolding(part.text) : '',
    )
    .filter((text) => text.trim())
    .join('\n')
    .trim()
}
