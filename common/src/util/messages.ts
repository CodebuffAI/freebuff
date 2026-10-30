import { modelMessageSchema } from 'ai'
import { cloneDeep, has, isEqual } from 'lodash'

import type { Logger } from '../types/contracts/logger'
import type { JSONValue } from '../types/json'
import type {
  AssistantMessage,
  AuxiliaryMessageData,
  Message,
  SystemMessage,
  ToolMessage,
  UserMessage,
} from '../types/messages/codebuff-message'
import type {
  ToolCallPart,
  ToolResultOutput,
} from '../types/messages/content-part'
import type { ProviderMetadata } from '../types/messages/provider-metadata'
import type {
  AssistantModelMessage,
  ModelMessage,
  SystemModelMessage,
  ToolModelMessage,
  UserModelMessage,
} from 'ai'


export function toContentString(msg: ModelMessage): string {
  const { content } = msg
  if (typeof content === 'string') return content
  return content
    .map((item) =>
      item && 'text' in item && typeof item.text === 'string' ? item.text : '',
    )
    .join('\n')
}

export function withCacheControl<T extends object>(
  obj: T & { providerOptions?: ProviderMetadata },
): T & { providerOptions: ProviderMetadata } {
  const wrapper = cloneDeep(obj) as T & {
    providerOptions: ProviderMetadata
  }
  if (!wrapper.providerOptions) {
    wrapper.providerOptions = {}
  }

  /* 'codebuff' provider name is not compatible with providerMetadata for
   * messages, so we need to use 'openaiCompatible' instead.
   * https://github.com/vercel/ai/blob/8e4fdac31b4f8c6a8d07a606a8833e74adf99470/packages/openai-compatible/src/chat/convert-to-openai-compatible-chat-messages.ts#L9
   */
  for (const provider of [
    'anthropic',
    'openrouter',
    'openaiCompatible',
  ] as const) {
    if (!wrapper.providerOptions[provider]) {
      wrapper.providerOptions[provider] = {}
    }
    wrapper.providerOptions[provider].cache_control = { type: 'ephemeral' }
  }

  return wrapper
}

export function withoutCacheControl<T extends object>(
  obj: T & { providerOptions?: ProviderMetadata },
): T & { providerOptions?: ProviderMetadata } {
  const wrapper = cloneDeep(obj) as T & {
    providerOptions?: ProviderMetadata
  }

  for (const provider of [
    'anthropic',
    'openrouter',
    'openaiCompatible',
  ] as const) {
    if (has(wrapper.providerOptions?.[provider]?.cache_control, 'type')) {
      delete wrapper.providerOptions?.[provider]?.cache_control?.type
    }
    if (
      Object.keys(wrapper.providerOptions?.[provider]?.cache_control ?? {})
        .length === 0
    ) {
      delete wrapper.providerOptions?.[provider]?.cache_control
    }
    if (Object.keys(wrapper.providerOptions?.[provider] ?? {}).length === 0) {
      delete wrapper.providerOptions?.[provider]
    }
  }

  if (Object.keys(wrapper.providerOptions ?? {}).length === 0) {
    delete wrapper.providerOptions
  }

  return wrapper
}

type NonStringContent<T extends { content: any }> = Omit<T, 'content'> & {
  content: Exclude<T['content'], string>
}
type ModelMessageWithAuxiliaryData = (
  | SystemModelMessage
  | NonStringContent<UserModelMessage>
  | NonStringContent<AssistantModelMessage>
  | ToolModelMessage
) &
  AuxiliaryMessageData

function assistantToCodebuffMessage(
  message: Omit<AssistantMessage, 'content'> & {
    content: Exclude<AssistantMessage['content'], string>[number]
  },
): AssistantMessage {
  // if (message.content.type === 'tool-call') {
  //   return cloneDeep({
  //     ...message,
  //     content: [
  //       {
  //         type: 'text',
  //         text: getToolCallString(
  //           message.content.toolName,
  //           message.content.input,
  //           false,
  //         ),
  //       },
  //     ],
  //   })
  // }
  return cloneDeep({ ...message, content: [message.content] })
}

/** A tool message answering `message`'s call, carrying `output`. */
function toolResultMessage(
  message: ToolMessage,
  output: Extract<ToolResultOutput, { type: 'json' }>,
): ModelMessageWithAuxiliaryData {
  return cloneDeep<ToolModelMessage>({
    ...message,
    role: 'tool',
    content: [{ ...message, output, type: 'tool-result' }],
  })
}

