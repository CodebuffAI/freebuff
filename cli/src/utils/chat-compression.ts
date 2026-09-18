// had opus 5 help me. Mostly did it myself for once.

import {
  formatTokens,
  freshInputTokens,
  totalTokens,
} from '@codebuff/common/util/tokens' // ← verify this specifier

// types

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatMessage {
  role: MessageRole
  content: unknown
  /** Set by us on synthetic summary messages. */
  _compaction?: CompactionMeta
  [key: string]: unknown
}

export interface CompactionMeta {
  kind: 'summary'
  /** How many original messages this summary stands in for. */
  replacedCount: number
  /** Token count of the messages that were replaced. */
  replacedTokens: number
  /** Incremented each time a summary is re-summarized. */
  generation: number
  createdAt: number
}

/**
 * A provider usage row, in the same shape `util/tokens` consumes.
 *
 * `inputTokens` is the provider's `prompt_tokens` and ALREADY INCLUDES
 * `cacheReadTokens` — never add them together. See `totalTokens`.
 */
export interface UsageSnapshot {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /**
   * How many leading entries of the message array this row accounts for,
   * INCLUDING the assistant message the row's `outputTokens` produced.
   *
   * Anything past this index has never been sent to the provider and must be
   * estimated. Get this wrong and the threshold silently drifts.
   */
  coversMessageCount: number
}

