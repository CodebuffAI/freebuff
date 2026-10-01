/**
 * The three client events a SPONSOR BREAK emits (COD-453 scope item 6).
 *
 * A break is the only ad unit on any surface that takes the screen away from
 * the person using it, so the question it has to answer is not "was it seen"
 * -- an interruption is always seen -- but "what did it cost them". That is
 * what `dwell_ms` and the close METHOD are for, and why they are separate
 * events rather than fields on the existing impression ack:
 *
 *  - `ads.break_shown` is the denominator. Without it a low click count and a
 *    break that never rendered are the same row.
 *  - `ads.break_closed` is the cost. `method` says HOW they got out, and the
 *    difference between `continue` (they read it and moved on) and `escape`
 *    (they hit a key to make it go away) is the whole readout.
 *  - `ads.break_clicked` carries `dwell_ms` so an ACCIDENTAL click -- one
 *    landing in the first fraction of a second, on a card that appeared under
 *    a cursor already in motion -- is distinguishable from a considered one.
 *    The parent issue requires those be RECORDED rather than dropped, so the
 *    click route stores the dwell and nothing here filters.
 *
 * CONTINUATION IS DERIVED, NOT EMITTED. Whether the person went back to work
 * is the next user turn within 10 minutes of `break_closed`, computed in APL
 * from turn events that already exist. Emitting a "resumed" event would ask
 * the client to observe something it has no reliable view of.
 *
 * Every event carries the COD-365 hygiene fields from `./ad-event-hygiene`:
 * the client-minted `client_event_id` (one per LOGICAL event, reused on
 * retry), the server-derived `client_family`, and `sample_rate`.
 */
import {
  AD_EVENT_SAMPLE_RATE,
  clampRenderDelayMs,
  readClientEventId,
} from './ad-event-hygiene'

import type { AdEventClientFamily } from './ad-event-hygiene'

export const ADS_BREAK_SHOWN_EVENT = 'ads.break_shown' as const
export const ADS_BREAK_CLOSED_EVENT = 'ads.break_closed' as const
export const ADS_BREAK_CLICKED_EVENT = 'ads.break_clicked' as const

export const SPONSOR_BREAK_EVENTS = [
  ADS_BREAK_SHOWN_EVENT,
  ADS_BREAK_CLOSED_EVENT,
  ADS_BREAK_CLICKED_EVENT,
] as const
export type SponsorBreakEvent = (typeof SPONSOR_BREAK_EVENTS)[number]

/**
 * Whether an untrusted value names one of the three break events.
 *
 * A CLOSED set at the boundary, for the same reason
 * {@link isSponsorBreakCloseMethod} is: these names become the `event` field
 * every break readout groups on, and a client that could invent one would
 * widen that field's cardinality with rows nothing queries.
 */
export function isSponsorBreakEvent(
  value: unknown,
): value is SponsorBreakEvent {
  return (
    typeof value === 'string' &&
    (SPONSOR_BREAK_EVENTS as readonly string[]).includes(value)
  )
}

/**
 * How a break ended. A CLOSED vocabulary, like the census codes: these are a
 * histogram dimension and an open set would let a new renderer widen the
 * cardinality of the field the whole readout groups on.
 *
 * - `x` — the explicit dismiss control.
 * - `continue` — the affirmative "I'm done reading" button.
 * - `escape` — a keyboard dismiss. Deliberately NOT pooled with `x`: one is a
 *   considered exit and one is a reflex, and telling them apart is how a
 *   format learns whether it is being read or swatted.
 * - `timer_then_continue` — Intermission only: the countdown finished and THEN
 *   they pressed continue. Distinct from `continue` because the countdown
 *   makes the two mean different things about the dwell that preceded them.
 * - `click` — they left through the ad. The break also emits
 *   `ads.break_clicked`; this method is what stops a click showing up as an
 *   unexplained missing close.
 * - `thread_switch` — they navigated away entirely. The strongest available
 *   signal that the break was in the way, and the reason a break is never
 *   counted as "continued" on this method.
 */
export const SPONSOR_BREAK_CLOSE_METHODS = [
  'x',
  'continue',
  'escape',
  'timer_then_continue',
  'click',
  'thread_switch',
] as const
export type SponsorBreakCloseMethod =
  (typeof SPONSOR_BREAK_CLOSE_METHODS)[number]

export function isSponsorBreakCloseMethod(
  value: unknown,
): value is SponsorBreakCloseMethod {
  return (
    typeof value === 'string' &&
    (SPONSOR_BREAK_CLOSE_METHODS as readonly string[]).includes(value)
  )
}

/**
 * Why a break appeared. One value today; an enum rather than a constant so a
 * second trigger cannot arrive as free text on the same field.
 */
export const SPONSOR_BREAK_TRIGGERS = ['turn_completed'] as const
export type SponsorBreakTrigger = (typeof SPONSOR_BREAK_TRIGGERS)[number]

/**
 * The longest dwell worth storing: one hour.
 *
 * Much tighter than `RENDER_DELAY_MAX_MS` (a day) and for a different reason.
 * A render delay of hours is a broken clock; a DWELL of hours is a laptop that
 * slept with the break open, which is a real and common event whose value is
 * meaningless. Clamping rather than discarding keeps the row in the
 * denominator -- the break WAS shown -- while stopping one suspended machine
 * from owning the p90.
 */
export const SPONSOR_BREAK_DWELL_MAX_MS = 3_600_000

