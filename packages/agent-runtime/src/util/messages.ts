import { AssertionError } from 'assert'

import { buildArray } from '@codebuff/common/util/array'
import { getErrorObject } from '@codebuff/common/util/error'
import { systemMessage, userMessage } from '@codebuff/common/util/messages'
import { closeXml } from '@codebuff/common/util/xml'
import { cloneDeep, isEqual } from 'lodash'

import { simplifyTerminalCommandResults } from './simplify-tool-results'
import { countTokensMessages } from './token-counter'

import type { System } from '../llm-api/claude'
import type {
  CodebuffToolMessage,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type {
  TextPart,
  ImagePart,
} from '@codebuff/common/types/messages/content-part'

export function messagesWithSystem(params: {
  messages: Message[]
  system: System
}): Message[] {
  const { messages, system } = params
  return [systemMessage(system), ...messages]
}

/**
 * Combines prompt, params, and content into a unified message content structure.
 */
export function buildUserMessageContent(
  prompt: string | undefined,
  params: Record<string, any> | undefined,
  content?: Array<TextPart | ImagePart>,
): Array<TextPart | ImagePart> {
  const promptHasNonWhitespaceText = (prompt ?? '').trim().length > 0

  // If we have content array (e.g., text + images)
  if (content && content.length > 0) {
    // Check if content has a non-empty text part
    const firstTextPart = content.find((p): p is TextPart => p.type === 'text')
    const hasNonEmptyText = firstTextPart && firstTextPart.text.trim()

    // If content has no meaningful text but prompt is provided, prepend prompt
    if (!hasNonEmptyText && promptHasNonWhitespaceText) {
      const nonTextContent = content.filter((p) => p.type !== 'text')
      return [{ type: 'text' as const, text: prompt! }, ...nonTextContent]
    }

    return content
  }

  // Only prompt/params, combine and return as simple text
  const textParts = buildArray([
    promptHasNonWhitespaceText ? prompt : undefined,
    params && JSON.stringify(params, null, 2),
  ])
  return [
    {
      type: 'text',
      text: textParts.join('\n\n'),
    },
  ]
}

const STEERING_TAG = 'user_message_sent_while_working'
const STEERING_OPEN = `<${STEERING_TAG}>`
const STEERING_CLOSE = closeXml(STEERING_TAG)
export const STEERING_NOTE =
  'The user sent this while you were working. Continue the earlier request too, unless this message changes or cancels it.'

/**
 * Frame a message the user sent mid-turn (steering). Delivered bare, it reads
 * as the whole new request, and models dropped the task they were doing to
 * answer it. Idempotent: already-framed text is returned unchanged.
 */
export function frameSteeringText(text: string): string {
  if (text.startsWith(STEERING_OPEN)) return text
  return `${STEERING_OPEN}\n${text}\n${STEERING_CLOSE}\n\n${STEERING_NOTE}`
}

/** The user's own words from a framed steering message; other text unchanged. */
export function unwrapSteeringText(text: string): string {
  if (!text.startsWith(STEERING_OPEN)) return text
  const end = text.lastIndexOf(STEERING_CLOSE)
  if (end === -1) return text
  return text.slice(STEERING_OPEN.length, end).replace(/^\n|\n$/g, '')
}

/** Frame the text of a steering message's content, keeping its images. */
export function frameSteeringContent(
  content: Array<TextPart | ImagePart>,
): Array<TextPart | ImagePart> {
  const index = content.findIndex((part) => part.type === 'text')
  if (index === -1) {
    return [{ type: 'text', text: frameSteeringText('') }, ...content]
  }
  return content.map((part, i) =>
    i === index && part.type === 'text'
      ? { ...part, text: frameSteeringText(part.text) }
      : part,
  )
}

export function parseUserMessage(str: string): string | undefined {
  const match = str.match(/<user_message>(.*?)<\/user_message>/s)
  return match ? match[1] : undefined
}

export function withSystemInstructionTags(str: string): string {
  return `<system_instructions>${str}${closeXml('system_instructions')}`
}

export function withSystemTags(str: string): string {
  return `<system>${str}${closeXml('system')}`
}

export function castAssistantMessage(message: Message): Message | null {
  if (message.role !== 'assistant') {
    return message
  }
  if (typeof message.content === 'string') {
    return userMessage(
      `<previous_assistant_message>${message.content}${closeXml('previous_assistant_message')}`,
    )
  }
  const content = buildArray(
    message.content.map((m) => {
      if (m.type === 'text') {
        return {
          ...m,
          text: `<previous_assistant_message>${m.text}${closeXml('previous_assistant_message')}`,
        }
      }
      return null
    }),
  )
  return content
    ? {
        role: 'user' as const,
        content,
      }
    : null
}

// Number of terminal command outputs to keep in full form before simplifying
const numTerminalCommandsToKeep = 5

function simplifyTerminalHelper(params: {
  toolResult: CodebuffToolOutput<'run_terminal_command'>
  numKept: number
  logger: Logger
}): { result: CodebuffToolOutput<'run_terminal_command'>; numKept: number } {
  const { toolResult, numKept, logger } = params
  const simplified = simplifyTerminalCommandResults({
    messageContent: toolResult,
    logger,
  })

  // Keep the full output for the N most recent commands
  if (numKept < numTerminalCommandsToKeep && !isEqual(simplified, toolResult)) {
    return { result: toolResult, numKept: numKept + 1 }
  }

  return {
    result: simplified,
    numKept,
  }
}

// Factor to reduce token count target by, to leave room for new messages
const shortenedMessageTokenFactor = 0.5
const replacementMessage = userMessage(
  withSystemTags('Previous message(s) omitted due to length'),
)

/**
 * Trims messages from the beginning to fit within token limits while preserving
 * important content. Also simplifies terminal command outputs to save tokens.
 *
 * The function:
 * 1. Processes messages from newest to oldest
 * 2. Simplifies terminal command outputs after keeping N most recent ones
 * 3. Stops adding messages when approaching token limit
 *
 * @param messages - Array of messages to trim
 * @param systemTokens - Number of tokens used by system prompt
 * @param maxTotalTokens - Maximum total tokens allowed, defaults to 200k
 * @returns Trimmed array of messages that fits within token limit
 */
export function trimMessagesToFitTokenLimit(params: {
  messages: Message[]
  systemTokens: number
  maxTotalTokens?: number
  logger: Logger
}): Message[] {
  const { messages, systemTokens, maxTotalTokens = 190_000, logger } = params
  const maxMessageTokens = maxTotalTokens - systemTokens

  // Check if we're already under the limit
  const initialTokens = countTokensMessages(messages)

  if (initialTokens < maxMessageTokens) {
    return messages
  }

  const shortenedMessages: Message[] = []
  let numKept = 0

  // Process messages from newest to oldest
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'system' || m.role === 'user' || m.role === 'assistant') {
      shortenedMessages.push(m)
    } else if (m.role === 'tool') {
      if (m.toolName !== 'run_terminal_command') {
        shortenedMessages.push(m)
        continue
      }

      const terminalResultMessage = cloneDeep(
        m,
      ) as CodebuffToolMessage<'run_terminal_command'>

      const result = simplifyTerminalHelper({
        toolResult: terminalResultMessage.content,
        numKept,
        logger,
      })
      terminalResultMessage.content = result.result
      numKept = result.numKept

      shortenedMessages.push(terminalResultMessage)
    } else {
      m satisfies never
      throw new AssertionError({
        message: `Not a valid role: ${(m as { role: unknown }).role}`,
      })
    }
  }
  shortenedMessages.reverse()

  const requiredTokens = countTokensMessages(
    shortenedMessages.filter((m) => m.keepDuringTruncation),
  )
  let removedTokens = 0
  const tokensToRemove =
    (maxMessageTokens - requiredTokens) * (1 - shortenedMessageTokenFactor)

  const placeholder = 'deleted'
  const filteredMessages: (Message | typeof placeholder)[] = []
  for (const message of shortenedMessages) {
    if (removedTokens >= tokensToRemove || message.keepDuringTruncation) {
      filteredMessages.push(message)
      continue
    }
    removedTokens += countTokensMessages([message])
    if (
      filteredMessages.length === 0 ||
      filteredMessages[filteredMessages.length - 1] !== placeholder
    ) {
      filteredMessages.push(placeholder)
      removedTokens -= countTokensMessages([replacementMessage])
    }
  }

  return filteredMessages.map((m) =>
    m === placeholder ? replacementMessage : m,
  )
}

