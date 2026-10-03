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
  if (running && !wasRunning) turnStartedAt = now
  if (!running) turnStartedAt = null
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

export type AdRendererFacts = { useMouse?: boolean; width?: number }
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

/**
 * Times `request` (a fetch to our API) into the RTT window. Resolves and
 * rejects exactly as `request` does; a failed request records nothing, since
 * its duration measures the failure rather than the network.
 */
export async function timedApiCall<T>(
  request: () => Promise<T>,
  now: () => number = () => performance.now(),
): Promise<T> {
  const startedAt = now()
  const result = await request()
  noteApiRtt(now() - startedAt)
  return result
}

export type AdSessionSnapshot = {
  adsServed: number
  lastAdAt: number | null
  lastClickAt: number | null
  lastSendAt: number | null
  rttSamplesMs: readonly number[]
}

export function getAdSessionSnapshot(): AdSessionSnapshot {
  return {
    adsServed,
    lastAdAt,
    lastClickAt,
    lastSendAt,
    rttSamplesMs: [...rttSamples],
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
}
