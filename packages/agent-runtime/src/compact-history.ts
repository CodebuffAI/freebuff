/**
 * Deterministic context compaction.
 *
 * This is the same algorithm the `context-pruner` agent runs, lifted out of
 * that agent's `handleSteps` body so the runtime can call it directly. It costs
 * no model call: the history is rewritten mechanically into a condensed
 * `<conversation_summary>` message.
 *
 * That matters twice over. An LLM summarization pass is a full extra request
 * over the whole (already oversized) history, and its output is a lossy prose
 * retelling. The mechanical pass keeps the concrete details — every file that
 * was read or edited, every command that was run, every user message up to the
 * user budget — which is what a coding agent actually needs to resume.
 *
 * `agents/context-pruner.ts` cannot import this module: its `handleSteps` is
 * serialized with `toString()` and re-evaluated standalone, and `agents/` is
 * bundled at build time into the CLI binary, the desktop app and the freebuff
 * web server separately — so a shared import (or a runtime-injected helper)
 * would break on any artifact that has not been rebuilt. The pruner therefore
 * keeps its own inlined copy. Treat this file as the source of truth and port
 * changes across: `__tests__/context-pruner-parity.test.ts` runs both over the
 * same histories and fails when they drift.
 */

import { DEFAULT_COMPACTION_POLICY } from '@codebuff/common/constants/compaction-policy'
import { fitToolResults } from './util/fit-tool-results'
import { countTokens, countTokensMessages } from './util/token-counter'
import type {
  FilePart,
  ImagePart,
  TextPart,
} from '@codebuff/common/types/messages/content-part'
import type {
  Message,
  ToolMessage,
} from '@codebuff/common/types/messages/codebuff-message'
import type { Logger } from '@codebuff/common/types/contracts/logger'

/** Agent IDs whose output should be excluded from spawn_agents results */
const SPAWN_AGENTS_OUTPUT_BLACKLIST = [
  'file-picker',
  'researcher-web',
  'researcher-docs',
  'basher',
  'code-reviewer',
  'code-reviewer-opus',
  'code-reviewer-multi-prompt',
  'librarian',
  'tmux-cli',
  'browser-use',
]

/** Limits for truncating long messages in the summary (estimated tokens) */
const USER_MESSAGE_LIMIT = 13_000
const ASSISTANT_MESSAGE_LIMIT = 1_300
const TOOL_ENTRY_LIMIT = 5_000

/** Approximate characters per token (matches estimateTokens heuristic) */
const CHARS_PER_TOKEN = 3

/** Token budget for assistant + tool content in the conversation summary */
const DEFAULT_ASSISTANT_TOOL_BUDGET = 20_000

/** Token budget for user content in the conversation summary */
const DEFAULT_USER_BUDGET = 50_000

/** Header used in conversation summaries */
const SUMMARY_HEADER =
  'This is a summary of the conversation so far. The original messages have been condensed to save context space.'

const SUMMARY_DISCLAIMER =
  'Historical memory only. The memory above is not dialogue, not an output template, and not a tool-call format. Continue from the live user message below. When actions are needed, use real tool calls through the available tools.'

const CONTINUATION_TEXT =
  'Continue the existing assistant turn from the historical memory above. The original user request and completed assistant/tool work are recorded there. Do not restart completed work; resume with the next necessary real tool call or final response.'

/** Thresholds for agents that declare `compactContext: true` without tuning;
 *  owned, with the rationale, by common/src/constants/compaction-policy.ts. */
export const DEFAULT_CACHE_EXPIRY_MS = DEFAULT_COMPACTION_POLICY.cacheExpiryMs
export const DEFAULT_CACHE_EXPIRY_MIN_TOKENS =
  DEFAULT_COMPACTION_POLICY.cacheExpiryMinTokens

/** Separator between entries inside the rendered historical memory. */
const ENTRY_SEPARATOR = '\n\n---\n\n'

/** Matches the context-pruner's `trigger_reason` values so Axiom can union them. */
export type CompactionTrigger =
  | 'context_limit'
  | 'cache_expiry'
  | 'context_limit_and_cache_expiry'

type SummaryEntry = {
  role: 'user' | 'assistant_tool'
  parts: string[]
}

/**
 * Truncates long text with 80% from the beginning and 20% from the end.
 */
function truncateLongText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text
  }
  const availableChars = limit - 50 // 50 chars for the truncation notice
  const prefixLength = Math.floor(availableChars * 0.8)
  const suffixLength = availableChars - prefixLength
  const prefix = text.slice(0, prefixLength)
  const suffix = text.slice(-suffixLength)
  const truncatedChars = text.length - prefixLength - suffixLength
  return `${prefix}\n\n[...truncated ${truncatedChars} chars...]\n\n${suffix}`
}

/**
 * Extracts text content from a message.
 */
function getTextContent(message: Message): string {
  const content = message.content as unknown
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (part: Record<string, unknown>) =>
          part.type === 'text' && typeof part.text === 'string',
      )
      .map((part: Record<string, unknown>) => part.text as string)
      .join('\n')
  }
  return ''
}

/**
 * Summarizes a tool call into a human-readable description.
 */