export interface CompressionOptions {
  /** Hard ceiling for the conversation, in tokens. */
  maxContextTokens: number
  /**
   * Most recent provider usage row. When supplied, the threshold check uses
   * real numbers for the covered prefix instead of the ~4 chars/token guess.
   */
  lastUsage?: UsageSnapshot
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
   * Skip compression while the provider is prefilling less than this fraction
   * of the prompt, i.e. while the cache is doing the work for us.
   *
   * Compaction rewrites the prefix and invalidates the cached prefill, so a
   * conversation at 85% cache hit can get *more* expensive after compressing.
   * Requires `lastUsage`; ignored without it.
   *
   * Set to 0 to always compress on threshold.
   * @default 0.15
   */
  minFreshInputRatio?: number
  /**
   * Number of leading messages treated as pinned (system prompt, etc.).
   * Auto-detected from leading `system` messages if omitted.
   */
  pinnedHeadCount?: number
  /** Fallback estimator for messages the provider has not priced. */
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
  | 'cache-warm'
  | 'nothing-to-summarize'
  | 'no-summarizer'
  | 'compressed'

/** Where a token figure came from. Worth surfacing — the two differ a lot. */
export type TokenSource = 'provider' | 'estimated' | 'mixed'

export interface CompressionResult {
  messages: ChatMessage[]
  compressed: boolean
  reason: CompressionReason
  tokensBefore: number
  tokensAfter: number
  tokenSource: TokenSource
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
  minFreshInputRatio: 0.15,
} as const

/** Rough heuristic: ~4 characters per token for English + code. */
const CHARS_PER_TOKEN = 4

/** Overhead per message for role/formatting tokens. */
const PER_MESSAGE_OVERHEAD_TOKENS = 4

// ---------------------------------------------------------------------------
// Token estimation (fallback only)
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
// Context measurement
// ---------------------------------------------------------------------------

export interface ContextMeasurement {
  tokens: number
  source: TokenSource
}

/**
 * Current conversation size.
 *
 * With a usage row: `totalTokens(row)` for the covered prefix — the provider's
 * own prompt+completion figure, cached prefix counted exactly once — plus an
 * estimate for anything appended since. Without one: pure estimate.
 */
export function measureContext(
  messages: readonly ChatMessage[],
  options: Pick<CompressionOptions, 'lastUsage' | 'countTokens'>,
): ContextMeasurement {
  const { lastUsage, countTokens = estimateMessageTokens } = options

  if (!lastUsage) {
    return { tokens: estimateTotalTokens(messages, countTokens), source: 'estimated' }
  }

  const covered = Math.min(
    Math.max(0, lastUsage.coversMessageCount),
    messages.length,
  )
  const uncounted = messages.slice(covered)
  const tokens =
    totalTokens(lastUsage) + estimateTotalTokens(uncounted, countTokens)

  return {
    tokens,
    source: uncounted.length === 0 ? 'provider' : 'mixed',
  }
}

/**
 * Fraction of the last prompt the provider actually had to prefill.
 *
 * Returns 1 when there is nothing to go on, so a missing usage row never
 * suppresses compression.
 */
export function freshInputRatio(usage: UsageSnapshot | undefined): number {
  if (!usage || usage.inputTokens <= 0) return 1
  return freshInputTokens(usage) / usage.inputTokens
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
  const header =
    `${SUMMARY_PREAMBLE}\n` +
    `[${meta.replacedCount} messages, ${formatTokens(meta.replacedTokens)} tokens]`

  return {
    role: 'user',
    content: `${header}\n\n${summaryText.trim()}`,
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
    | 'maxContextTokens'
    | 'triggerRatio'
    | 'countTokens'
    | 'lastUsage'
    | 'minFreshInputRatio'
  >,
): boolean {
  const {
    maxContextTokens,
    triggerRatio = DEFAULTS.triggerRatio,
    minFreshInputRatio = DEFAULTS.minFreshInputRatio,
  } = options

  const { tokens } = measureContext(messages, options)
  if (tokens < maxContextTokens * triggerRatio) return false

  return freshInputRatio(options.lastUsage) >= minFreshInputRatio
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
    lastUsage,
    triggerRatio = DEFAULTS.triggerRatio,
    targetRatio = DEFAULTS.targetRatio,
    minTailMessages = DEFAULTS.minTailMessages,
    minMessagesToSummarize = DEFAULTS.minMessagesToSummarize,
    minFreshInputRatio = DEFAULTS.minFreshInputRatio,
    countTokens = estimateMessageTokens,
    summarize,
  } = options

  const pinnedHeadCount =
    options.pinnedHeadCount ?? detectPinnedHeadCount(messages)

  const before = measureContext(messages, options)

  const unchanged = (reason: CompressionReason): CompressionResult => ({
    messages,
    compressed: false,
    reason,
    tokensBefore: before.tokens,
    tokensAfter: before.tokens,
    tokenSource: before.source,
    messagesRemoved: 0,
  })

  if (before.tokens < maxContextTokens * triggerRatio) {
    return unchanged('under-threshold')
  }
  if (freshInputRatio(lastUsage) < minFreshInputRatio) {
    return unchanged('cache-warm')
  }

  const headTokens = estimateTotalTokens(
    messages.slice(0, pinnedHeadCount),
    countTokens,
  )
  const targetTokens = maxContextTokens * targetRatio
  const maxSummaryTokens = Math.max(256, Math.floor(targetTokens * 0.15))
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

  // The usage row described the *old* prefix, which no longer exists. Every
  // figure from here on is an estimate until the next response comes back.
  return {
    messages: next,
    compressed: true,
    reason: 'compressed',
    tokensBefore: before.tokens,
    tokensAfter: estimateTotalTokens(next, countTokens),
    tokenSource: before.source === 'provider' ? 'mixed' : before.source,
    messagesRemoved: middle.length - 1,
    summaryIndex: pinnedHeadCount,
  }
}

/**
 * Convenience wrapper: compress repeatedly until under the target, or until
 * no further progress is possible. Guards against summarizer no-ops.
 *
 * Only the first pass can use the provider usage row — after that the prefix
 * has been rewritten, so subsequent passes drop it and estimate.
 */
export async function compressChatToFit(
  messages: ChatMessage[],
  options: CompressionOptions,
  maxPasses = 3,
): Promise<CompressionResult> {
  const targetRatio = options.targetRatio ?? DEFAULTS.targetRatio
  let current = messages
  let currentOptions = options
  let last: CompressionResult | undefined

  for (let pass = 0; pass < maxPasses; pass++) {
    const result = await compressChat(current, currentOptions)
    last = result
    if (!result.compressed) break
    if (result.tokensAfter >= result.tokensBefore) break

    current = result.messages
    currentOptions = { ...currentOptions, lastUsage: undefined }

    if (result.tokensAfter < options.maxContextTokens * targetRatio) break
  }

  if (last) return last

  const measured = measureContext(messages, options)
  return {
    messages,
    compressed: false,
    reason: 'under-threshold',
    tokensBefore: measured.tokens,
    tokensAfter: measured.tokens,
    tokenSource: measured.source,
    messagesRemoved: 0,
  }
}

/** One-line rendering for logs and the status bar. */
export function describeCompression(result: CompressionResult): string {
  if (!result.compressed) {
    return `no compression (${result.reason}, ${formatTokens(result.tokensBefore)})`
  }
  const saved = result.tokensBefore - result.tokensAfter
  return (
    `compacted ${result.messagesRemoved} messages: ` +
    `${formatTokens(result.tokensBefore)} → ${formatTokens(result.tokensAfter)} ` +
    `(−${formatTokens(saved)})`
  )
}