const EMPTY_TOOL_OUTPUT = { type: 'json', value: '' } as const

function convertToolResultMessage(
  message: ToolMessage,
): ModelMessageWithAuxiliaryData[] {
  if (message.content.length === 0) {
    return [toolResultMessage(message, EMPTY_TOOL_OUTPUT)]
  }
  // A `media` part becomes a *user* message, because providers do not accept
  // images inside a tool message. Emit every tool message first regardless of
  // the part order, so the results still immediately follow the assistant's
  // tool_calls — otherwise a tool that returns [media, json] (which is the
  // order preview_screenshot uses, so the model sees pixels before the note)
  // puts a user message between the call and its result. Providers reject that
  // outright ("tool call result does not follow tool call"), and the server's
  // repair drops the call and the result as an unpaired pair.
  const toolMessages: ModelMessageWithAuxiliaryData[] = []
  const mediaMessages: ModelMessageWithAuxiliaryData[] = []
  for (const c of message.content) {
    if (c.type === 'json') {
      toolMessages.push(toolResultMessage(message, c))
      continue
    }
    if (c.type === 'media') {
      mediaMessages.push(
        cloneDeep<UserMessage>({
          ...message,
          role: 'user',
          content: [{ type: 'file', data: c.data, mediaType: c.mediaType }],
        }),
      )
      continue
    }
    c satisfies never
    throw new Error(
      `Invalid tool output type: ${(c as { type: unknown }).type}`,
    )
  }

  // Media-only output (see `mediaToolResult`) would otherwise emit a user
  // message and no tool message at all, leaving the call permanently
  // unanswered — the same unpaired-tool-call failure, just reached a different
  // way. Answer it with the empty result the no-content branch already uses.
  if (toolMessages.length === 0) {
    toolMessages.push(toolResultMessage(message, EMPTY_TOOL_OUTPUT))
  }

  return [...toolMessages, ...mediaMessages]
}

function convertToolMessage(message: Message): ModelMessageWithAuxiliaryData[] {
  if (message.role === 'system') {
    return [
      {
        ...message,
        content: message.content.map(({ text }) => text).join('\n\n'),
      },
    ]
  }
  if (message.role === 'user') {
    return [cloneDeep(message)]
  }
  if (message.role === 'assistant') {
    if (typeof message.content === 'string') {
      return [
        cloneDeep({
          ...message,
          content: [{ type: 'text' as const, text: message.content }],
        }),
      ]
    }
    return message.content.map((c) => {
      return assistantToCodebuffMessage({
        ...message,
        content: c,
      })
    })
  }
  if (message.role === 'tool') {
    return convertToolResultMessage(message)
  }
  message satisfies never
  throw new Error(
    `Invalid message role: ${(message as { role: unknown }).role}`,
  )
}

/**
 * Recursively replace any lone (unpaired) UTF-16 surrogate with U+FFFD in every
 * string reachable from `value`, mutating objects/arrays in place.
 *
 * Why this exists: unsafe truncation (e.g. slicing a file read or terminal
 * output in the middle of an emoji / astral-plane character) can leave a lone
 * surrogate in message content. JS's `JSON.stringify` is "well-formed" and emits
 * it as a syntactically-valid `\uXXXX` escape, and JS's `JSON.parse` is lenient
 * and accepts it, so the corruption slips through every client-side check. But
 * strict server-side parsers — notably Rust's serde_json, used by
 * OpenAI/OpenRouter/Anthropic — reject the whole request body with
 * "unexpected end of hex escape". Once such content lands in the message
 * history, EVERY subsequent provider request fails fatally and the agent stops,
 * even though nothing is wrong with the current turn's tool call.
 *
 * Sanitizing here, at the single chokepoint where all messages are converted to
 * provider format, guarantees a single bad character can never poison the
 * conversation regardless of which tool produced it. It is a no-op on
 * already-valid strings, so valid emoji, base64, etc. are untouched.
 *
 * (Equivalent to `String.prototype.toWellFormed()`, implemented as a regex so we
 * don't need to widen the project's TS lib to ES2024.)
 */
const LONE_SURROGATE_REGEX =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

function toWellFormedString(str: string): string {
  LONE_SURROGATE_REGEX.lastIndex = 0
  return str.replace(LONE_SURROGATE_REGEX, '�')
}