export function getMessagesSubset(params: {
  messages: Message[]
  otherTokens: number
  logger: Logger
}): Message[] {
  const { messages, otherTokens, logger } = params
  const messagesSubset = trimMessagesToFitTokenLimit({
    messages,
    systemTokens: otherTokens,
    logger,
  })

  // Remove cache_control from all messages
  for (const message of messagesSubset) {
    for (const provider of ['anthropic', 'openrouter', 'codebuff'] as const) {
      delete message.providerOptions?.[provider]?.cacheControl
    }
  }

  // Cache up to the last message!
  const lastMessage = messagesSubset[messagesSubset.length - 1]
  if (!lastMessage) {
    logger.debug(
      {
        messages,
        messagesSubset,
        otherTokens,
      },
      'No last message found in messagesSubset!',
    )
  }

  return messagesSubset
}

export function expireMessages(
  messages: Message[],
  endOf: 'agentStep' | 'userPrompt',
): Message[] {
  return messages.filter((m) => {
    // Keep messages with no timeToLive
    if (m.timeToLive === undefined) return true

    // Remove messages that have expired
    if (m.timeToLive === 'agentStep') return false
    if (m.timeToLive === 'userPrompt' && endOf === 'userPrompt') return false

    return true
  })
}

export function getPreviouslyReadFiles(params: {
  messages: Message[]
  logger: Logger
}): {
  path: string
  content: string
  referencedBy?: Record<string, string[]>
}[] {
  const { messages, logger } = params
  const files: ReturnType<typeof getPreviouslyReadFiles> = []
  for (const message of messages) {
    if (message.role !== 'tool') continue
    if (message.toolName === 'read_files') {
      try {
        files.push(
          ...(
            message as CodebuffToolMessage<'read_files'>
          ).content[0].value.filter(
            (
              file,
            ): file is typeof file & { contentOmittedForLength: undefined } =>
              !('contentOmittedForLength' in file),
          ),
        )
      } catch (error) {
        logger.error(
          { error: getErrorObject(error), message },
          'Error parsing read_files output from message',
        )
      }
    }

    if (message.toolName === 'find_files') {
      try {
        const v = (message as CodebuffToolMessage<'find_files'>).content[0]
          .value
        if ('message' in v) {
          continue
        }
        files.push(
          ...v.filter(
            (
              file,
            ): file is typeof file & { contentOmittedForLength: undefined } =>
              !('contentOmittedForLength' in file),
          ),
        )
      } catch (error) {
        logger.error(
          { error: getErrorObject(error), message },
          'Error parsing find_files output from message',
        )
      }
    }
  }
  return files
}