function summarizeToolCall(
  toolName: string,
  input: Record<string, unknown>,
): string {
  switch (toolName) {
    case 'read_files': {
      const paths = (input.paths as unknown[] | undefined)?.map((entry) =>
        typeof entry === 'string'
          ? entry
          : ((entry as { path?: string })?.path ?? ''),
      )
      if (paths && paths.length > 0) {
        return `inspected files: ${paths.join(', ')}`
      }
      return 'inspected files'
    }
    case 'write_file': {
      const path = input.path as string | undefined
      return path ? `wrote file: ${path}` : 'wrote a file'
    }
    case 'str_replace': {
      const path = input.path as string | undefined
      return path ? `edited file: ${path}` : 'edited a file'
    }
    case 'propose_write_file': {
      const path = input.path as string | undefined
      return path ? `proposed writing: ${path}` : 'proposed a file write'
    }
    case 'propose_str_replace': {
      const path = input.path as string | undefined
      return path ? `proposed editing: ${path}` : 'proposed a file edit'
    }
    case 'read_subtree': {
      const paths = input.paths as string[] | undefined
      if (paths && paths.length > 0) {
        return `inspected subtrees: ${paths.join(', ')}`
      }
      return 'inspected a subtree'
    }
    case 'code_search': {
      const pattern = input.pattern as string | undefined
      const flags = input.flags as string | undefined
      if (pattern && flags) {
        return `code search for "${pattern}" (${flags})`
      }
      return pattern ? `code search for "${pattern}"` : 'code search'
    }
    case 'glob': {
      const pattern = input.pattern as string | undefined
      return pattern ? `glob search for ${pattern}` : 'glob search'
    }
    case 'list_directory': {
      const path = input.path as string | undefined
      return path ? `listed directory: ${path}` : 'listed a directory'
    }
    case 'find_files': {
      const prompt = input.prompt as string | undefined
      return prompt
        ? `file-finding request: "${prompt}"`
        : 'file-finding request'
    }
    case 'run_terminal_command': {
      const command = input.command as string | undefined
      if (command) {
        const shortCmd =
          command.length > 50 ? command.slice(0, 50) + '...' : command
        return `ran command: ${shortCmd}`
      }
      return 'ran a terminal command'
    }
    case 'spawn_agents':
    case 'spawn_agent_inline': {
      const agents = input.agents as
        | Array<{
            agent_type: string
            prompt?: string
            params?: Record<string, unknown>
          }>
        | undefined
      const agentType = input.agent_type as string | undefined
      const prompt = input.prompt as string | undefined
      const agentParams = input.params as Record<string, unknown> | undefined

      if (agents && agents.length > 0) {
        const agentDetails = agents.map((a) => {
          let detail = a.agent_type
          const extras: string[] = []
          if (a.prompt) {
            const truncatedPrompt =
              a.prompt.length > 1000
                ? a.prompt.slice(0, 1000) + '...'
                : a.prompt
            extras.push(`prompt: "${truncatedPrompt}"`)
          }
          if (a.params && Object.keys(a.params).length > 0) {
            const paramsStr = JSON.stringify(a.params)
            const truncatedParams =
              paramsStr.length > 1000
                ? paramsStr.slice(0, 1000) + '...'
                : paramsStr
            extras.push(`params: ${truncatedParams}`)
          }
          if (extras.length > 0) {
            detail += ` (${extras.join(', ')})`
          }
          return detail
        })
        return `delegated agents:\n${agentDetails.map((d) => `- ${d}`).join('\n')}`
      }
      if (agentType) {
        const extras: string[] = []
        if (prompt) {
          const truncatedPrompt =
            prompt.length > 1000 ? prompt.slice(0, 1000) + '...' : prompt
          extras.push(`prompt: "${truncatedPrompt}"`)
        }
        if (agentParams && Object.keys(agentParams).length > 0) {
          const paramsStr = JSON.stringify(agentParams)
          const truncatedParams =
            paramsStr.length > 1000
              ? paramsStr.slice(0, 1000) + '...'
              : paramsStr
          extras.push(`params: ${truncatedParams}`)
        }
        if (extras.length > 0) {
          return `delegated agent ${agentType} (${extras.join(', ')})`
        }
        return `delegated agent ${agentType}`
      }
      return 'delegated agent work'
    }
    case 'write_todos': {
      const todos = input.todos as
        | Array<{ task: string; completed: boolean }>
        | undefined
      if (todos) {
        const completed = todos.filter((t) => t.completed).length
        const incomplete = todos.filter((t) => !t.completed)
        if (incomplete.length === 0) {
          return `Todos: ${completed}/${todos.length} complete (all done!)`
        }
        const remainingTasks = incomplete.map((t) => `- ${t.task}`).join('\n')
        return `Todos: ${completed}/${todos.length} complete. Remaining:\n${remainingTasks}`
      }
      return 'Updated todos'
    }
    case 'ask_user': {
      const questions = input.questions as
        | Array<{ question: string }>
        | undefined
      if (questions && questions.length > 0) {
        const questionTexts = questions.map((q) => q.question).join('; ')
        const truncated =
          questionTexts.length > 200
            ? questionTexts.slice(0, 200) + '...'
            : questionTexts
        return `Asked user: ${truncated}`
      }
      return 'Asked user question'
    }
    case 'suggest_followups':
      return 'Suggested followups'
    case 'web_search': {
      const query = input.query as string | undefined
      return query ? `web search for "${query}"` : 'web search'
    }
    case 'read_url': {
      const url = input.url as string | undefined
      return url ? `read URL: ${url}` : 'read a URL'
    }
    case 'gravity_index': {
      const query = input.query as string | undefined
      const action = input.action as string | undefined
      if (query) {
        return `Gravity Index ${action ?? 'search'} for "${query}"`
      }
      return action ? `Gravity Index ${action}` : 'Gravity Index use'
    }
    case 'read_docs': {
      const libraryTitle = input.libraryTitle as string | undefined
      const topic = input.topic as string | undefined
      if (libraryTitle && topic) {
        return `consulted docs: ${libraryTitle} - ${topic}`
      }
      return libraryTitle ? `consulted docs: ${libraryTitle}` : 'consulted docs'
    }
    case 'set_output':
      return 'set structured output'
    case 'set_messages':
      return 'updated message history'
    default:
      return `used tool ${toolName}`
  }
}