/**
 * Below this, a click is presumed ACCIDENTAL: the card appeared under a cursor
 * that was already moving.
 *
 * A REPORTING threshold: it lets a dashboard say how many of the clicks on a
 * format were plausibly accidental, which is the number that decides whether
 * the format is honest.
 */
export const SPONSOR_BREAK_ACCIDENTAL_CLICK_MS = 300

/**
 * Clamp a client-measured dwell to [0, {@link SPONSOR_BREAK_DWELL_MAX_MS}].
 * NEVER rejects, exactly like {@link clampRenderDelayMs}: -5 stores 0, 9e9
 * stores the ceiling, and non-numeric input is UNKNOWN (null) -- which is also
 * what an absent value means, so nothing downstream can reconstruct a dwell
 * from timestamps to fill the gap.
 */
export function clampDwellMs(value: unknown): number | null {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(numeric)) return null
  return Math.min(SPONSOR_BREAK_DWELL_MAX_MS, Math.max(0, Math.round(numeric)))
}

/** The first candidate that clamps to a number; null when none does. */
export function readDwellMs(...candidates: unknown[]): number | null {
  for (const candidate of candidates) {
    const clamped = clampDwellMs(candidate)
    if (clamped !== null) return clamped
  }
  return null
}

/** Header form, for the ack-shaped callers that have no body to put it in. */
export const FREEBUFF_DWELL_HEADER = 'X-Freebuff-Dwell-Ms'

export interface SponsorBreakEventPayload {
  placement_id: string
  surface: string
  /** The break's render format: `spotlight` | `showcase` | `intermission`. */
  format: string
  /** The sticky arm this user is in, so the event needs no join to be read. */
  sponsor_break_arm: string
  /** Opaque allocation label, never a campaign id -- see `eligibility-census`. */
  campaign_label?: string
  creative_version?: number
  opportunity_id?: string
  trigger?: SponsorBreakTrigger
  method?: SponsorBreakCloseMethod
  dwell_ms?: number
  timer_ms?: number
  timer_completed?: boolean
  /**
   * THE DISMISS LOCK: how long the ways OUT were held, in milliseconds of
   * VISIBLE time. Spotlight (COD-454) and Showcase (COD-455) both hold their
   * dismissals, so this is ONE field across the formats and `format` is what
   * separates them.
   *
   * Separate from `timer_ms` because the two hold different things -- the
   * countdown gates the whole card, the lock only the dismissals -- and
   * pooling them would make the readout unable to say which format a row came
   * from without joining on `format`. Concretely: Intermission's `timer_ms`
   * counts down to a Continue button the person is waiting ON, while this
   * counts down to a control they may never look for, on a card that is fully
   * clickable and fully ignorable throughout.
   */
  dismiss_lock_ms?: number
  /**
   * Whether that lock had expired when the break closed. The one field that
   * distinguishes "they waited it out and then left" from "they took the CTA
   * while it was still held", which is the number that says whether the lock
   * is buying attention or manufacturing clicks.
   */
  lock_completed?: boolean
  client_event_id?: string
  client_family?: AdEventClientFamily
  sample_rate: number
}

/**
 * Build one break event payload from client-supplied values.
 *
 * TOTAL, and every optional field degrades to absent rather than to a
 * sentinel: a break renderer that predates a field must keep emitting exactly
 * as it does today, which is the same rule `ad-event-hygiene` states for the
 * ack and click routes. Nothing here can throw, and nothing here rejects --
 * telemetry must never fail the thing it is measuring.
 */
export function buildSponsorBreakEvent(params: {
  placementId: string
  surface: string
  format: string
  arm: string
  campaignLabel?: string | null
  creativeVersion?: number | null
  opportunityId?: string | null
  trigger?: SponsorBreakTrigger
  method?: unknown
  dwellMs?: unknown
  timerMs?: unknown
  timerCompleted?: unknown
  dismissLockMs?: unknown
  lockCompleted?: unknown
  clientEventId?: unknown
  clientFamily?: AdEventClientFamily
}): SponsorBreakEventPayload {
  const dwellMs = clampDwellMs(params.dwellMs)
  const timerMs = clampDwellMs(params.timerMs)
  const dismissLockMs = clampDwellMs(params.dismissLockMs)
  const clientEventId = readClientEventId(params.clientEventId)
  return {
    placement_id: params.placementId,
    surface: params.surface,
    format: params.format,
    sponsor_break_arm: params.arm,
    ...(params.campaignLabel ? { campaign_label: params.campaignLabel } : {}),
    ...(typeof params.creativeVersion === 'number'
      ? { creative_version: params.creativeVersion }
      : {}),
    ...(params.opportunityId ? { opportunity_id: params.opportunityId } : {}),
    ...(params.trigger ? { trigger: params.trigger } : {}),
    ...(isSponsorBreakCloseMethod(params.method)
      ? { method: params.method }
      : {}),
    ...(dwellMs === null ? {} : { dwell_ms: dwellMs }),
    ...(timerMs === null ? {} : { timer_ms: timerMs }),
    ...(typeof params.timerCompleted === 'boolean'
      ? { timer_completed: params.timerCompleted }
      : {}),
    ...(dismissLockMs === null ? {} : { dismiss_lock_ms: dismissLockMs }),
    ...(typeof params.lockCompleted === 'boolean'
      ? { lock_completed: params.lockCompleted }
      : {}),
    ...(clientEventId ? { client_event_id: clientEventId } : {}),
    ...(params.clientFamily ? { client_family: params.clientFamily } : {}),
    sample_rate: AD_EVENT_SAMPLE_RATE,
  }
}