/** Whether a string contains an unpaired surrogate the scrub would rewrite. */
function stringNeedsScrub(str: string): boolean {
  LONE_SURROGATE_REGEX.lastIndex = 0
  return LONE_SURROGATE_REGEX.test(str)
}

function wellFormCopy<T>(value: T): T {
  const copy = cloneDeep(value)
  if (typeof (copy as { content?: unknown }).content === 'string') {
    ;(copy as { content: string }).content = toWellFormedString(
      (copy as { content: string }).content,
    )
  } else {
    wellFormStringsInPlace((copy as { content?: unknown }).content)
  }
  return copy
}

function wellFormStringsInPlace(value: unknown): void {
  // Arrays and plain objects are both handled here: Object.keys enumerates array
  // indices too, and indexing by string key mutates the element in place.
  if (!value || typeof value !== 'object') return
  const obj = value as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    const item = obj[key]
    if (typeof item === 'string') {
      obj[key] = toWellFormedString(item)
    } else {
      wellFormStringsInPlace(item)
    }
  }
}

/**
 * Per-message conversion cache, keyed by message object identity.
 *
 * convertCbToModelMessages runs on every agent step over the full message
 * history, and its per-message work (cloning the content, scrubbing lone
 * UTF-16 surrogates, schema-checking the converted form) is a pure function
 * of that message. History messages are immutable once appended — every
 * rewrite site (fit-tool-results.ts, trimMessagesToFitTokenLimit,
 * compaction) allocates a replacement message object rather than mutating
 * in place — so a WeakMap on the message object caches each message's
 * conversion exactly once: a step converting N new messages pays only for
 * those N, however long the history behind them. Stale entries cost
 * nothing; GC drops them with the message itself.
 */
type ConvertedMessage = {
  /** Surrogate-scrubbed source message, or the original itself when nothing
   *  had to change (returned by reference — safe because history messages
   *  are never mutated after append). */
  scrubbed: Message
  /**
   * convertToolMessage output for `scrubbed`: converted role, single content
   * part per assistant message, surrogate-scrubbed, schema-validated.
   *
   * THE CACHE-CONTROL PASS MUST NOT MUTATE THESE OBJECTS: every mark
   * replaces the per-step entry (or its content array) with a fresh copy,
   * so the cached form is never touched (see convertCbToModelMessages).
   */
  converted: ModelMessageWithAuxiliaryData[]
  /** Set when a converted part failed AI SDK schema validation; the per-step
   *  pass rethrows it on every call, the way the uncached validation did. */
  error?: Error
}

const convertedMessageCache = new WeakMap<Message, ConvertedMessage>()

function convertMessageCached(message: Message): ConvertedMessage {
  const cached = convertedMessageCache.get(message)
  if (cached) return cached

  const scrubbed = messageNeedsScrub(message.content)
    ? wellFormCopy(message)
    : message
  const converted = convertToolMessage(scrubbed)
  const error = validateConverted(converted)
  const result = { scrubbed, converted, error }
  convertedMessageCache.set(message, result)
  return result
}

function messageNeedsScrub(content: Message['content']): boolean {
  if (typeof content === 'string') {
    return stringNeedsScrub(content)
  }
  for (const part of content) {
    if (valueNeedsScrub(part)) return true
  }
  return false
}

/** Deep pre-pass mirroring wellFormStringsInPlace's traversal, so a message
 *  is cloned only when the scrub would actually change it. Any repeated
 *  subtree that survived into history would already make the uncached pass
 *  rewrite a (formerly) shared structure; treat it as needing a copy. */
function valueNeedsScrub(value: unknown, seen?: Set<object>): boolean {
  if (typeof value === 'string') return stringNeedsScrub(value)
  if (!value || typeof value !== 'object') return false
  const track = seen ?? new Set<object>()
  if (track.has(value as object)) return true
  track.add(value as object)
  for (const key of Object.keys(value)) {
    if (valueNeedsScrub((value as Record<string, unknown>)[key], track)) {
      return true
    }
  }
  track.delete(value as object)
  return false
}

/**
 * Schema-validate one source message's converted parts. A malformed
 * conversion is deterministic, so the WeakMap caches the failure next to the
 * converted form; the per-step pass rethrows with the same message.
 */
function validateConverted(
  converted: ModelMessageWithAuxiliaryData[],
): Error | undefined {
  for (let i = 0; i < converted.length; i++) {
    const message = converted[i]
    const result = modelMessageSchema.safeParse(message)
    if (result.success) continue
    return new Error(
      `convertCbToModelMessages: converted part ${i} of a message failed schema validation.\n` +
        `Role: ${message.role}\n` +
        `Message:\n${result.error.message}`,
    )
  }
  return undefined
}