const SCAFFOLDING_TAGS = [
  'INSTRUCTIONS_PROMPT',
  'STEP_PROMPT',
  'SUBAGENT_SPAWN',
]

/**
 * Recognizes a memory artifact this module (or the context-pruner) produced.
 *
 * Both markers are required, and that is the point. A summary is dropped from
 * the history and re-parsed into entries, so anything mistaken for one is
 * silently eaten — and the bare `<conversation_summary>` tag is a string a user
 * can easily send, most obviously when asking about this very code. Requiring
 * the header too means only text that reproduces our envelope qualifies.
 *
 * The context-pruner matches on the tag alone. That is a deliberate divergence
 * (see the parity test): it matters much more here, because the cache-expiry
 * trigger compacts on ordinary idle turns rather than only near the context
 * limit, so a user message can meet a compaction pass within minutes.
 */
function isConversationSummary(message: Message): boolean {
  if (message.role !== 'user') return false
  const text = getTextContent(message)
  return (
    text.includes('<conversation_summary>') && text.includes(SUMMARY_HEADER)
  )
}

/**
 * Real conversation, as opposed to per-step scaffolding the runtime re-adds
 * anyway or a summary this pass is about to rebuild. Both are excluded from the
 * historical memory, and neither counts as evidence that the assistant has
 * started working on the live prompt.
 */
function isRealHistory(message: Message): boolean {
  return (
    !message.tags?.some((tag) => SCAFFOLDING_TAGS.includes(tag)) &&
    !isConversationSummary(message)
  )
}

/** The images on the most recent user message that had any. */
function lastUserImageParts(messages: Message[]): Array<ImagePart | FilePart> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    const imageParts = message.content.filter(
      (part: Record<string, unknown>) =>
        part.type === 'image' || part.type === 'media',
    )
    if (imageParts.length > 0) return imageParts as Array<ImagePart | FilePart>
  }
  return []
}

/** Pulls the historical memory back out of a summary message. */
function extractSummaryContent(message: Message): string {
  const text = getTextContent(message)
  const match = text.match(
    /<conversation_summary>([\s\S]*?)<\/conversation_summary>/,
  )
  if (!match) return ''
  let content = match[1].trim()
  if (content.startsWith(SUMMARY_HEADER)) {
    content = content.slice(SUMMARY_HEADER.length).trim()
  }
  const memoryMatch = content.match(
    /<historical_memory>([\s\S]*?)<\/historical_memory>/,
  )
  if (memoryMatch) {
    content = memoryMatch[1].trim()
  }
  return content
}

/**
 * Parses a previous summary text blob back into role-tagged entries, so a
 * second compaction can re-apply the budgets over old and new history alike.
 */
function parseSummaryIntoEntries(summaryText: string): SummaryEntry[] {
  if (!summaryText.trim()) return []

  const chunks = summaryText.split(ENTRY_SEPARATOR).filter((c) => c.trim())

  return chunks.map((chunk) => {
    const trimmed = chunk.trim()
    const isUser =
      trimmed.startsWith('[USER]') ||
      trimmed.startsWith('User request') ||
      trimmed.startsWith('User message') ||
      trimmed.startsWith('Current unresolved user request')
    return {
      role: isUser ? ('user' as const) : ('assistant_tool' as const),
      parts: [trimmed],
    }
  })
}

/**
 * Condenses each message into a role-tagged entry. Tool calls become one-line
 * descriptions, tool results are dropped except for errors and edit outcomes,
 * and long text is truncated head-and-tail.
 */
