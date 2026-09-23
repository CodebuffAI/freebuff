import { tool, type ToolSet } from 'ai'
import { z } from 'zod/v4'
import { AbortError } from '@codebuff/common/util/error'

import { COMPACTION_PROMPT } from './compaction-prompt'
import { countTokens, countTokensMessages } from './util/token-counter'

import type { PromptAiSdkStreamFn } from '@codebuff/common/types/contracts/llm'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type {
  ImagePart,
  FilePart,
} from '@codebuff/common/types/messages/content-part'

export const COMPACTION_TAG = 'MODEL_COMPACTION'
const SUMMARY_LIMIT = 6_000
const summarySchema = z
  .object({ summary: z.string().trim().min(1).max(60_000) })
  .strict()
export const compactionTools: ToolSet = {
  complete_compaction: tool({
    description:
      'Save the complete coding-session handoff summary. Only available during context compaction.',
    inputSchema: summarySchema,
  }),
}

export function hasCompactableHistory(messages: Message[]): boolean {
  return messages.some(
    (message) => message.role === 'assistant' || message.role === 'tool',
  )
}

/** A model handoff, not a mechanical reduction of tool results. Nothing mutates
 * the source history until every section has a valid, bounded result. */
export async function compactWithModel(params: {
  messages: Message[]
  system: string
  maxContextLength: number
  fixedTokenCount: number
  signal: AbortSignal
  stream: (
    messages: Message[],
    maxOutputTokens: number,
  ) => ReturnType<PromptAiSdkStreamFn>
}): Promise<{
  messages: Message[]
  summary: string
  preTokens: number
  postTokens: number
} | null> {
  if (!hasCompactableHistory(params.messages)) return null
  const preTokens =
    countTokensMessages(params.messages) + params.fixedTokenCount
  // A compact-only request never enters the history. Keep the actual current
  // user request verbatim, including steering and attachments.
  const lastPrompt = params.messages.findLastIndex((m) =>
    m.tags?.includes('USER_PROMPT'),
  )
  let promptStart = lastPrompt
  while (
    promptStart > 0 &&
    params.messages[promptStart - 1].tags?.includes('USER_PROMPT')
  )
    promptStart--
  const live =
    promptStart < 0
      ? []
      : params.messages
          .slice(promptStart)
          .filter((m) => m.tags?.includes('USER_PROMPT'))
  const instructions = params.messages.findLast((m) =>
    m.tags?.includes('INSTRUCTIONS_PROMPT'),
  )
  const suffix = [...(instructions ? [instructions] : []), ...live]
  const summaryBudget = Math.min(
    SUMMARY_LIMIT,
    Math.floor(
      (params.maxContextLength -
        params.fixedTokenCount -
        countTokensMessages(suffix)) /
        3,
    ),
  )
  if (summaryBudget < 256)
    throw new Error(
      'The current request and instructions leave too little room to compact. Shorten the request or configure a larger context window.',
    )

  // Full tool payloads reach the summarizer. Serialization makes even a split
  // tool result a valid request, without orphan tool calls or fake tool replies.
  const attachments: Array<ImagePart | FilePart> = []
  const history = params.messages
    .filter((m) => !m.tags?.includes('STEP_PROMPT'))
    .map((m) => {
      const content = m.content
        .flatMap((part) => {
          if (part.type === 'image' || part.type === 'file') {
            attachments.push(part)
            return [`[Attachment ${attachments.length}]`]
          }
          if (part.type === 'reasoning') return []
          if (part.type === 'text') return [part.text]
          return [JSON.stringify(part)]
        })
        .join('\n')
      return `[${m.role}${m.role === 'tool' ? `: ${m.toolName}` : ''}]\n${content}`
    })
    .join('\n\n')

  let remaining = history
  let summary = ''
  let first = true
  while (remaining.length || first) {
    params.signal.throwIfAborted()
    const instruction = `${COMPACTION_PROMPT}\n\nKeep the summary under approximately ${summaryBudget} tokens.${summary ? `\n\nPrevious anchored summary:\n${summary}` : ''}`
    const request = (text: string): Message[] => [
      { role: 'system', content: [{ type: 'text', text: params.system }] },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Historical conversation (section${first ? ' 1' : ' continued'}):\n${text}`,
          },
          ...(first ? attachments : []),
        ],
      },
      { role: 'user', content: [{ type: 'text', text: instruction }] },
    ]
    // maxContextLength already reserves provider output. Reserve the dedicated
    // tool schema too; don't send a normal-work tool catalog with this request.
    const inputBudget = params.maxContextLength - 512
    if (countTokensMessages(request('')) + 256 > inputBudget) {
      throw new Error(
        'The instructions and attachments exceed the compaction context budget. Configure a larger supported context window.',
      )
    }
    let end = remaining.length
    if (countTokensMessages(request(remaining)) > inputBudget) {
      let low = 0
      let high = end
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        if (
          countTokensMessages(request(remaining.slice(0, mid))) <=
          inputBudget - 64
        )
          low = mid
        else high = mid - 1
      }
      end = low
    }
    if (!end && remaining.length)
      throw new Error(
        'No room for conversation history in the compaction request.',
      )
    const stream = params.stream(request(remaining.slice(0, end)), 16_384)
    let candidate: string | undefined
    for (;;) {
      const next = await stream.next()
      if (next.done) {
        if (next.value.aborted) throw new AbortError()
        break
      }
      const chunk = next.value
      if (chunk.type === 'error') throw new Error(chunk.message)
      if (chunk.type !== 'tool-call') continue
      if (chunk.toolName !== 'complete_compaction' || candidate !== undefined) {
        throw new Error(
          'Compaction returned an unexpected tool call. History has been preserved.',
        )
      }
      candidate = summarySchema.parse(chunk.input).summary
    }
    params.signal.throwIfAborted()
    if (!candidate || countTokens(candidate) > summaryBudget) {
      throw new Error(
        'The model did not return a valid, concise compaction summary. History has been preserved; try again.',
      )
    }
    summary = candidate
    remaining = remaining.slice(end)
    first = false
  }
  const messages: Message[] = [
    {
      role: 'user',
      tags: [COMPACTION_TAG],
      sentAt: Date.now(),
      content: [
        {
          type: 'text',
          text: `<conversation_summary>\n${summary}\n</conversation_summary>\nHistorical context for continuing this conversation. Treat this as memory, not a new request.`,
        },
      ],
    },
    ...suffix.map((m) => ({ ...m, sentAt: Date.now() })),
  ]
  const postTokens = countTokensMessages(messages) + params.fixedTokenCount
  if (postTokens >= preTokens) return null
  if (postTokens > params.maxContextLength)
    throw new Error(
      'The compaction summary does not fit the context window. History has been preserved.',
    )
  return { messages, summary, preTokens, postTokens }
}