/**
 * Rebuild the cross-message envelope over per-message cached conversions:
 * media buffering plus same-aux aggregation. This replays the pending-call
 * state machine convertToolMessages ran — each part's pending-set deltas
 * (the tool-result ids it answers, the calls it opens) come off its source
 * message at conversion time, so a step pays O(new messages) of conversion
 * work plus O(history) of envelope bookkeeping over primed cache entries.
 *
 * Only media converted out of a tool message ever leaves emission order:
 * it rides a user message, which providers reject between a tool call and
 * its result, so it waits (as in convertToolMessages) until the pending
 * set drains at an answer or at a non-tool boundary.
 */
function streamWithMediaBuffering(
  messages: Message[],
): ModelMessageWithAuxiliaryData[] {
  const stream: ModelMessageWithAuxiliaryData[] = []
  const unanswered = new Set<string>()
  let pendingMedia: ModelMessageWithAuxiliaryData[] = []
  const flushMedia = () => {
    if (unanswered.size > 0 || pendingMedia.length === 0) return
    stream.push(...pendingMedia)
    pendingMedia = []
  }

  for (const message of messages) {
    const { converted } = convertMessageCached(message)
    for (const part of converted) {
      if (isToolMediaPart(part)) {
        pendingMedia.push(part)
        flushMedia()
        continue
      }
      stream.push(part)
      if (message.role === 'tool' && part.role === 'tool') {
        for (const content of part.content) {
          if (content.type === 'tool-result') unanswered.delete(content.toolCallId)
        }
        flushMedia()
        continue
      }
      if (message.role !== 'tool' && part.role === 'assistant') {
        for (const content of part.content) {
          if (content.type === 'tool-call' && content.providerExecuted !== true) {
            unanswered.add(content.toolCallId)
          }
        }
      }
      flushMedia()
    }
  }
  // Backstop, same as convertToolMessages': still-buffered media had no
  // clean boundary and lands at the end.
  stream.push(...pendingMedia)
  return stream
}

/** Media converted out of a tool message: a user message with a single file
 *  content part that keeps the source message's toolCallId (see
 *  convertToolResultMessage). The toolCallId is what tells it apart from a
 *  real user file upload — user messages never carry one. */
function isToolMediaPart(part: ModelMessageWithAuxiliaryData): boolean {
  return (
    part.role === 'user' &&
    Array.isArray(part.content) &&
    part.content.length === 1 &&
    part.content[0]?.type === 'file' &&
    (part as { toolCallId?: string }).toolCallId !== undefined
  )
}

/**
 * Merge two same-role converted parts without mutating either. The first
 * merged pair allocates one per-request copy flagged __aggregatedCopy;
 * further parts append in place to that owned copy.
 */
function aggregateInto(
  out: ModelMessageWithAuxiliaryData,
  part: ModelMessageWithAuxiliaryData,
): ModelMessageWithAuxiliaryData {
  if (out.role === 'system') {
    const owned = {
      ...out,
      content: `${out.content as string}\n\n${part.content as string}`,
    } as ModelMessageWithAuxiliaryData
    markOwned(owned)
    return owned
  }
  const owned: ModelMessageWithAuxiliaryData = isAggregatedCopy(out)
    ? out
    : ({
        ...out,
        content: [...(out.content as unknown[])],
      } as ModelMessageWithAuxiliaryData)
  ;(owned.content as unknown[]).push(...(part.content as unknown[]))
  if (!isAggregatedCopy(owned)) markOwned(owned)
  return owned
}

function isAggregatedCopy(message: object): boolean {
  return (message as { __aggregatedCopy?: boolean }).__aggregatedCopy === true
}

/**
 * Flag an object as per-request-owned (non-enumerable, so neither the AI SDK
 * schema validation nor a provider request body ever sees it). The
 * aggregation and cache-control passes use it to keep mutating within one
 * request without re-copying a cached message form.
 */
function markOwned(message: object): void {
  Object.defineProperty(message, '__aggregatedCopy', {
    value: true,
    enumerable: false,
    writable: true,
    configurable: true,
  })
}

function isOwnedContent(message: object): boolean {
  return (message as { __ownedContent?: boolean }).__ownedContent === true
}