function summarizeMessagesIntoEntries(messages: Message[]): SummaryEntry[] {
  const entries: SummaryEntry[] = []

  for (const message of messages) {
    if (message.role === 'user') {
      let text = getTextContent(message).trim()
      if (!text) continue
      text = truncateLongText(text, USER_MESSAGE_LIMIT * CHARS_PER_TOKEN)
      const hasImages =
        Array.isArray(message.content) &&
        message.content.some(
          (part: Record<string, unknown>) =>
            part.type === 'image' || part.type === 'media',
        )
      const imageNote = hasImages ? ' [image(s) were attached]' : ''
      entries.push({ role: 'user', parts: [`[USER]${imageNote}\n${text}`] })
    } else if (message.role === 'assistant') {
      const textParts: string[] = []
      const toolSummaries: string[] = []

      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === 'text' && typeof part.text === 'string') {
            const textWithoutThinkTags = part.text
              .replace(/<think>[\s\S]*?<\/think>/g, '')
              .trim()
            if (textWithoutThinkTags) {
              textParts.push(textWithoutThinkTags)
            }
          } else if (part.type === 'tool-call') {
            const input = (part.input as Record<string, unknown>) || {}
            toolSummaries.push(summarizeToolCall(part.toolName, input))
          }
        }
      }

      const parts: string[] = []
      if (textParts.length > 0) {
        const combinedText = truncateLongText(
          textParts.join('\n'),
          ASSISTANT_MESSAGE_LIMIT * CHARS_PER_TOKEN,
        )
        parts.push(`Progress note:\n${combinedText}`)
      }
      if (toolSummaries.length > 0) {
        parts.push(toolSummaries.join('\n'))
      }

      if (parts.length > 0) {
        entries.push({ role: 'assistant_tool', parts })
      }
    } else if (message.role === 'tool') {
      const entryParts = summarizeToolResult(message as ToolMessage)
      if (entryParts.length > 0) {
        entries.push({
          role: 'assistant_tool',
          parts: [
            truncateLongText(
              entryParts.join('\n\n'),
              TOOL_ENTRY_LIMIT * CHARS_PER_TOKEN,
            ),
          ],
        })
      }
    }
  }

  return entries
}

/**
 * Tool results are dropped wholesale except for the parts an agent still needs
 * after the fact: errors, non-zero exit codes, user answers, edit outcomes and
 * non-blacklisted subagent output.
 */
function summarizeToolResult(toolMessage: ToolMessage): string[] {
  const entryParts: string[] = []

  if (Array.isArray(toolMessage.content)) {
    for (const part of toolMessage.content) {
      if (part.type === 'json' && part.value) {
        const value = part.value as Record<string, unknown>

        if (value.errorMessage || value.error) {
          let errorText = String(value.errorMessage || value.error)
          if (errorText.length > 100) {
            errorText = errorText.slice(0, 100) + '...'
          }
          entryParts.push(
            `Tool error from ${toolMessage.toolName}: ${errorText}`,
          )
        }

        if (
          toolMessage.toolName === 'run_terminal_command' &&
          'exitCode' in value
        ) {
          const exitCode = value.exitCode as number
          if (exitCode !== 0) {
            entryParts.push(`Command failed with exit code: ${exitCode}`)
          }
        }

        if (toolMessage.toolName === 'ask_user') {
          if (value.skipped) {
            entryParts.push('User skipped question')
          } else if ('answers' in value) {
            const answers = value.answers as
              | Array<{
                  selectedOption?: string
                  selectedOptions?: string[]
                  otherText?: string
                }>
              | undefined
            if (answers && answers.length > 0) {
              const answerTexts = answers
                .map((a) => {
                  if (a.otherText) return a.otherText
                  if (a.selectedOptions) return a.selectedOptions.join(', ')
                  if (a.selectedOption) return a.selectedOption
                  return '(no answer)'
                })
                .join('; ')
              const truncated =
                answerTexts.length > 10_000
                  ? answerTexts.slice(0, 10_000) + '...'
                  : answerTexts
              entryParts.push(`User answered: ${truncated}`)
            }
          }
        }

        if (
          toolMessage.toolName === 'str_replace' ||
          toolMessage.toolName === 'propose_str_replace' ||
          toolMessage.toolName === 'write_file' ||
          toolMessage.toolName === 'propose_write_file'
        ) {
          const resultStr = JSON.stringify(value)
          const truncatedResult =
            resultStr.length > 2000
              ? resultStr.slice(0, 2000) + '...'
              : resultStr
          entryParts.push(
            `Edit result from ${toolMessage.toolName}:\n${truncatedResult}`,
          )
        }
      }
    }
  }

  if (
    toolMessage.toolName === 'spawn_agents' &&
    Array.isArray(toolMessage.content)
  ) {
    for (const part of toolMessage.content) {
      if (part.type === 'json' && Array.isArray(part.value)) {
        const agentResults = part.value as Array<{
          agentName?: string
          agentType?: string
          value?: { type?: string; value?: unknown }
        }>
        const includedResults = agentResults.filter(
          (r) =>
            r.agentType && !SPAWN_AGENTS_OUTPUT_BLACKLIST.includes(r.agentType),
        )
        if (includedResults.length > 0) {
          const resultSummaries = includedResults.map((r) => {
            let outputStr = ''
            if (r.value?.value !== undefined && r.value?.value !== null) {
              outputStr =
                typeof r.value.value === 'string'
                  ? r.value.value
                  : JSON.stringify(r.value.value)
              outputStr = outputStr
                .replace(/<think>[\s\S]*?<\/think>/g, '')
                .trim()
              if (
                outputStr.length >
                ASSISTANT_MESSAGE_LIMIT * CHARS_PER_TOKEN
              ) {
                outputStr =
                  outputStr.slice(
                    0,
                    ASSISTANT_MESSAGE_LIMIT * CHARS_PER_TOKEN,
                  ) + '...'
              }
            }
            return `- ${r.agentType}: ${outputStr || '(no output)'}`
          })
          entryParts.push(`Agent results:\n${resultSummaries.join('\n')}`)
        }
      }
    }
  }

  return entryParts
}

