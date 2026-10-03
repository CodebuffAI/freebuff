/**
 * The process-wide facts the CLI's ad client context and engagement records
 * read (COD-757): when the user last sent a message, when the current turn
 * started, whether the transcript is scrolled up, the terminal's focus
 * reports, how many ads this session has served, and how fast our API
 * answers.
 *
 * Plain module state, because the readers are not React: the context is built
 * inside `buildAdAuctionRequest` and the engagement registry outlives any one
 * card. Every writer is a cheap, never-throwing note from the place that
 * already knows the fact; every reader tolerates "never noted" as unknown.
 *
 * TRAINING FEATURES ONLY: nothing here decides billing, invalid traffic or
 * eligibility.
 */
import {
  createTypingTracker,
  errorClassOf,
  toolCategoryOf,
  type ERROR_CLASSES,
  type TOOL_CATEGORIES,
  type TypingSummary,
} from '@codebuff/common/types/ad-client-context'

import { getTerminalProtocolController } from '../utils/terminal-protocol-controller'

/** How many API round trips the RTT median is taken over. */
export const AD_RTT_WINDOW = 20

type Listener<T> = (value: T) => void

function notify<T>(listeners: Set<Listener<T>>, value: T): void {
  for (const listener of listeners) {
    try {
      listener(value)
    } catch {
      // a feature listener must never break the note that fed it
    }
  }
}

// ------------------------------------------------------------- user sends

let lastSendAt: number | null = null
const sendListeners = new Set<Listener<number>>()

/** The user submitted a prompt. Called once per prompt, from the router. */
export function noteAdUserSend(now: number = Date.now()): void {
  lastSendAt = now
  notify(sendListeners, now)
}

export function getAdLastSendAt(): number | null {
  return lastSendAt
}

export function subscribeAdUserSend(listener: Listener<number>): () => void {
  sendListeners.add(listener)
  return () => {
    sendListeners.delete(listener)
  }
}

// -------------------------------------------------------------- the turn

let turnStartedAt: number | null = null

/**
 * Feed the chat store's `isChainInProgress` here on every change. Only an
 * observed false -> true edge stamps a start, so a turn already running when
 * watching began has an unknown elapsed time rather than a wrong one.
 */
export function noteAdTurnState(
  running: boolean,
  wasRunning: boolean,
  now: number = Date.now(),
): void {
  if (running && !wasRunning) {
    turnStartedAt = now
    awaitingFirstTokenSince = now
  }
  if (!running) {
    turnStartedAt = null
    awaitingFirstTokenSince = null
  }
}

/** The running turn's first-token wait began here; null once it streamed. */
let awaitingFirstTokenSince: number | null = null
let lastTtftMs: number | null = null

/**
 * A chunk streamed. Called for EVERY chunk, so it is one null check after the
 * first: only the first chunk of an observed turn start records a TTFT.
 */
export function noteAdStreamChunk(now: number = Date.now()): void {
  if (awaitingFirstTokenSince === null) return
  const elapsed = now - awaitingFirstTokenSince
  awaitingFirstTokenSince = null
  if (Number.isFinite(elapsed) && elapsed >= 0) lastTtftMs = elapsed
}

export function getAdTurnStartedAt(): number | null {
  return turnStartedAt
}

// ------------------------------------------------------------ transcript

let transcriptScrolledUp: boolean | null = null

export type TranscriptViewport = { top: number; bottom: number }
let transcriptViewport: (() => TranscriptViewport | null) | null = null

/** The transcript scrollbox is away from the bottom, where the slot is drawn. */
export function setAdTranscriptScrolledUp(scrolledUp: boolean): void {
  transcriptScrolledUp = scrolledUp
}

export function getAdTranscriptScrolledUp(): boolean | null {
  return transcriptScrolledUp
}

/**
 * The transcript viewport's screen rows, for an inline card to test whether it
 * is on screen. Returns the unregister; only the registering getter is removed.
 */
