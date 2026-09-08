// With the help of opus 5. I mostly did it tho. Just had opus to fix any bugs and make it easier to read.

// type
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

// minimal structure
export interface ChatMessage {
  role: MessageRole
  content: unknown
 //set on use by syntehtic data
  _compaction?: CompactionMeta
  [key: string]: unknown
}

export interface CompactionMeta {
  kind: 'summary'
  // hhow many original messages this summary stands in for
  replacedCount: number
  // token count of it
  replacedTokens: number
  // goes up everytime a summary is summazried
  generation: number
  createdAt: number
}

export interface CompressionOptions {
  // ceiling of the token
  maxContextTokens: number
  /**
   * Fraction of `maxContextTokens` at which compression kicks in.
   * @default 0.8
   */
  triggerRatio?: number
  /**
   * Fraction of `maxContextTokens` to target after compression.
   * @default 0.5
   */
  targetRatio?: number
  /**
   * Always keep at least this many trailing messages verbatim.
   * @default 6
   */
  minTailMessages?: number
  /**
   * Never summarize unless at least this many messages would be collapsed
   * (avoids burning an LLM call to save nothing).
   * @default 4
   */
  minMessagesToSummarize?: number
  /**
   * Number of leading messages treated as pinned (system prompt, etc.).
   * Auto-detected from leading `system` messages if omitted.
   */
  pinnedHeadCount?: number
  /** Token counter. Defaults to a ~4 chars/token heuristic. */
  countTokens?: (message: ChatMessage) => number
  /** Produces the summary text. Required when compression actually runs. */
  summarize?: Summarizer
}

export type Summarizer = (input: SummarizeInput) => Promise<string>

export interface SummarizeInput {
  /** Messages to be collapsed, in order. */
  messages: ChatMessage[]
  /** Text of any prior summary being folded in, if present. */
  previousSummary?: string
  /** Soft budget for the produced summary. */
  maxSummaryTokens: number
}

export type CompressionReason =
  | 'under-threshold'
  | 'nothing-to-summarize'
  | 'compressed'
  | 'no-summarizer'