/**
 * Walks entries newest-first and keeps what fits. The two roles have separate
 * budgets on purpose: exhausting the assistant/tool budget must not evict user
 * prompts, and vice versa. The newest entry is always kept even when it alone
 * blows its budget.
 */
function selectEntriesWithinBudget(
  entries: SummaryEntry[],
  budgets: { assistantToolBudget: number; userBudget: number },
): {
  /** Chronological order. */
  includedEntries: SummaryEntry[]
  newestEntryForced: boolean
} {
  let assistantToolTokens = 0
  let userTokens = 0
  let assistantToolBudgetExhausted = false
  let userBudgetExhausted = false
  const reverseIncluded: SummaryEntry[] = []

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    const entryText = entry.parts.join(ENTRY_SEPARATOR)
    const entryTokens = Math.ceil(entryText.length / CHARS_PER_TOKEN)

    if (entry.role === 'user') {
      if (userBudgetExhausted) continue
      if (userTokens + entryTokens > budgets.userBudget) {
        userBudgetExhausted = true
        continue
      }
      userTokens += entryTokens
    } else {
      if (assistantToolBudgetExhausted) continue
      if (assistantToolTokens + entryTokens > budgets.assistantToolBudget) {
        assistantToolBudgetExhausted = true
        continue
      }
      assistantToolTokens += entryTokens
    }

    reverseIncluded.push(entry)
  }

  const newestEntry = entries[entries.length - 1]
  let newestEntryForced = false
  if (newestEntry && !reverseIncluded.includes(newestEntry)) {
    reverseIncluded.unshift(newestEntry)
    newestEntryForced = true
  }

  return { includedEntries: reverseIncluded.reverse(), newestEntryForced }
}

/** Renders chronological entries into the historical memory blob. */
function renderSummaryText(entries: SummaryEntry[]): string {
  return entries.flatMap((entry) => entry.parts).join(ENTRY_SEPARATOR)
}

/** Wraps the historical memory in the message the model actually sees. */
function buildSummaryMessage(
  summaryText: string,
  imageParts: Array<ImagePart | FilePart>,
  sentAt: number,
): Message {
  const textPart: TextPart = {
    type: 'text',
    text: `<conversation_summary>
${SUMMARY_HEADER}

<historical_memory>
${summaryText}
</historical_memory>
</conversation_summary>

${SUMMARY_DISCLAIMER}`,
  }
  return {
    role: 'user',
    content: [textPart, ...imageParts],
    sentAt,
  }
}

export type CompactionResult = {
  messages: Message[]
  summaryText: string
  /**
   * Snake_case on purpose: these go straight into the Axiom event, under the
   * same field names the context-pruner logs, so both agents' compactions can
   * be queried as one series.
   */
  stats: {
    mid_turn: boolean
    user_budget: number
    assistant_tool_budget: number
    previous_summary_entry_count: number
    user_entry_count: number
    dropped_user_entry_count: number
    assistant_tool_entry_count: number
    dropped_assistant_tool_entry_count: number
    newest_entry_forced: boolean
    live_user_prompt_found: boolean
    summary_estimated_tokens: number
  }
}

/**
 * Rewrites `messages` into `[summary, instructionsPrompt?, livePromptOrContinuation]`.
 * Pure and synchronous — no model call.
 */
export function compactMessages(params: {
  messages: Message[]
  assistantToolBudget?: number
  userBudget?: number
  now?: number
}): CompactionResult {
  const {
    messages,
    assistantToolBudget = DEFAULT_ASSISTANT_TOOL_BUDGET,
    userBudget = DEFAULT_USER_BUDGET,
    now = Date.now(),
  } = params

  // The live instructions prompt is scaffolding, not history: hold onto it and
  // re-append it after the summary so the agent keeps its standing orders.
  const instructionsPromptMessage =
    messages.findLast((message) =>
      message.tags?.includes('INSTRUCTIONS_PROMPT'),
    ) ?? null

  const previousSummary = messages.findLast(isConversationSummary)

  // If compaction happens before the assistant has started responding to the
  // current user prompt, preserve that prompt as a real message after the
  // memory artifact. Mid-turn, the prompt goes into the memory alongside the
  // work that followed it and a synthetic continuation prompt takes its place.
  const livePromptIndex = messages.findLastIndex((message) =>
    message.tags?.includes('USER_PROMPT'),
  )
  const livePrompt = livePromptIndex === -1 ? null : messages[livePromptIndex]
  const isMidTurn =
    livePrompt !== null &&
    messages.slice(livePromptIndex + 1).some(isRealHistory)

  const messagesToSummarize = messages.filter(
    (message, index) =>
      isRealHistory(message) && (isMidTurn || index !== livePromptIndex),
  )

  const previousSummaryEntries = parseSummaryIntoEntries(
    previousSummary ? extractSummaryContent(previousSummary) : '',
  )
  const entries = [
    ...previousSummaryEntries,
    ...summarizeMessagesIntoEntries(messagesToSummarize),
  ]
  const { includedEntries, newestEntryForced } = selectEntriesWithinBudget(
    entries,
    { assistantToolBudget, userBudget },
  )
  const summaryText = renderSummaryText(includedEntries)

  // Images cannot survive as text, so carry the most recent set forward.
  const imageParts = lastUserImageParts(messagesToSummarize)

  const finalMessages: Message[] = [
    buildSummaryMessage(summaryText, imageParts, now),
  ]
  if (instructionsPromptMessage) {
    // Refresh sentAt so downstream cache-expiry checks see a live timestamp.
    finalMessages.push({ ...instructionsPromptMessage, sentAt: now })
  }
  finalMessages.push(
    isMidTurn || !livePrompt
      ? {
          role: 'user',
          content: [{ type: 'text', text: CONTINUATION_TEXT }],
          sentAt: now,
        }
      : { ...livePrompt, sentAt: now },
  )

  const countUsers = (list: SummaryEntry[]) =>
    list.filter((entry) => entry.role === 'user').length
  const userEntries = countUsers(entries)
  const includedUserEntries = countUsers(includedEntries)
  const assistantToolEntries = entries.length - userEntries
  const includedAssistantToolEntries =
    includedEntries.length - includedUserEntries

  return {
    messages: finalMessages,
    summaryText,
    stats: {
      mid_turn: isMidTurn,
      user_budget: userBudget,
      assistant_tool_budget: assistantToolBudget,
      previous_summary_entry_count: previousSummaryEntries.length,
      user_entry_count: userEntries,
      dropped_user_entry_count: userEntries - includedUserEntries,
      assistant_tool_entry_count: assistantToolEntries,
      dropped_assistant_tool_entry_count:
        assistantToolEntries - includedAssistantToolEntries,
      newest_entry_forced: newestEntryForced,
      live_user_prompt_found: livePrompt !== null,
      summary_estimated_tokens: Math.ceil(summaryText.length / CHARS_PER_TOKEN),
    },
  }
}

