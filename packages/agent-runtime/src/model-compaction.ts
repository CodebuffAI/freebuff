import { tool, type ToolSet } from 'ai'
import { z } from 'zod/v4'
import {
  MECHANICAL_COMPACTION_SKIPPED_EVENT,
  MODEL_COMPACTION_COMPLETED_EVENT,
  MODEL_COMPACTION_FALLBACK_EVENT,
} from '@codebuff/common/util/axiom-only-log'
import { AbortError, isAbortError } from '@codebuff/common/util/error'

import { compactHistoryNow } from './compact-history'
import type { CompactionTrigger } from './compact-history'
import { COMPACTION_PROMPT } from './compaction-prompt'
import { countTokens, countTokensMessages } from './util/token-counter'

import type { PromptAiSdkStreamFn } from '@codebuff/common/types/contracts/llm'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type {
  ImagePart,
  FilePart,
} from '@codebuff/common/types/messages/content-part'

export const COMPACTION_TAG = 'MODEL_COMPACTION'
const SUMMARY_LIMIT = 6_000
/**
 * The output cap a summarizer request asks for. A model's own, lower cap
 * (`compactContext.maxOutputTokens`, which BYOK sets from its connection)
 * replaces it: a provider clamps the request to that cap either way.
 */
export const COMPACTION_MAX_OUTPUT_TOKENS = 16_384
/**
 * The share of the output cap a summary may be asked to fill. The rest covers
 * what the same output budget also pays for: the tool-call JSON around the
 * summary (every newline and quote escaped), the reasoning a thinking model
 * spends before it writes, and the gap between the three-characters-a-token
 * estimate and the provider's tokenizer. Asked for 6,000 tokens against a
 * 4,096-token BYOK cap, the summarizer ran out of output mid-summary.
 */
export const SUMMARY_OUTPUT_SHARE = 0.5
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

/**
 * How far past the requested length a summary may run and still be installed.
 *
 * The instruction asks for "approximately" `summaryBudget` tokens, and the
 * check measures with the local three-characters-a-token estimate, which
 * reads a Markdown handoff at ~1.1x a provider's count (and a CJK one at ~2x).
 * Held to exactly the requested number, about half of all model handoffs were
 * thrown away for running a few hundred tokens long: DeepSeek V4 Flash wrote
 * its median failed handoff in ~5,800 output tokens against a 6,000 budget
 * (prod, 2026-09-28). The summary must still leave the compacted context under
 * its target; see `compactWithModel`.
 */
export const SUMMARY_OVERRUN_TOLERANCE = 2

const lenientSummarySchema = z.object({ summary: z.string() })

function stripCodeFence(text: string): string {
  const fenced = text.match(/^```[A-Za-z0-9_-]*\s*\n?([\s\S]*?)\n?```$/)
  return fenced ? fenced[1].trim() : text
}

const VALID_JSON_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't'])

/**
 * JSON a model wrote by hand, made parseable without changing what it says:
 * raw control characters inside a string (a literal newline in a Markdown
 * summary) are escaped, and a backslash that starts no valid escape (`\'`, a
 * Windows path's `C:\Users`, a regex's `\d`) is kept as a literal backslash,
 * except before a quote-like `'` where the model meant the character itself.
 * Structure is never invented: a string or object cut off mid-way still fails
 * to parse.
 */
function repairJsonText(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (!inString) {
      if (char === '"') inString = true
      out += char
      continue
    }
    if (char === '"') {
      inString = false
      out += char
    } else if (char === '\\') {
      const next = text[i + 1]
      if (next !== undefined && VALID_JSON_ESCAPES.has(next)) {
        out += char + next
        i++
      } else if (
        next === 'u' &&
        /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))
      ) {
        out += text.slice(i, i + 6)
        i += 5
      } else if (next === "'") {
        out += "'"
        i++
      } else {
        out += '\\\\'
      }
    } else if (char === '\n') out += '\\n'
    else if (char === '\r') out += '\\r'
    else if (char === '\t') out += '\\t'
    else if (char < ' ')
      out += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
    else out += char
  }
  return out
}