export function registerAdTranscriptViewport(
  getter: () => TranscriptViewport | null,
): () => void {
  transcriptViewport = getter
  return () => {
    if (transcriptViewport === getter) transcriptViewport = null
  }
}

export function getAdTranscriptViewport(): TranscriptViewport | null {
  if (!transcriptViewport) return null
  try {
    const viewport = transcriptViewport()
    if (
      !viewport ||
      !Number.isFinite(viewport.top) ||
      !Number.isFinite(viewport.bottom) ||
      viewport.bottom <= viewport.top
    )
      return null
    return viewport
  } catch {
    return null
  }
}

// ------------------------------------------------------------- renderer

export type AdRendererFacts = {
  useMouse?: boolean
  width?: number
  height?: number
}
let rendererFacts: (() => AdRendererFacts | null) | null = null

/** The OpenTUI renderer's live mouse mode and width. */
export function registerAdRenderer(
  getter: () => AdRendererFacts | null,
): () => void {
  rendererFacts = getter
  return () => {
    if (rendererFacts === getter) rendererFacts = null
  }
}

export function getAdRendererFacts(): AdRendererFacts | null {
  if (!rendererFacts) return null
  try {
    return rendererFacts()
  } catch {
    return null
  }
}

// ---------------------------------------------------------- terminal focus

/**
 * DEC 1004 focus reports, as `TerminalProtocolController` parses them. Until
 * the terminal has sent one, support is unknown and so is focus: a terminal
 * that never reports focus must read as "unknown", never as "unfocused".
 */
let focusSupported = false
let terminalFocused: boolean | null = null
let focusWatchInstalled = false
const focusListeners = new Set<Listener<boolean>>()

/** Test seam and the controller's own callback. */
export function noteAdTerminalFocus(focused: boolean): void {
  focusSupported = true
  if (terminalFocused === focused) return
  terminalFocused = focused
  notify(focusListeners, focused)
}

/** Subscribe to the controller once; retried on the next call until it exists. */
export function ensureAdTerminalFocusWatch(): void {
  if (focusWatchInstalled) return
  const controller = getTerminalProtocolController()
  if (!controller) return
  focusWatchInstalled = true
  try {
    controller.subscribeToFocus({
      onFocusChange: noteAdTerminalFocus,
      onSupportDetected: () => {
        focusSupported = true
      },
    })
  } catch {
    // focus is a feature; unknown is a fine answer
  }
}

/** `undefined` until the terminal has reported its focus at least once. */
export function getAdTerminalFocus(): boolean | undefined {
  return focusSupported && terminalFocused !== null
    ? terminalFocused
    : undefined
}

/** The engagement tracker's view: focus counts as supported once it is known. */
export function getAdTerminalFocusState(): {
  supported: boolean
  focused: boolean | null
} {
  const focused = getAdTerminalFocus()
  return { supported: focused !== undefined, focused: focused ?? null }
}

export function subscribeAdTerminalFocus(
  listener: Listener<boolean>,
): () => void {
  focusListeners.add(listener)
  return () => {
    focusListeners.delete(listener)
  }
}

// ------------------------------------------------------- session counters

let adsServed = 0
let lastAdAt: number | null = null
let lastClickAt: number | null = null
const rttSamples: number[] = []

/** `count` ads arrived from an auction this session. */
export function noteAdsServed(count: number, now: number = Date.now()): void {
  if (!Number.isFinite(count) || count <= 0) return
  adsServed += Math.floor(count)
  lastAdAt = now
}

export function noteAdClicked(now: number = Date.now()): void {
  lastClickAt = now
}

/** One round trip to our own API, start to response headers. */
export function noteApiRtt(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return
  rttSamples.push(ms)
  if (rttSamples.length > AD_RTT_WINDOW)
    rttSamples.splice(0, rttSamples.length - AD_RTT_WINDOW)
}

/** Counting stops here: the top `COUNT_BUCKETS` bucket is `21+`. */
const FAILED_REQUEST_CAP = 10_000
let failedRequests = 0
let lastAdFetchMs: number | null = null