/** The last unconsumed assistant/tool exchange, including parallel tool calls.
 * Stream parsing appends assistant messages, then the whole tool-result batch.
 * A later assistant response means that batch has already been consumed.
 */
function latestToolExchangeStart(messages: Message[]): number {
  const lastTool = messages.findLastIndex((message) => message.role === 'tool')
  if (
    lastTool < 0 ||
    messages.slice(lastTool + 1).some((message) => message.role === 'assistant')
  ) {
    return messages.length
  }
  let start = lastTool
  while (start > 0 && messages[start - 1].role === 'tool') start--
  const resultIds = new Set(
    messages
      .slice(start, lastTool + 1)
      .flatMap((message) =>
        message.role === 'tool' ? [message.toolCallId] : [],
      ),
  )
  const calls = new Set<string>()
  while (start > 0 && messages[start - 1].role === 'assistant') {
    start--
    const message = messages[start]
    if (message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type === 'tool-call') calls.add(part.toolCallId)
      }
    }
  }
  // Do not preserve orphan results (interrupted histories are cleaned by the
  // request builder), or cut a call away from another result in its batch.
  return calls.size === resultIds.size &&
    [...calls].every((id) => resultIds.has(id))
    ? start
    : messages.length
}

/** Runtime-only request budgeting around the shared historical summarizer.
 * The serialized context-pruner still uses compactMessages' summary algorithm;
 * it does not own the parent's live model request or its fixed token overhead.
 */