export interface CompressionResult {
  messages: ChatMessage[]
  compressed: boolean
  reason: CompressionReason
  tokensBefore: number
  tokensAfter: number
  messagesRemoved: number
  /** Index in the returned array where the summary lives, if any. */
  summaryIndex?: number
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS = {
  triggerRatio: 0.8,
  targetRatio: 0.5,
  minTailMessages: 6,
  minMessagesToSummarize: 4,
} as const

/** Rough heuristic: ~4 characters per token for English + code. */
const CHARS_PER_TOKEN = 4

/** Overhead per message for role/formatting tokens. */
const PER_MESSAGE_OVERHEAD_TOKENS = 4

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Flattens arbitrary message content into a string for length estimation.
 * Handles strings, content-part arrays, and nested objects.
 */
export function contentToText(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (typeof content === 'number' || typeof content === 'boolean') {
    return String(content)
  }
  if (Array.isArray(content)) {
    return content.map(contentToText).join('\n')
  }
  if (typeof content === 'object') {
    const part = content as Record<string, unknown>
    if (typeof part.text === 'string') return part.text
    // tool calls, tool results, images, etc.
    try {
      return JSON.stringify(part)
    } catch {
      return ''
    }
  }
  return ''
}

export function estimateMessageTokens(message: ChatMessage): number {
  const text = contentToText(message.content)
  return Math.ceil(text.length / CHARS_PER_TOKEN) + PER_MESSAGE_OVERHEAD_TOKENS
}

export function estimateTotalTokens(
  messages: readonly ChatMessage[],
  countTokens: (m: ChatMessage) => number = estimateMessageTokens,
): number {
  let total = 0
  for (const message of messages) total += countTokens(message)
  return total
}

// ---------------------------------------------------------------------------
// Message classification
// ---------------------------------------------------------------------------

function isToolResultMessage(message: ChatMessage): boolean {
  if (message.role === 'tool') return true
  const content = message.content
  if (!Array.isArray(content)) return false
  return content.some(
    (part) =>
      typeof part === 'object' &&
      part !== null &&
      (part as Record<string, unknown>).type === 'tool_result',
  )
}

function isSummaryMessage(message: ChatMessage): boolean {
  return message._compaction?.kind === 'summary'
}

function detectPinnedHeadCount(messages: readonly ChatMessage[]): number {
  let i = 0
  while (i < messages.length && messages[i].role === 'system') i++
  return i
}

// ---------------------------------------------------------------------------
// Boundary selection
// ---------------------------------------------------------------------------

/**
 * Walks `index` backwards until it no longer points at a tool result, so the
 * assistant message that issued the tool call stays with its results.
 */
function alignToPairBoundary(
  messages: readonly ChatMessage[],
  index: number,
  lowerBound: number,
): number {
  let i = index
  while (i > lowerBound && isToolResultMessage(messages[i])) i--
  return i
}

/**
 * Chooses the index where the preserved tail begins.
 *
 * Grows the tail backwards from the end until it would exceed `tailBudget`
 * tokens, honours `minTailMessages`, then snaps to a tool-pair boundary.
 */
export function findTailStart(
  messages: readonly ChatMessage[],
  opts: {
    pinnedHeadCount: number
    minTailMessages: number
    tailBudgetTokens: number
    countTokens: (m: ChatMessage) => number
  },
): number {
  const { pinnedHeadCount, minTailMessages, tailBudgetTokens, countTokens } =
    opts

  let index = messages.length
  let used = 0

  while (index > pinnedHeadCount) {
    const candidate = index - 1
    const cost = countTokens(messages[candidate])
    const kept = messages.length - candidate
    const withinBudget = used + cost <= tailBudgetTokens

    if (!withinBudget && kept > minTailMessages) break

    used += cost
    index = candidate
  }

  return alignToPairBoundary(messages, index, pinnedHeadCount)
}

// ---------------------------------------------------------------------------
// Summary message construction
// ---------------------------------------------------------------------------

const SUMMARY_PREAMBLE =
  'The earlier portion of this conversation was compacted to fit the context ' +
  'window. Treat the following as an accurate record of what happened:'

export function buildSummaryMessage(
  summaryText: string,
  meta: Omit<CompactionMeta, 'kind' | 'createdAt'>,
): ChatMessage {
  return {
    role: 'user',
    content: `${SUMMARY_PREAMBLE}\n\n${summaryText.trim()}`,
    _compaction: {
      kind: 'summary',
      createdAt: Date.now(),
      ...meta,
    },
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function shouldCompress(
  messages: readonly ChatMessage[],
  options: Pick<
    CompressionOptions,
    'maxContextTokens' | 'triggerRatio' | 'countTokens'
  >,
): boolean {
  const {
    maxContextTokens,
    triggerRatio = DEFAULTS.triggerRatio,
    countTokens = estimateMessageTokens,
  } = options
  return (
    estimateTotalTokens(messages, countTokens) >=
    maxContextTokens * triggerRatio
  )
}

/**
 * Compresses a conversation if it has crossed the trigger threshold.
 *
 * Returns the original array (same reference) when no work was done, so
 * callers can cheaply check `result.compressed`.
 */
export async function compressChat(
  messages: ChatMessage[],
  options: CompressionOptions,
): Promise<CompressionResult> {
  const {
    maxContextTokens,
    triggerRatio = DEFAULTS.triggerRatio,
    targetRatio = DEFAULTS.targetRatio,
    minTailMessages = DEFAULTS.minTailMessages,
    minMessagesToSummarize = DEFAULTS.minMessagesToSummarize,
    countTokens = estimateMessageTokens,
    summarize,
  } = options

  const pinnedHeadCount =
    options.pinnedHeadCount ?? detectPinnedHeadCount(messages)

  const tokensBefore = estimateTotalTokens(messages, countTokens)

  const unchanged = (reason: CompressionReason): CompressionResult => ({
    messages,
    compressed: false,
    reason,
    tokensBefore,
    tokensAfter: tokensBefore,
    messagesRemoved: 0,
  })

  if (tokensBefore < maxContextTokens * triggerRatio) {
    return unchanged('under-threshold')
  }

  const headTokens = estimateTotalTokens(
    messages.slice(0, pinnedHeadCount),
    countTokens,
  )
  const targetTokens = maxContextTokens * targetRatio
  const maxSummaryTokens = Math.max(
    256,
    Math.floor(targetTokens * 0.15),
  )
  const tailBudgetTokens = Math.max(
    0,
    targetTokens - headTokens - maxSummaryTokens,
  )

  const tailStart = findTailStart(messages, {
    pinnedHeadCount,
    minTailMessages,
    tailBudgetTokens,
    countTokens,
  })

  const middle = messages.slice(pinnedHeadCount, tailStart)
  if (middle.length < minMessagesToSummarize) {
    return unchanged('nothing-to-summarize')
  }
  if (!summarize) {
    return unchanged('no-summarizer')
  }

  // Fold any existing summary into the new one instead of nesting them.
  const priorSummary = middle.find(isSummaryMessage)
  const toSummarize = middle.filter((m) => !isSummaryMessage(m))
  const generation = (priorSummary?._compaction?.generation ?? 0) + 1

  const summaryText = await summarize({
    messages: toSummarize,
    previousSummary: priorSummary
      ? contentToText(priorSummary.content)
      : undefined,
    maxSummaryTokens,
  })

  if (!summaryText.trim()) {
    return unchanged('nothing-to-summarize')
  }

  const summaryMessage = buildSummaryMessage(summaryText, {
    replacedCount:
      middle.length + (priorSummary?._compaction?.replacedCount ?? 0),
    replacedTokens:
      estimateTotalTokens(middle, countTokens) +
      (priorSummary?._compaction?.replacedTokens ?? 0),
    generation,
  })

  const next = [
    ...messages.slice(0, pinnedHeadCount),
    summaryMessage,
    ...messages.slice(tailStart),
  ]

  return {
    messages: next,
    compressed: true,
    reason: 'compressed',
    tokensBefore,
    tokensAfter: estimateTotalTokens(next, countTokens),
    messagesRemoved: middle.length - 1,
    summaryIndex: pinnedHeadCount,
  }
}

/**
 * Convenience wrapper: compress repeatedly until under the target, or until
 * no further progress is possible. Guards against summarizer no-ops.
 */
export async function compressChatToFit(
  messages: ChatMessage[],
  options: CompressionOptions,
  maxPasses = 3,
): Promise<CompressionResult> {
  let current = messages
  let last: CompressionResult | undefined

  for (let pass = 0; pass < maxPasses; pass++) {
    const result = await compressChat(current, options)
    last = result
    if (!result.compressed) break
    if (result.tokensAfter >= result.tokensBefore) break
    current = result.messages
    if (
      result.tokensAfter <
      options.maxContextTokens * (options.targetRatio ?? DEFAULTS.targetRatio)
    ) {
      break
    }
  }

  return (
    last ?? {
      messages,
      compressed: false,
      reason: 'under-threshold',
      tokensBefore: estimateTotalTokens(messages, options.countTokens),
      tokensAfter: estimateTotalTokens(messages, options.countTokens),
      messagesRemoved: 0,
    }
  )
}