/** Shallow copy with a fresh content array, flagged so the cache-control
 *  pass copies each cached message at most once per request. */
function withOwnedContent<T extends { content: unknown }>(message: T): T {
  const copy = { ...message, content: [...(message.content as unknown[])] }
  Object.defineProperty(copy, '__ownedContent', {
    value: true,
    enumerable: false,
    writable: true,
    configurable: true,
  })
  return copy
}

export function convertCbToModelMessages({
  messages,
  includeCacheControl = true,
  logger,
}: {
  messages: Message[]
  includeCacheControl?: boolean
  logger?: Logger
}): ModelMessage[] {
  // Each history message is converted, scrubbed and schema-checked exactly
  // once per process (see convertedMessageCache); the per-step cost is the
  // envelope logic below plus O(1) per message. Orphan repair stays with
  // the history builders — run-agent-step repairs the step history itself
  // before it lands in agentState.messageHistory — rather than running
  // again here over every request.
  const streamed = streamWithMediaBuffering(messages)

  const aggregated: ModelMessageWithAuxiliaryData[] = []
  for (const message of streamed) {
    if (aggregated.length === 0) {
      aggregated.push(message)
      continue
    }

    const lastMessage = aggregated[aggregated.length - 1]
    if (
      lastMessage.timeToLive !== message.timeToLive ||
      !isEqual(lastMessage.providerOptions, message.providerOptions) ||
      !isEqual(lastMessage.tags, message.tags)
    ) {
      aggregated.push(message)
      continue
    }
    if (
      lastMessage.role === message.role &&
      (lastMessage.role === 'system' ||
        lastMessage.role === 'user' ||
        lastMessage.role === 'assistant')
    ) {
      aggregated[aggregated.length - 1] = aggregateInto(lastMessage, message)
      continue
    }
    aggregated.push(message)
  }

  if (!includeCacheControl) {
    return aggregated
  }

  // Add cache control to specific messages (max of 4 can be marked for caching!):
  // - The message right before the three tagged messages
  // - Last message
  //
  // Entries of `aggregated` are shared with convertedMessageCache, so this
  // pass must never mutate them in place: every mark REPLACES the entry (or
  // its content array) with the copy withCacheControl returns.
  for (const tag of [
    'LAST_ASSISTANT_MESSAGE',
    'USER_PROMPT',
    'STEP_PROMPT',
    undefined, // Last message
  ] as const) {
    let index =
      tag === 'LAST_ASSISTANT_MESSAGE'
        ? aggregated.findLastIndex((m) => m.role === 'assistant')
        : tag
          ? aggregated.findLastIndex((m) => m.tags?.includes(tag))
          : aggregated.length
    if (index <= 0) {
      continue
    }

    // Iterate to find the last "valid" message that we can cache control
    let prevMessage: (typeof aggregated)[number]
    addCacheControlLoop: while (true) {
      index--

      // No message found
      if (index < 0) {
        break
      }

      const entry = aggregated[index]
      if (typeof entry.content === 'string') {
        // This must be a system message
        aggregated[index] = withCacheControl(entry)
        break
      }

      // Make the message and its content array per-request-owned; cached
      // messages share both with convertedMessageCache across requests, and
      // repeated tags keep editing the owned copies.
      if (!isAggregatedCopy(entry) || !isOwnedContent(entry)) {
        prevMessage = withOwnedContent(entry)
        markOwned(prevMessage)
        aggregated[index] = prevMessage
      } else {
        prevMessage = entry
      }
      const contentBlock = prevMessage.content as Exclude<
        typeof prevMessage.content,
        string
      >

      // Iterate to find the last valid content part
      let lastContentIndex = contentBlock.length
      let lastContentPart: (typeof contentBlock)[number]
      while (true) {
        lastContentIndex--
        lastContentPart = contentBlock[lastContentIndex]

        if (lastContentIndex < 0) {
          // Continue searching in next message
          break
        }

        contentBlock[lastContentIndex] = withCacheControl(lastContentPart)
        break addCacheControlLoop
      }
      break
    }
  }

  // Schema validation ran once per source message at conversion time
  // (validateConverted, via convertedMessageCache); rethrow any cached
  // failure the same way the per-step pass did, on every call.
  {
    let failed: Error | undefined
    for (const message of messages) {
      const cached = convertedMessageCache.get(message)
      if (cached?.error && !failed) failed = cached.error
    }
    if (failed) {
      if (logger) {
        logger.error(
          { error: failed },
          `convertCbToModelMessages: A converted message failed schema validation.`,
        )
      }
      throw failed
    }
  }

  return aggregated
}