function compactRequestHistory(messages: Message[], tokenBudget: number) {
  const tailStart = latestToolExchangeStart(messages)
  let promptStart = messages
    .slice(0, tailStart)
    .findLastIndex((message) => message.tags?.includes('USER_PROMPT'))
  // Several steering prompts may have arrived together; keep all of them.
  while (
    promptStart > 0 &&
    messages[promptStart - 1].tags?.includes('USER_PROMPT')
  )
    promptStart--
  const instructionIndex = messages.findLastIndex((message) =>
    message.tags?.includes('INSTRUCTIONS_PROMPT'),
  )
  const livePrompts = messages
    .slice(Math.max(0, promptStart), tailStart)
    .filter(
      (message) => promptStart >= 0 && message.tags?.includes('USER_PROMPT'),
    )
  const prefix: Message[] = [
    ...(instructionIndex >= 0 && instructionIndex < tailStart
      ? [messages[instructionIndex]]
      : []),
    ...livePrompts,
  ]
  if (!prefix.some((message) => message.tags?.includes('USER_PROMPT'))) {
    prefix.push({
      role: 'user',
      content: [{ type: 'text', text: CONTINUATION_TEXT }],
      sentAt: Date.now(),
    })
  }
  const fresh = messages
    .slice(tailStart)
    .filter((message) => !message.tags?.includes('STEP_PROMPT'))
  const protectedMessages = new Set([...prefix, ...fresh])
  const older = messages
    .slice(0, tailStart)
    .filter((message) => !protectedMessages.has(message))
  const result = compactMessages({ messages: older })
  const entries = parseSummaryIntoEntries(result.summaryText)
  const now = Date.now()
  // Old persisted compactions put the current request inside the summary and
  // remove USER_PROMPT tags. Reserve that request as historical memory rather
  // than letting a large fresh read squeeze the task itself out of context.
  const historicalRequest =
    livePrompts.length === 0 &&
    !fresh.some((message) => message.tags?.includes('USER_PROMPT'))
      ? entries.findLast(
          (entry) =>
            entry.role === 'user' &&
            !entry.parts.includes(`[USER]\n${CONTINUATION_TEXT}`),
        )
      : undefined
  const reservedMemory = historicalRequest
    ? countTokensMessages([
        buildSummaryMessage(renderSummaryText([historicalRequest]), [], now),
      ])
    : 0
  const prefixTokens = countTokensMessages(prefix)
  if (prefixTokens + reservedMemory > tokenBudget) {
    throw new Error(
      'The current request and agent instructions exceed the configured context window. Shorten the request/project instructions or configure a larger context window supported by your provider.',
    )
  }
  const fitted = fitToolResults(
    fresh,
    tokenBudget - prefixTokens - reservedMemory,
  )
  const remainingTokens =
    tokenBudget - prefixTokens - countTokensMessages(fitted)

  // Keep the newest historical entries that fit the actual remainder. The
  // 50k/20k summary budgets are ceilings, never permission to exceed a BYOK
  // window. Count the envelope and images too, not just summary text.
  const selected = new Set<SummaryEntry>(
    historicalRequest ? [historicalRequest] : [],
  )
  let images = result.messages[0].content.filter(
    (part): part is ImagePart | FilePart =>
      part.type === 'image' || part.type === 'file',
  )
  if (
    countTokensMessages([
      buildSummaryMessage(renderSummaryText([...selected]), images, now),
    ]) > remainingTokens
  )
    images = []
  let available =
    remainingTokens -
    countTokensMessages([
      buildSummaryMessage(renderSummaryText([...selected]), images, now),
    ])
  for (let i = entries.length - 1; i >= 0; i--) {
    if (selected.has(entries[i])) continue
    const tokens = countTokens(
      entries[i].parts.join(ENTRY_SEPARATOR) + ENTRY_SEPARATOR,
    )
    if (tokens > available) continue
    selected.add(entries[i])
    available -= tokens
  }
  const kept = entries.filter((entry) => selected.has(entry))
  let summary = buildSummaryMessage(renderSummaryText(kept), images, now)
  while (kept.length && countTokensMessages([summary]) > remainingTokens) {
    const removable = kept.findIndex((entry) => entry !== historicalRequest)
    if (removable < 0) break
    kept.splice(removable, 1)
    summary = buildSummaryMessage(renderSummaryText(kept), images, now)
  }
  const output = [
    ...(countTokensMessages([summary]) <= remainingTokens ? [summary] : []),
    ...prefix.map((message) => ({ ...message, sentAt: now })),
    ...fitted,
  ]
  if (countTokensMessages(output) > tokenBudget) {
    throw new Error(
      'Unable to fit the latest tool results into the configured context window. Request smaller outputs or configure a larger supported context window.',
    )
  }
  return {
    ...result,
    messages: output,
    stats: {
      ...result.stats,
      mid_turn: fresh.length > 0,
      live_user_prompt_found: livePrompts.length > 0,
      summary_estimated_tokens: Math.ceil(
        renderSummaryText(kept).length / CHARS_PER_TOKEN,
      ),
      budget_dropped_summary_parts: entries.length - kept.length,
      preserved_fresh_messages: fitted.length,
    },
  }
}

/**
 * How long the conversation sat idle before the live user prompt arrived, or
 * null when the history has no pair of timestamps to measure between.
 *
 * The gap is measured from the last assistant message to the USER_PROMPT that
 * follows it: that is the window in which the provider's prompt cache had to
 * survive on its own. Tool messages carry no `sentAt`, so they are skipped.
 */
export function promptCacheGapMs(messages: Message[]): number | null {
  const userPromptIndex = messages.findLastIndex((message) =>
    message.tags?.includes('USER_PROMPT'),
  )
  if (userPromptIndex <= 0) return null

  const userPrompt = messages[userPromptIndex]
  if (!userPrompt.sentAt) return null

  for (let i = userPromptIndex - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    return message.sentAt ? userPrompt.sentAt - message.sentAt : null
  }
  return null
}

/**
 * Decides whether to compact, and why.
 *
 * Two triggers. The context limit is the one that must fire — the history no
 * longer fits. Cache expiry is the opportunistic one: once the prompt cache has
 * gone cold, the next request re-reads the whole history at full price anyway,
 * so rewriting it costs nothing and every later step in the turn is cheaper.
 * Compacting while the cache is warm would be the expensive mistake, which is
 * why the TTL errs long.
 *
 * The opportunistic trigger additionally needs enough context to be worth the
 * detail it destroys — see DEFAULT_CACHE_EXPIRY_MIN_TOKENS. The context limit
 * ignores that floor.
 */