/** An API or ad request this session failed (threw, or answered non-2xx). */
export function noteAdFailedRequest(): void {
  if (failedRequests < FAILED_REQUEST_CAP) failedRequests += 1
}

const isFailedResponse = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  'ok' in value &&
  (value as { ok: unknown }).ok === false

/**
 * Times `request` (a fetch to our API) into the RTT window. Resolves and
 * rejects exactly as `request` does; a failed request records no RTT, since
 * its duration measures the failure rather than the network, and counts as a
 * failed request (a throw, or a `Response` that is not ok).
 */
export async function timedApiCall<T>(
  request: () => Promise<T>,
  now: () => number = () => performance.now(),
): Promise<T> {
  const startedAt = now()
  let result: T
  try {
    result = await request()
  } catch (err) {
    noteAdFailedRequest()
    throw err
  }
  noteApiRtt(now() - startedAt)
  if (isFailedResponse(result)) noteAdFailedRequest()
  return result
}

/**
 * Times one ad auction request (`net.adFetch` on the NEXT request). Resolves
 * and rejects exactly as `request` does. Any answer, ok or not, is a duration;
 * a throw or a non-ok answer is also a failed request.
 */
export async function timedAdFetch<T>(
  request: () => Promise<T>,
  now: () => number = () => performance.now(),
): Promise<T> {
  const startedAt = now()
  let result: T
  try {
    result = await request()
  } catch (err) {
    noteAdFailedRequest()
    throw err
  }
  const elapsed = now() - startedAt
  if (Number.isFinite(elapsed) && elapsed >= 0) lastAdFetchMs = elapsed
  if (isFailedResponse(result)) noteAdFailedRequest()
  return result
}

export type AdSessionSnapshot = {
  adsServed: number
  lastAdAt: number | null
  lastClickAt: number | null
  lastSendAt: number | null
  rttSamplesMs: readonly number[]
  /** Failed API/ad requests this session; absent = not tracked. */
  failedRequests?: number
  /** The last observed turn's time to first streamed chunk. */
  lastTtftMs?: number | null
  /** How long the previous ad request took. */
  lastAdFetchMs?: number | null
}

export function getAdSessionSnapshot(): AdSessionSnapshot {
  return {
    adsServed,
    lastAdAt,
    lastClickAt,
    lastSendAt,
    rttSamplesMs: [...rttSamples],
    failedRequests,
    lastTtftMs,
    lastAdFetchMs,
  }
}

// --------------------------------------------------------------- typing

/**
 * The composer's keystrokes, reduced by the shared tracker: only THAT a key
 * was pressed and whether it deleted, never which key. On the engagement
 * clock (`performance.now`), so an exposure's keystrokes can be counted
 * against it.
 */
let typing = createTypingTracker(() => performance.now())
let typingSeen = false
const keystrokeListeners = new Set<Listener<void>>()

/** One composer keystroke. Called from the input's key handler; never throws. */
export function noteAdKeystroke(deletion: boolean): void {
  try {
    typingSeen = true
    typing.note(deletion)
    notify(keystrokeListeners, undefined)
  } catch {
    // a feature must never break typing
  }
}

/** `null` until the composer has reported a keystroke this process. */
export function getAdTypingSummary(): TypingSummary | null {
  return typingSeen ? typing.summary() : null
}

export function subscribeAdKeystroke(listener: Listener<void>): () => void {
  keystrokeListeners.add(listener)
  return () => {
    keystrokeListeners.delete(listener)
  }
}

// ------------------------------------------------------------- workload

type ToolCategory = (typeof TOOL_CATEGORIES)[number]
type ErrorClass = (typeof ERROR_CLASSES)[number]

/** Failed turns are counted over this trailing window. */
export const AD_TURN_FAILURE_WINDOW_MS = 3_600_000
/** Bounds the failure timestamps: the top bucket is `21+`. */
const TURN_FAILURE_MAX = 32