function parseJsonLeniently(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    const repaired = repairJsonText(text)
    if (repaired === text) throw error
    return JSON.parse(repaired)
  }
}

/**
 * The summary from a `complete_compaction` call, or undefined when the
 * arguments hold none.
 *
 * `input` is NOT guaranteed to be an object. When the arguments fail the tool
 * schema, the AI SDK still emits the call (flagged `invalid`) with `input` set
 * to whatever the raw argument text JSON-parsed to, or to the raw text itself
 * when it does not parse. A double-encoded argument object therefore arrives
 * as a STRING of JSON, and a strict `.parse` on it threw a bare ZodError
 * ("expected object, received string") that failed the whole user run.
 * Decode like the tool executor does (`parseStringifiedToolInput`): unwrap up
 * to three layers of string encoding, tolerate a Markdown fence, and ignore
 * unknown keys. Prose that is not JSON at all is the model writing the handoff
 * directly into the argument slot, and is taken as the summary. Arguments
 * that are JSON apart from hand-written escaping (a raw newline inside the
 * string, `\'`, an unescaped `C:\Users`) are repaired, since the AI SDK hands
 * those over as raw text too. Anything that looks like JSON but still does not
 * parse (typically arguments cut off by the output cap) is rejected rather
 * than installed half-written.
 */