export function evaluateCompactionTrigger(params: {
  messages: Message[]
  contextTokenCount: number
  maxContextLength: number
  /** Pass null to disable the opportunistic cache-expiry trigger. */
  cacheExpiryMs?: number | null
  /** Pass null to take the opportunistic compaction at any size. */
  cacheExpiryMinTokens?: number | null
}): {
  /** null means "leave the history alone". */
  trigger: CompactionTrigger | null
  cacheGapMs: number | null
  /** The thresholds actually applied, after defaulting. */
  cacheExpiryMs: number | null
  cacheExpiryMinTokens: number | null
} {
  const { messages, contextTokenCount, maxContextLength } = params
  const cacheExpiryMs =
    params.cacheExpiryMs === undefined
      ? DEFAULT_CACHE_EXPIRY_MS
      : params.cacheExpiryMs
  const cacheExpiryMinTokens =
    params.cacheExpiryMinTokens === undefined
      ? DEFAULT_CACHE_EXPIRY_MIN_TOKENS
      : params.cacheExpiryMinTokens

  const overContextLimit = contextTokenCount > maxContextLength
  const worthCompacting =
    cacheExpiryMinTokens === null || contextTokenCount >= cacheExpiryMinTokens
  const cacheGapMs =
    cacheExpiryMs === null || !worthCompacting
      ? null
      : promptCacheGapMs(messages)
  const cacheExpired =
    cacheExpiryMs !== null && cacheGapMs !== null && cacheGapMs > cacheExpiryMs

  const trigger: CompactionTrigger | null = overContextLimit
    ? cacheExpired
      ? 'context_limit_and_cache_expiry'
      : 'context_limit'
    : cacheExpired
      ? 'cache_expiry'
      : null

  return { trigger, cacheGapMs, cacheExpiryMs, cacheExpiryMinTokens }
}

/**
 * Runtime entry point for `compactContext` agents: decides, compacts and logs.
 * Returns null when the history should be left alone.
 *
 * Never calls a model, so it cannot fail on a provider error and has no
 * fallback path — the previous LLM-summarizing version returned the full
 * history when the call failed, which left the context over budget.
 */
export function maybeCompactHistory(params: {
  messages: Message[]
  contextTokenCount: number
  maxContextLength: number
  /** System prompt, tool schemas and next step's scaffolding, outside history. */
  fixedTokenCount?: number
  /** Pass null to compact on the context limit only. */
  cacheExpiryMs?: number | null
  /** Pass null to take the opportunistic compaction at any size. */
  cacheExpiryMinTokens?: number | null
  logger?: Logger
  runId?: string
  onCompaction?: (trigger: CompactionTrigger) => void
}): Message[] | null {
  const { messages, contextTokenCount, maxContextLength, logger, runId } =
    params

  const { trigger, cacheGapMs, cacheExpiryMs, cacheExpiryMinTokens } =
    evaluateCompactionTrigger({
      messages,
      contextTokenCount,
      maxContextLength,
      cacheExpiryMs: params.cacheExpiryMs,
      cacheExpiryMinTokens: params.cacheExpiryMinTokens,
    })
  if (!trigger) return null

  const result = compactRequestHistory(
    messages,
    maxContextLength - (params.fixedTokenCount ?? 0),
  )
  try {
    params.onCompaction?.(trigger)
  } catch {
    // Reporting must never block the compaction itself.
  }

  // Telemetry is best-effort and must never block the compaction itself.
  try {
    logger?.info(
      {
        axiomEvent: 'context_compaction_completed',
        agent_run_id: runId,
        trigger_reason: trigger,
        context_token_count: contextTokenCount,
        max_context_length: maxContextLength,
        ...(cacheGapMs === null ? {} : { cache_gap_ms: cacheGapMs }),
        ...(cacheExpiryMs === null ? {} : { cache_expiry_ms: cacheExpiryMs }),
        ...(cacheExpiryMinTokens === null
          ? {}
          : { cache_expiry_min_tokens: cacheExpiryMinTokens }),
        message_count: messages.length,
        ...result.stats,
      },
      'Context compaction completed',
    )
  } catch {
    // Ignore logging failures.
  }

  return result.messages
}

/**
 * Compact once, on demand, whatever the triggers say.
 *
 * Same mechanical pass `maybeCompactHistory` runs — same protected prefix, same
 * fresh tool exchange, same budget walk — with the decision removed. A user who
 * asks for it has already decided; `evaluateCompactionTrigger` exists to answer
 * "is this worth doing unasked", which is a different question.
 *
 * Returns null when the pass would not make the history smaller. That is not a
 * failure, it is the honest answer for a short conversation: rewriting it would
 * break the provider's prompt cache and hand back an envelope around the same
 * content. The caller reports it as a no-op rather than a compaction.
 *
 * Throws what `compactRequestHistory` throws — the live request alone over
 * budget — with its user-presentable sentence intact.
 */
export function compactHistoryNow(params: {
  messages: Message[]
  maxContextLength: number
  /** System prompt, tool schemas and next step's scaffolding, outside history. */
  fixedTokenCount?: number
  logger?: Logger
  runId?: string
}): { messages: Message[]; previousTokens: number; nextTokens: number } | null {
  const { messages, maxContextLength, logger, runId } = params
  const result = compactRequestHistory(
    messages,
    maxContextLength - (params.fixedTokenCount ?? 0),
  )
  const previousTokens = countTokensMessages(messages)
  const nextTokens = countTokensMessages(result.messages)
  if (nextTokens >= previousTokens) return null

  // Telemetry is best-effort and must never block the compaction itself.
  try {
    logger?.info(
      {
        axiomEvent: 'context_compaction_completed',
        agent_run_id: runId,
        trigger_reason: 'manual',
        context_token_count: previousTokens,
        max_context_length: maxContextLength,
        message_count: messages.length,
        ...result.stats,
      },
      'Context compaction completed',
    )
  } catch {
    // Ignore logging failures.
  }

  return { messages: result.messages, previousTokens, nextTokens }
}
