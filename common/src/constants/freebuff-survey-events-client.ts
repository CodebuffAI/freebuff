/**
 * Sponsored-survey funnel pings (COD-837): the client half every surface
 * shares. The profile survey does not use this: its engagement events go
 * through `/api/profile-survey` into `profile_survey_event` (#6278).
 *
 * Two pieces, no React and no network of their own:
 *
 *  - `createSurveyEventSink` buffers events and hands them to the surface's
 *    `send` in batches of at most `SURVEY_EVENT_BATCH_MAX`: after
 *    `flushAt` events, `flushIntervalMs` after the first unsent one, or on
 *    `unload()` (page hide, window close, process exit). Fire and forget:
 *    `send` failures are swallowed and the batch is gone, nothing retries, and
 *    no method ever throws into the UI.
 *  - `createSurveyCardTracker` turns what one survey card does into events:
 *    `card_rendered` once, `question_viewed` per question shown, `answered`
 *    with dwell, `dismissed`, and `abandoned` when the card goes away (or the
 *    app does) while its current question is unanswered.
 *
 * Each surface wires a sink to its transport (Desktop's orchestrator proxy,
 * Web's same-origin fetch / beacon, the CLI's bearer fetch) and calls the
 * tracker from the sponsored card with `('sponsored', campaignId)`.
 */
import {
  SURVEY_EVENT_BATCH_MAX,
  SURVEY_EVENT_DWELL_MS_MAX,
} from './freebuff-sponsored-survey'

import type { ProfileSurveySurface } from './freebuff-profile-survey'
import type {
  SurveyEventBatch,
  SurveyEventInput,
  SurveyEventKind,
} from './freebuff-sponsored-survey'

export const SURVEY_EVENTS_PATH = '/api/survey-events'

/** Flush this long after the first unsent event. */
export const SURVEY_EVENT_FLUSH_INTERVAL_MS = 5_000
/** Flush as soon as this many events are waiting. */
export const SURVEY_EVENT_FLUSH_AT = 10
/** Events held while `send` is slow or failing; the oldest go first. */
export const SURVEY_EVENT_BUFFER_MAX = 200

export type SurveyEventSendOptions = {
  /** The page or process is going away: use a transport that survives it
   *  (`sendBeacon`, `keepalive`), and do not wait on the answer. */
  unloading: boolean
}

/** Delivers one batch. May reject or throw; the sink swallows it. */
export type SurveyEventSender = (
  batch: SurveyEventBatch,
  options: SurveyEventSendOptions,
) => Promise<unknown> | void

export interface SurveyEventSink {
  push(event: SurveyEventInput): void
  /** Send everything buffered now. Resolves when the sends settle; never
   *  rejects. */
  flush(options?: Partial<SurveyEventSendOptions>): Promise<void>
  /** The page or process is going away: run the unload listeners (cards
   *  report `abandoned`), then flush with `unloading: true`. */
  unload(): Promise<void>
  /** Called first by `unload()`. Returns the unsubscribe. */
  onUnload(listener: () => void): () => void
  /** Events not yet handed to `send` (tests). */
  pending(): number
}

type TimerHandle = unknown

