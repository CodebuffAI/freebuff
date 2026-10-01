/**
 * Ad-event hygiene shared by every ack/click client and the routes that
 * receive them (COD-365): the client-minted event id, the client-measured
 * render delay, the constant sample rate, and the server-side client family.
 *
 * Everything here is OPTIONAL on the wire. A binary that predates these
 * fields must keep acking and clicking exactly as before (AC8), so a route
 * reads each value as "present and well-formed, or unknown" and never
 * rejects a request over one of them -- telemetry must not fail a
 * revenue-adjacent ack.
 */

/**
 * One UUID per LOGICAL client event, reused on every retry of that event.
 * A header rather than a body field because the Web rail's ack is a bodyless
 * GET on a signed capability URL, and a query parameter on a signed URL is
 * unsigned client input; a header works on the browser's keepalive fetch and
 * on every native client alike.
 */
export const FREEBUFF_EVENT_ID_HEADER = 'X-Freebuff-Event-Id'

/**
 * Milliseconds from auction-response RECEIPT to card mount, on the client's
 * monotonic clock. Same header reasoning as the event id; POST clients may
 * also send it as `renderDelayMs` in the body, and the routes accept either.
 */
export const FREEBUFF_RENDER_DELAY_HEADER = 'X-Freebuff-Render-Delay-Ms'

/**
 * Integer denominator on every `ads.*` event. Nothing samples today, so it is
 * always 1 -- present from the start so that a producer that later samples
 * becomes a divisor (`sum(1.0 / coalesce(toreal(sample_rate), 1.0))`) rather
 * than a silent deflation of every count built on the stream. Sampling, if
 * it ever comes, applies to Axiom emission only: impression and click acks
 * are database writes and are never sampled.
 */
export const AD_EVENT_SAMPLE_RATE = 1

/** One day. Anything larger is a broken clock, not a slow render. */
export const RENDER_DELAY_MAX_MS = 86_400_000

const CLIENT_EVENT_ID_MAX_LENGTH = 128
const CLIENT_EVENT_ID_RE = /^[A-Za-z0-9._:-]+$/

/**
 * The first candidate that is a bounded, printable event id; null when none
 * is. Bounded in length and charset so it can be stored and logged as an
 * opaque token, never parsed. Callers pass the header first and any body
 * field second, so a client that sends both cannot disagree with itself.
 */
export function readClientEventId(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const value = candidate.trim()
    if (
      value.length > 0 &&
      value.length <= CLIENT_EVENT_ID_MAX_LENGTH &&
      CLIENT_EVENT_ID_RE.test(value)
    ) {
      return value
    }
  }
  return null
}

/**
 * Clamp a client-measured render delay to [0, RENDER_DELAY_MAX_MS], NEVER
 * reject: -5 stores 0, 9e9 stores the ceiling, both with a 200. Non-numeric
 * or non-finite input is UNKNOWN (null), which is also what an absent value
 * means -- the two are deliberately indistinguishable so that nothing can
 * ever derive a delay from `impression_fired_at - served_at` to fill the gap.
 */
export function clampRenderDelayMs(value: unknown): number | null {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(numeric)) return null
  return Math.min(RENDER_DELAY_MAX_MS, Math.max(0, Math.round(numeric)))
}

/** The first candidate that clamps to a number; null when none does. */
export function readRenderDelayMs(...candidates: unknown[]): number | null {
  for (const candidate of candidates) {
    const clamped = clampRenderDelayMs(candidate)
    if (clamped !== null) return clamped
  }
  return null
}

/* ------------------------------------------------------------------------- *
 * Dock expansion (COD-457)
 *
 * Expanding the dock is a UI gesture, NOT an ad event in the billable sense:
 * it fires no impression and no click, and nothing downstream may be tempted
 * to settle on it. The dedupe below is what keeps that true across a session —
 * a user who opens and closes the same ad ten times produced ONE expansion.
 * ------------------------------------------------------------------------- */

export const DOCK_EXPAND_METHODS = ['click', 'key'] as const
export type DockExpandMethod = (typeof DOCK_EXPAND_METHODS)[number]

export const DOCK_COLLAPSE_METHODS = [
  'esc',
  'close',
  'key',
  'outside',
  'rotate',
  'send',
  'gone',
] as const
export type DockCollapseMethod = (typeof DOCK_COLLAPSE_METHODS)[number]

/** Where a CTA click was pressed. Rides the click event, never the ack body. */
export const DOCK_CLICK_ORIGINS = ['dock', 'panel'] as const
export type DockClickOrigin = (typeof DOCK_CLICK_ORIGINS)[number]

/**
 * Under this, a click is flagged `accidental_click`: a LABEL for reporting.
 * Settlement is not this module's concern.
 */
export const DOCK_ACCIDENTAL_CLICK_MS = 300

/** Per-session dedupe for `ads.dock_expanded`, keyed by `impUrl`. */
export function claimDockExpansion(
  expansionsFired: Set<string>,
  impUrl: string,
): boolean {
  if (!impUrl) return false
  if (expansionsFired.has(impUrl)) return false
  expansionsFired.add(impUrl)
  return true
}

/** Non-negative whole milliseconds; a clock that moved backwards is a zero. */
export function dockDwellMs(openedAtMs: number, now: number): number {
  if (!Number.isFinite(openedAtMs) || !Number.isFinite(now)) return 0
  return Math.max(0, Math.round(now - openedAtMs))
}

export const AD_EVENT_CLIENT_FAMILIES = [
  'cli',
  'desktop',
  'web',
  'unknown',
] as const
export type AdEventClientFamily = (typeof AD_EVENT_CLIENT_FAMILIES)[number]

/**
 * Which client family sent a request, from the leading product token of its
 * `User-Agent` -- derived SERVER-SIDE, never taken from the body. Desktop
 * requests declare `surface: 'cli_chat'`, so surface alone cannot separate
 * CLI from Desktop; this can. A browser UA (`Mozilla/...`) is `web`; anything
 * unrecognised is `unknown` rather than a guess.
 */
export function clientFamilyFromUserAgent(
  raw: string | null | undefined,
): AdEventClientFamily {
  if (typeof raw !== 'string') return 'unknown'
  const [firstToken = ''] = raw.trim().split(/\s+/, 1)
  const product = firstToken.split('/', 1)[0]?.toLowerCase() ?? ''
  if (product === 'freebuff-cli' || product === 'codebuff-cli') return 'cli'
  if (product === 'freebuff-desktop' || product === 'codebuff-desktop') {
    return 'desktop'
  }
  if (product === 'mozilla') return 'web'
  return 'unknown'
}