let queuedCount: number | null = null
let lastToolCategory: ToolCategory | null = null
let lastErrorClass: ErrorClass = 'none'
const turnFailureAt: number[] = []
const commandListeners = new Set<Listener<string>>()

/** The composer's message queue length, from its single write path. */
export function noteAdQueuedCount(count: number): void {
  if (Number.isFinite(count) && count >= 0) queuedCount = Math.floor(count)
}

/**
 * The agent called a tool. Only its category is kept. `command` is a shell
 * command the agent is about to run: handed in memory to the post-click
 * adoption watch and never stored here.
 */
export function noteAdToolCall(
  toolName: string | undefined,
  command?: string,
): void {
  try {
    lastToolCategory = toolCategoryOf(toolName)
    if (typeof command === 'string' && command.length > 0)
      notify(commandListeners, command)
  } catch {
    // a feature must never break the event stream
  }
}

export function subscribeAdAgentCommand(
  listener: Listener<string>,
): () => void {
  commandListeners.add(listener)
  return () => {
    commandListeners.delete(listener)
  }
}

/**
 * The text a failed tool result carries, or undefined when it did not fail:
 * an `errorMessage`, or a non-zero exit code (with its stderr, when any).
 */
export function failedToolOutputText(output: unknown): string | undefined {
  if (!Array.isArray(output)) return undefined
  for (const part of output) {
    if (!part || typeof part !== 'object' || !('value' in part)) continue
    const value = (part as { value: unknown }).value
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const v = value as {
      errorMessage?: unknown
      exitCode?: unknown
      stderr?: unknown
    }
    if (typeof v.errorMessage === 'string' && v.errorMessage)
      return v.errorMessage
    if (typeof v.exitCode === 'number' && v.exitCode !== 0)
      return typeof v.stderr === 'string' && v.stderr ? v.stderr : 'failed'
  }
  return undefined
}

/** A tool result arrived: a failed one sets `lastError` to its class only. */
export function noteAdToolResult(output: unknown): void {
  try {
    const text = failedToolOutputText(output)
    if (text !== undefined) lastErrorClass = errorClassOf(text)
  } catch {
    // a feature must never break the event stream
  }
}

/** A turn failed. Only the class of its message is kept, never the text. */
export function noteAdTurnFailure(
  message: string | undefined,
  now: number = Date.now(),
): void {
  try {
    lastErrorClass = errorClassOf(message || 'failed')
    turnFailureAt.push(now)
    if (turnFailureAt.length > TURN_FAILURE_MAX)
      turnFailureAt.splice(0, turnFailureAt.length - TURN_FAILURE_MAX)
  } catch {
    // a feature must never break error handling
  }
}

export type AdWorkSnapshot = {
  queued: number | null
  tool: ToolCategory | null
  lastError: ErrorClass
  turnFailuresLastHour: number
}

export function getAdWorkSnapshot(now: number = Date.now()): AdWorkSnapshot {
  let failures = 0
  for (const at of turnFailureAt)
    if (now - at >= 0 && now - at < AD_TURN_FAILURE_WINDOW_MS) failures++
  return {
    queued: queuedCount,
    tool: lastToolCategory,
    lastError: lastErrorClass,
    turnFailuresLastHour: failures,
  }
}

/** Test seam: forget every note. */
export function resetAdSignalsForTests(): void {
  lastSendAt = null
  sendListeners.clear()
  turnStartedAt = null
  transcriptScrolledUp = null
  transcriptViewport = null
  rendererFacts = null
  focusSupported = false
  terminalFocused = null
  focusWatchInstalled = false
  focusListeners.clear()
  adsServed = 0
  lastAdAt = null
  lastClickAt = null
  rttSamples.length = 0
  awaitingFirstTokenSince = null
  lastTtftMs = null
  failedRequests = 0
  lastAdFetchMs = null
  typing = createTypingTracker(() => performance.now())
  typingSeen = false
  keystrokeListeners.clear()
  queuedCount = null
  lastToolCategory = null
  lastErrorClass = 'none'
  turnFailureAt.length = 0
  commandListeners.clear()
}