export function parseCompactionSummary(input: unknown): string | undefined {
  let value = input
  for (let depth = 0; depth < 3 && typeof value === 'string'; depth++) {
    const text = stripCodeFence(value.trim())
    try {
      value = parseJsonLeniently(text)
    } catch {
      if (depth > 0 || /^[{["]/.test(text)) return undefined
      return text || undefined
    }
  }
  const parsed = lenientSummarySchema.safeParse(value)
  if (!parsed.success) return undefined
  return parsed.data.summary.trim() || undefined
}

/** The prompt's section headings, as the summary writes them in any language. */
const HANDOFF_HEADINGS = [
  /^#{1,3}\s*Important Details\b/m,
  /^#{1,3}\s*Work State\b/m,
  /^#{1,3}\s*Next Move\b/m,
  /^#{1,3}\s*Relevant Files\b/m,
]

/**
 * Whether text is the handoff the prompt asks for rather than an answer to
 * the user's task: its Objective heading and at least two of the others. Used
 * only for text the model wrote OUTSIDE a `complete_compaction` call, where
 * an ordinary reply must not be mistaken for a summary.
 */
function isHandoffSummary(text: string): boolean {
  if (!/^#{1,3}\s*Objective\b/m.test(text)) return false
  return HANDOFF_HEADINGS.filter((heading) => heading.test(text)).length >= 2
}

/** The first string anywhere in a parsed value that reads as the handoff. */
function findHandoffString(value: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined
  if (typeof value === 'string') {
    if (isHandoffSummary(value)) return value.trim()
    // `"arguments": "{\"summary\": …}"`: arguments encoded as a string.
    if (!value.trimStart().startsWith('{')) return undefined
    try {
      return findHandoffString(parseJsonLeniently(value.trim()), depth + 1)
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  // A text-form call to some other tool is not a handoff.
  for (const key of ['toolName', 'name', 'tool'])
    if (
      typeof record[key] === 'string' &&
      record[key] !== 'complete_compaction'
    )
      return undefined
  for (const child of Object.values(record)) {
    const found = findHandoffString(child, depth + 1)
    if (found) return found
  }
  return undefined
}

/**
 * The handoff from a summarizer reply that has no `complete_compaction` call.
 *
 * Asked for the tool call, a share of models write the handoff as their reply
 * instead (prod, 2026-09-28, ~15% of rejected handoffs; GLM 5.3 Flash, MiMo,
 * Space Bunny, some DeepSeek): the Markdown itself, or the call spelled out as
 * text, either as JSON the way the summarized history serializes tool calls
 * (`{"toolName":"complete_compaction","input":{"summary":…}}`,
 * `{"name":…,"arguments":…}`, bare `{"summary":…}`) or in a model's XML
 * template (`<complete_compaction><summary>…`, `<parameter=summary>…`).
 * Whatever the wrapper, the recovered text must carry the handoff's headings.
 */
export function summaryFromReplyText(reply: string): string | undefined {
  const text = stripCodeFence(
    reply.replace(/^\s*<think>[\s\S]*?<\/think>/, '').trim(),
  )
  if (!text) return undefined
  if (!/^[{<]/.test(text) && isHandoffSummary(text)) return text
  const open = text.indexOf('{')
  const close = text.lastIndexOf('}')
  if (open >= 0 && close > open) {
    try {
      const found = findHandoffString(
        parseJsonLeniently(text.slice(open, close + 1)),
      )
      if (found) return found
    } catch {
      // Not JSON; try the XML templates.
    }
  }
  const tagged = text.match(
    /<(?:parameter(?:=|\s+name=["']?)summary["']?|summary)>\s*([\s\S]*?)\s*(?:<\/(?:parameter|summary)>|$)/,
  )
  const inner = tagged?.[1].replace(/(?:\s*<\/[\w-]+>)+\s*$/, '').trim()
  return inner && isHandoffSummary(inner) ? inner : undefined
}

function omittedBinary(mediaType: string | undefined): string {
  return `[${mediaType || 'binary'} omitted from this summary request]`
}

/** Shorter strings are left alone: no text worth summarizing is this long AND this alphabet. */
const MIN_ELIDED_BINARY_CHARS = 4_096
const DATA_URL = /^data:([^;,]*)(?:;[^,]*)?;base64,/
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/

/**
 * A `JSON.stringify` replacer that names base64 payloads instead of copying
 * them: a data URL or a long unbroken base64 run inside a tool's JSON result
 * (an MCP content block, a screenshot a tool returned as JSON). Prose and code
 * always contain whitespace or punctuation outside the base64 alphabet, so
 * they are never elided.
 */
function elideBinaryStrings(_key: string, value: unknown): unknown {
  if (typeof value !== 'string' || value.length < MIN_ELIDED_BINARY_CHARS)
    return value
  const dataUrl = value.match(DATA_URL)
  if (dataUrl) return omittedBinary(dataUrl[1])
  return BASE64.test(value) ? omittedBinary(undefined) : value
}

export function hasCompactableHistory(messages: Message[]): boolean {
  return messages.some(
    (message) => message.role === 'assistant' || message.role === 'tool',
  )
}

/** The messages a model compaction keeps verbatim after its summary: the
 *  latest instructions and the live user request (with its steering). */
function compactionSuffix(messages: Message[]): Message[] {
  const lastPrompt = messages.findLastIndex((m) =>
    m.tags?.includes('USER_PROMPT'),
  )
  let promptStart = lastPrompt
  while (
    promptStart > 0 &&
    messages[promptStart - 1].tags?.includes('USER_PROMPT')
  )
    promptStart--
  const live =
    promptStart < 0
      ? []
      : messages
          .slice(promptStart)
          .filter((m) => m.tags?.includes('USER_PROMPT'))
  const instructions = messages.findLast((m) =>
    m.tags?.includes('INSTRUCTIONS_PROMPT'),
  )
  return [...(instructions ? [instructions] : []), ...live]
}

/** The `max_tokens` a summarizer request asks for: never above the model's cap. */
export function compactionOutputTokens(maxOutputTokens?: number): number {
  return maxOutputTokens !== undefined && maxOutputTokens > 0
    ? Math.min(COMPACTION_MAX_OUTPUT_TOKENS, Math.floor(maxOutputTokens))
    : COMPACTION_MAX_OUTPUT_TOKENS
}

/**
 * How long a summary may be asked to be: bounded by the fixed limit, by a
 * third of the context the summary must fit back into, and by the share of
 * the request's output cap that is left for the summary itself.
 */
export function compactionSummaryBudget(params: {
  maxContextLength: number
  fixedTokenCount: number
  suffixTokens: number
  maxOutputTokens?: number
}): number {
  return Math.min(
    SUMMARY_LIMIT,
    Math.floor(
      (params.maxContextLength - params.fixedTokenCount - params.suffixTokens) /
        3,
    ),
    Math.floor(
      compactionOutputTokens(params.maxOutputTokens) * SUMMARY_OUTPUT_SHARE,
    ),
  )
}

/**
 * The share of the trigger threshold a compaction's result may occupy for the
 * automatic trigger to be worth firing. Above it, the next tool result or two
 * crosses the threshold again and the run compacts its own summary.
 */
export const COMPACTION_LOW_WATER = 0.85

/**
 * The largest context a model compaction can leave behind: the fixed prefix
 * (system prompt, tool schemas), the live request it keeps verbatim, and the
 * summary budget it asks for. None of it is compactable, so when this is not
 * comfortably under the threshold, compacting at the threshold only buys a
 * few thousand tokens before the next one: a 32k BYOK window with ~16k of
 * Desktop tool schemas compacted every few tool calls, each pass summarizing
 * the last summary.
 */
export function compactedContextCeiling(params: {
  messages: Message[]
  maxContextLength: number
  fixedTokenCount: number
  maxOutputTokens?: number
}): number {
  const suffixTokens = countTokensMessages(compactionSuffix(params.messages))
  const summaryBudget = compactionSummaryBudget({ ...params, suffixTokens })
  return params.fixedTokenCount + suffixTokens + Math.max(0, summaryBudget)
}

/**
 * Whether an automatic compaction at `thresholdTokens` leaves real room to
 * work in. When it cannot, the run keeps its history until the hard budget,
 * where compaction is no longer optional.
 */
export function automaticCompactionIsWorthwhile(params: {
  messages: Message[]
  maxContextLength: number
  thresholdTokens: number
  fixedTokenCount: number
  maxOutputTokens?: number
}): boolean {
  return (
    compactedContextCeiling(params) <=
    Math.floor(params.thresholdTokens * COMPACTION_LOW_WATER)
  )
}

/** A model handoff, not a mechanical reduction of tool results. Nothing mutates
 * the source history until every section has a valid, bounded result. */
export async function compactWithModel(params: {
  messages: Message[]
  system: string
  maxContextLength: number
  fixedTokenCount: number
  /** The model's output cap, when it is below COMPACTION_MAX_OUTPUT_TOKENS. */
  maxOutputTokens?: number
  /**
   * The context a summary longer than requested must still leave the run
   * under (an automatic trigger's low-water mark). Defaults to
   * `maxContextLength`. A summary within the requested length is held only
   * to `maxContextLength`, as before.
   */
  targetTokens?: number
  signal: AbortSignal
  stream: (
    messages: Message[],
    maxOutputTokens: number,
    /** Called with the request's finish reason once the model stops. */
    onFinishReason: (finishReason: string) => void,
  ) => ReturnType<PromptAiSdkStreamFn>
}): Promise<{
  messages: Message[]
  summary: string
  preTokens: number
  postTokens: number
  /** Where the installed handoff came from: the tool call, or reply text. */
  summarySource: 'tool_call' | 'text'
  summaryTokens: number
  summaryBudget: number
  /** Summarizer calls it took; more than one when history was split. */
  sections: number
} | null> {
  if (!hasCompactableHistory(params.messages)) return null
  const preTokens =
    countTokensMessages(params.messages) + params.fixedTokenCount
  // A compact-only request never enters the history. Keep the actual current
  // user request verbatim, including steering and attachments.
  const suffix = compactionSuffix(params.messages)
  const summaryBudget = compactionSummaryBudget({
    maxContextLength: params.maxContextLength,
    fixedTokenCount: params.fixedTokenCount,
    suffixTokens: countTokensMessages(suffix),
    maxOutputTokens: params.maxOutputTokens,
  })
  if (summaryBudget < 256)
    throw new Error(
      'The current request and instructions leave too little room to compact. Shorten the request or configure a larger context window.',
    )

  // Full tool payloads reach the summarizer. Serialization makes even a split
  // tool result a valid request, without orphan tool calls or fake tool replies.
  //
  // Binary payloads are the exception: they are named, never serialized. A
  // tool result's `media` part (a Desktop browser/preview screenshot, an MCP
  // image) carries its pixels as base64, and `JSON.stringify` wrote that
  // straight into the history text. The local estimate charges it at three
  // characters a token, a provider tokenizer at roughly half that, so a
  // screenshot-heavy thread became millions of tokens of base64: tens of
  // sequential ~800k-token summarizer calls, 1-3 minutes each, streaming
  // nothing the user can see. A Stop discards the unfinished pass, so every
  // later turn restarted it and the thread never answered again (Desktop,
  // 2026-09-24..26: >500k-token Desktop requests went from 0 to ~350 an hour,
  // ~90% of them these calls).
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
          if (part.type === 'media') return [omittedBinary(part.mediaType)]
          return [JSON.stringify(part, elideBinaryStrings)]
        })
        .join('\n')
      return `[${m.role}${m.role === 'tool' ? `: ${m.toolName}` : ''}]\n${content}`
    })
    .join('\n\n')

  let remaining = history
  let summary = ''
  let first = true
  let sections = 0
  let summarySource: 'tool_call' | 'text' = 'tool_call'
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
    let finishReason: string | undefined
    const stream = params.stream(
      request(remaining.slice(0, end)),
      compactionOutputTokens(params.maxOutputTokens),
      (reason) => {
        finishReason = reason
      },
    )
    let candidate: string | undefined
    let replyText = ''
    for (;;) {
      const next = await stream.next()
      if (next.done) {
        if (next.value.aborted) throw new AbortError()
        break
      }
      const chunk = next.value
      if (chunk.type === 'error') throw new Error(chunk.message)
      if (chunk.type === 'text') {
        replyText += chunk.text
        continue
      }
      if (chunk.type !== 'tool-call') continue
      if (chunk.toolName !== 'complete_compaction' || candidate !== undefined) {
        throw new Error(
          'Compaction returned an unexpected tool call. History has been preserved.',
        )
      }
      candidate = parseCompactionSummary(chunk.input) ?? ''
    }
    params.signal.throwIfAborted()
    if (!candidate) {
      const fromText = summaryFromReplyText(replyText)
      if (fromText) {
        candidate = fromText
        summarySource = 'text'
      }
    }
    // A summary cut off by the output cap can still arrive as a well-formed
    // call: prose written straight into the argument slot, or arguments a
    // provider closed for us. It ends mid-sentence and silently drops the
    // rest of the handoff, so it is never installed.
    if (finishReason === 'length') {
      throw new Error(
        'The compaction summary hit the output token limit before it finished. History has been preserved.',
      )
    }
    if (!candidate) {
      throw new Error(
        'The model did not return a valid compaction summary. History has been preserved; try again.',
      )
    }
    if (countTokens(candidate) > summaryBudget * SUMMARY_OVERRUN_TOLERANCE) {
      throw new Error(
        'The compaction summary was far longer than requested. History has been preserved; try again.',
      )
    }
    summary = candidate
    remaining = remaining.slice(end)
    first = false
    sections++
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
  const summaryTokens = countTokens(summary)
  // Past the requested length, a summary is only worth installing when the
  // run still ends up under its trigger; otherwise the next step compacts the
  // summary again.
  if (
    summaryTokens > summaryBudget &&
    postTokens > (params.targetTokens ?? params.maxContextLength)
  )
    throw new Error(
      'The compaction summary was far longer than requested. History has been preserved; try again.',
    )
  return {
    messages,
    summary,
    preTokens,
    postTokens,
    summarySource,
    summaryTokens,
    summaryBudget,
    sections,
  }
}

/** A fixed, content-free label for why the model handoff failed. */
function compactionErrorKind(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof Error && error.name === 'ZodError')
    return 'invalid_summary'
  if (message.includes('valid compaction summary')) return 'invalid_summary'
  if (message.includes('longer than requested')) return 'summary_too_long'
  if (message.includes('unexpected tool call')) return 'unexpected_tool_call'
  if (message.includes('output token limit')) return 'output_limit'
  if (
    message.includes('too little room') ||
    message.includes('compaction context budget') ||
    message.includes('No room for conversation history')
  )
    return 'budget'
  return 'provider_error'
}

/**
 * The mechanical pass (`compactHistoryNow`, no model call). It aims the part
 * it rewrites at `targetTokens` and keeps the live request and fresh tool
 * results whole within `maxContextLength`: it fills whatever room it is given,
 * so aimed at the hard budget it lands above an automatic trigger's threshold
 * and the very next step compacts again. Null when it cannot make the history
 * smaller; throws only when even the hard budget cannot hold the live request.
 */
export function compactMechanically(params: {
  messages: Message[]
  maxContextLength: number
  fixedTokenCount: number
  targetTokens?: number
  trigger?: CompactionTrigger | 'manual'
  deterministicCohort?: boolean
  logger?: Logger
  runId?: string
}): {
  messages: Message[]
  summary: string
  preTokens: number
  postTokens: number
} | null {
  const result = compactHistoryNow(params)
  if (!result) return null
  return {
    messages: result.messages,
    summary: result.summaryText,
    preTokens: result.previousTokens + params.fixedTokenCount,
    postTokens: result.nextTokens + params.fixedTokenCount,
  }
}

/**
 * The deterministic cohort's compaction: the mechanical pass alone, which is
 * opportunistic, so a history it cannot fit or cannot shrink is left alone.
 * Either miss is logged (`mechanical_compaction.skipped`), as the model arm's
 * is (`model_compaction.fallback`), so the two arms count the same attempts.
 */
export function compactDeterministically(
  params: Parameters<typeof compactMechanically>[0] & {
    logger: Logger
    model?: string
    /** The run's context before compacting, for the skip event. */
    contextTokenCount?: number
  },
): ReturnType<typeof compactMechanically> {
  const { model, contextTokenCount, ...mechanicalParams } = params
  let error: unknown
  let result: ReturnType<typeof compactMechanically> = null
  try {
    result = compactMechanically({
      ...mechanicalParams,
      deterministicCohort: true,
    })
  } catch (thrown) {
    error = thrown
  }
  if (result) return result
  try {
    const message = error instanceof Error ? error.message : String(error)
    params.logger[error === undefined ? 'info' : 'warn'](
      {
        axiomEvent: MECHANICAL_COMPACTION_SKIPPED_EVENT,
        agent_run_id: params.runId,
        model,
        trigger_reason: params.trigger,
        error_kind:
          error === undefined
            ? 'no_shrink'
            : message.includes('exceed the configured context window')
              ? 'over_budget'
              : 'error',
        ...(error === undefined
          ? {}
          : {
              error_name: error instanceof Error ? error.name : typeof error,
              // Not allowlisted for Axiom; local/debug logs only.
              error: message,
            }),
        context_token_count: contextTokenCount,
        max_context_length: params.maxContextLength,
        deterministic_cohort: true,
      },
      error === undefined
        ? 'Mechanical compaction could not shrink the history; left unchanged'
        : 'Mechanical compaction failed; history left unchanged',
    )
  } catch {
    // Logging must never turn a skipped compaction into a failed run.
  }
  return null
}

/**
 * `compactWithModel`, but a compaction failure never fails the user's run.
 *
 * The model handoff is the preferred compaction, not the only one: when the
 * summarizer errors, returns malformed arguments, or cannot be sized, the
 * mechanical pass (`compactHistoryNow` — no model call) takes over, exactly
 * as it ran before model compaction existed. If that also cannot shrink the
 * history, the history is left untouched and the caller's over-budget guard
 * decides. Only a cancellation propagates.
 */
export async function compactWithModelOrFallback(
  params: Parameters<typeof compactWithModel>[0] & {
    logger: Logger
    runId?: string
    model?: string
    trigger?: CompactionTrigger | 'manual'
    /** The context a summary longer than requested must still leave the
     * run under; `compactWithModel`'s `targetTokens`. */
    fallbackTargetTokens?: number
    /** Where the mechanical fallback aims; see `compactMechanically`.
     * Defaults to `fallbackTargetTokens`. */
    mechanicalTargetTokens?: number
    /** Telemetry only; see `compactHistoryNow`. */
    deterministicCohort?: boolean
  },
): Promise<{
  messages: Message[]
  summary: string
  preTokens: number
  postTokens: number
  fallback?: true
} | null> {
  const {
    logger,
    runId,
    model,
    trigger,
    fallbackTargetTokens,
    mechanicalTargetTokens = fallbackTargetTokens,
    deterministicCohort,
    ...modelParams
  } = params
  try {
    const result = await compactWithModel({
      targetTokens: fallbackTargetTokens,
      ...modelParams,
    })
    if (result) {
      try {
        logger.info(
          {
            axiomEvent: MODEL_COMPACTION_COMPLETED_EVENT,
            agent_run_id: runId,
            model,
            trigger_reason: trigger,
            summary_source: result.summarySource,
            summary_tokens: result.summaryTokens,
            summary_budget: result.summaryBudget,
            sections: result.sections,
            pre_tokens: result.preTokens,
            post_tokens: result.postTokens,
            deterministic_cohort: deterministicCohort,
          },
          'Model compaction completed',
        )
      } catch {
        // Logging must never turn a finished compaction into a failed run.
      }
    }
    return result
  } catch (error) {
    if (params.signal.aborted || isAbortError(error)) throw error
    const errorMessage = error instanceof Error ? error.message : String(error)
    let fallback: ReturnType<typeof compactMechanically> = null
    let fallbackError: string | undefined
    try {
      fallback = compactMechanically({
        messages: params.messages,
        maxContextLength: params.maxContextLength,
        fixedTokenCount: params.fixedTokenCount,
        targetTokens: mechanicalTargetTokens,
        trigger,
        deterministicCohort,
        logger,
        runId,
      })
    } catch (mechanicalError) {
      fallbackError =
        mechanicalError instanceof Error
          ? mechanicalError.message
          : String(mechanicalError)
    }
    try {
      logger.warn(
        {
          axiomEvent: MODEL_COMPACTION_FALLBACK_EVENT,
          agent_run_id: runId,
          model,
          trigger_reason: trigger,
          error_kind: compactionErrorKind(error),
          error_name: error instanceof Error ? error.name : typeof error,
          fallback_applied: Boolean(fallback),
          fallback_failed: fallbackError !== undefined,
          deterministic_cohort: deterministicCohort,
          // Not allowlisted for Axiom; local/debug logs only.
          error: errorMessage,
          ...(fallbackError ? { fallback_error: fallbackError } : {}),
        },
        fallback
          ? 'Model compaction failed; used mechanical compaction'
          : 'Model compaction failed; history left unchanged',
      )
    } catch {
      // Logging must never turn a recovered compaction into a failed run.
    }
    if (!fallback) return null
    return { ...fallback, fallback: true }
  }
}