export type SurveyEventSinkOptions = {
  send: SurveyEventSender
  flushIntervalMs?: number
  flushAt?: number
  bufferMax?: number
  setTimer?: (fn: () => void, ms: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
}

export function createSurveyEventSink(
  options: SurveyEventSinkOptions,
): SurveyEventSink {
  const flushIntervalMs =
    options.flushIntervalMs ?? SURVEY_EVENT_FLUSH_INTERVAL_MS
  const flushAt = Math.min(
    options.flushAt ?? SURVEY_EVENT_FLUSH_AT,
    SURVEY_EVENT_BATCH_MAX,
  )
  const bufferMax = options.bufferMax ?? SURVEY_EVENT_BUFFER_MAX
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms) as unknown as { unref?: () => void }
      // a pending flush must never keep a CLI process alive
      handle.unref?.()
      return handle
    })
  const clearTimer =
    options.clearTimer ??
    ((handle: TimerHandle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>))

  let buffer: SurveyEventInput[] = []
  let timer: TimerHandle | null = null
  const listeners = new Set<() => void>()

  const cancelTimer = () => {
    if (timer === null) return
    try {
      clearTimer(timer)
    } catch {}
    timer = null
  }

  const sendSafely = async (
    batch: SurveyEventBatch,
    sendOptions: SurveyEventSendOptions,
  ): Promise<void> => {
    try {
      await options.send(batch, sendOptions)
    } catch {
      // fire and forget: a lost ping is not worth a retry loop or a banner
    }
  }

  const flush = async (
    flushOptions: Partial<SurveyEventSendOptions> = {},
  ): Promise<void> => {
    cancelTimer()
    if (buffer.length === 0) return
    const events = buffer
    buffer = []
    const sends: Promise<void>[] = []
    for (let i = 0; i < events.length; i += SURVEY_EVENT_BATCH_MAX) {
      sends.push(
        sendSafely(
          { events: events.slice(i, i + SURVEY_EVENT_BATCH_MAX) },
          { unloading: flushOptions.unloading ?? false },
        ),
      )
    }
    await Promise.all(sends)
  }

  return {
    push(event) {
      try {
        buffer.push(event)
        if (buffer.length > bufferMax)
          buffer = buffer.slice(buffer.length - bufferMax)
        if (buffer.length >= flushAt) {
          void flush()
          return
        }
        if (timer === null) {
          timer = setTimer(() => {
            timer = null
            void flush()
          }, flushIntervalMs)
        }
      } catch {}
    },
    flush,
    async unload() {
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {}
      }
      await flush({ unloading: true })
    },
    onUnload(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    pending: () => buffer.length,
  }
}

// ---- one card's events ---------------------------------------------------

export type SurveyCardTrackerOptions = {
  sink: SurveyEventSink | null | undefined
  surveyKind: SurveyEventKind
  /** Sponsored: the campaign id. (Profile, unused since #6278: the version.) */
  surveyRef: string
  surface: ProfileSurveySurface
  now?: () => number
}

export interface SurveyCardTracker {
  /** The card is on screen. Once per tracker. */
  rendered(): void
  /** Question `index` is showing. A repeat of the current one is ignored. */
  viewed(index: number, questionId: string): void
  /** The current question was answered; dwell is since it was viewed unless
   *  given. */
  answered(dwellMs?: number): void
  /** "Not now" on the current question. Ends the card. */
  dismissed(): void
  /** Every question is answered. Ends the card. */
  completed(): void
  /** The card is gone (unmounted, closed, app exiting). Reports `abandoned`
   *  once if the current question was viewed and not answered. */
  ended(): void
}

type Current = {
  index: number
  questionId: string
  viewedAt: number
  answered: boolean
}

export function createSurveyCardTracker(
  options: SurveyCardTrackerOptions,
): SurveyCardTracker {
  const now = options.now ?? Date.now
  let rendered = false
  let finished = false
  let current: Current | null = null

  const emit = (
    eventType: SurveyEventInput['eventType'],
    extra: Partial<SurveyEventInput> = {},
  ) => {
    try {
      options.sink?.push({
        surveyKind: options.surveyKind,
        surveyRef: options.surveyRef,
        eventType,
        surface: options.surface,
        clientTs: new Date(now()).toISOString(),
        ...extra,
      })
    } catch {}
  }

  const question = (): Partial<SurveyEventInput> =>
    current
      ? { questionId: current.questionId, questionIndex: current.index }
      : {}

  const dwellSinceView = () =>
    current ? clampDwell(now() - current.viewedAt) : undefined

  return {
    rendered() {
      if (rendered || finished) return
      rendered = true
      emit('card_rendered')
    },
    viewed(index, questionId) {
      if (finished) return
      if (current?.index === index && current.questionId === questionId) return
      current = { index, questionId, viewedAt: now(), answered: false }
      emit('question_viewed', question())
    },
    answered(dwellMs) {
      if (finished || !current) return
      emit('answered', {
        ...question(),
        dwellMs: dwellMs === undefined ? dwellSinceView() : clampDwell(dwellMs),
      })
      current.answered = true
    },
    dismissed() {
      if (finished) return
      emit('dismissed', { ...question(), dwellMs: dwellSinceView() })
      finished = true
    },
    completed() {
      finished = true
    },
    ended() {
      if (finished) return
      finished = true
      if (current && !current.answered)
        emit('abandoned', { ...question(), dwellMs: dwellSinceView() })
    },
  }
}

function clampDwell(ms: number): number {
  if (!Number.isFinite(ms)) return 0
  return Math.min(SURVEY_EVENT_DWELL_MS_MAX, Math.max(0, Math.round(ms)))
}