/**
 * Drop local tool calls that were not answered before the next user/system
 * boundary or the end of history.
 *
 * AI SDK validates that boundary before making a request. A result later in
 * history cannot cross a user/system boundary to answer an interrupted call.
 * Provider-executed calls need no local answer.
 *
 * Tool messages themselves are preserved: the SDK intentionally supports
 * freestanding results from user-run commands between prompts. The web API's
 * wire-format sanitizer handles provider-specific orphan and duplicate rules.
 */
export function dropUnansweredToolCalls(messages: Message[]): Message[] {
  const pending = new Map<string, ToolCallPart[]>()
  const unanswered = new Set<ToolCallPart>()
  const flushPending = () => {
    for (const calls of pending.values()) {
      for (const call of calls) unanswered.add(call)
    }
    pending.clear()
  }

  // Mirror AI SDK's validator: assistant calls add pending ids, tool messages
  // resolve them, and a user/system boundary (or end of history) requires the
  // pending set to be empty.
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type !== 'tool-call' || part.providerExecuted === true) continue
        const calls = pending.get(part.toolCallId)
        if (calls) calls.push(part)
        else pending.set(part.toolCallId, [part])
      }
    } else if (message.role === 'tool') {
      pending.delete(message.toolCallId)
    } else if (message.role === 'user' || message.role === 'system') {
      flushPending()
    }
  }
  flushPending()

  if (unanswered.size === 0) return messages

  return messages.flatMap((message) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      return [message]
    }
    const content = message.content.filter(
      (part) => part.type !== 'tool-call' || !unanswered.has(part),
    )
    return content.length > 0 ? [{ ...message, content }] : []
  })
}

// type NoContent<T> = T & { content?: never }
export type SystemContent =
  | string
  | SystemMessage['content'][number]
  | SystemMessage['content']
export function systemContent(
  content: SystemContent,
): SystemMessage['content'] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  if (Array.isArray(content)) {
    return content
  }
  return [content]
}

export function systemMessage(
  params:
    | SystemContent
    | ({
      content: SystemContent
    } & Omit<SystemMessage, 'role' | 'content'>),
): SystemMessage {
  if (typeof params === 'object' && 'content' in params) {
    return {
      ...params,
      role: 'system',
      content: systemContent(params.content),
    }
  }
  return {
    role: 'system',
    content: systemContent(params),
  }
}

export type UserContent =
  | string
  | UserMessage['content'][number]
  | UserMessage['content']
export function userContent(content: UserContent): UserMessage['content'] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  if (Array.isArray(content)) {
    return content
  }
  return [content]
}

export function userMessage(
  params:
    | UserContent
    | ({
      content: UserContent
    } & Omit<UserMessage, 'role' | 'content'>),
): UserMessage {
  if (typeof params === 'object' && 'content' in params) {
    return {
      ...params,
      role: 'user',
      content: userContent(params.content),
      sentAt: Date.now(),
    }
  }
  return {
    role: 'user',
    content: userContent(params),
    sentAt: Date.now(),
  }
}

export type AssistantContent =
  | string
  | AssistantMessage['content'][number]
  | AssistantMessage['content']
export function assistantContent(
  content: AssistantContent,
): AssistantMessage['content'] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  if (Array.isArray(content)) {
    return content
  }
  return [content]
}

export function assistantMessage(
  params:
    | AssistantContent
    | ({
      content: AssistantContent
    } & Omit<AssistantMessage, 'role' | 'content'>),
): AssistantMessage {
  if (typeof params === 'object' && 'content' in params) {
    return {
      ...params,
      role: 'assistant',
      content: assistantContent(params.content),
      sentAt: Date.now(),
    }
  }
  return {
    role: 'assistant',
    content: assistantContent(params),
    sentAt: Date.now(),
  }
}

export function jsonToolResult<T extends JSONValue>(
  value: T,
): [
    Extract<ToolResultOutput, { type: 'json' }> & {
      value: T
    },
  ] {
  return [
    {
      type: 'json',
      value,
    },
  ]
}

export function mediaToolResult(params: {
  data: string
  mediaType: string
}): [Extract<ToolResultOutput, { type: 'media' }>] {
  const { data, mediaType } = params
  return [
    {
      type: 'media',
      data,
      mediaType,
    },
  ]
}
