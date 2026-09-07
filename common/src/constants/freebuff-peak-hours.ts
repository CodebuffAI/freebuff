/**
 * DeepSeek's peak pricing windows — the one definition, shared by the billing
 * code that prices a request and the availability rule that pauses V4 Pro
 * while DeepSeek is at its dearest.
 *
 * It lives in `common/` because BOTH sides need it and they must never drift:
 * a model paused for "peak" that disagreed with the window billing actually
 * charged double for would be worse than no feature at all. Public-repo safe —
 * these hours are published on api-docs.deepseek.com/quick_start/pricing, and
 * nothing here reveals our pricing, our margins, or our limits.
 */

/**
 * Peak hours, from api-docs.deepseek.com/quick_start/pricing (read 2026-08-16):
 * "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC (all other hours are
 * off-peak)." These windows apply Monday-Friday Beijing time; weekends are
 * always off-peak.
 *
 * Half-open [start, end): 04:00:00 UTC itself is already off-peak. TWO
 * disjoint windows, not one — the 04:00-06:00 gap between them is exactly what
 * a single range check gets silently wrong.
 */
export const DEEPSEEK_PEAK_HOUR_RANGES_UTC: ReadonlyArray<
  readonly [number, number]
> = [
  [1, 4],
  [6, 10],
] as const

export type DeepSeekPricingWindow = 'peak' | 'off-peak'

function isBeijingWeekend(at: Date): boolean {
  const beijingDay = new Date(at.getTime() + 8 * 60 * 60 * 1000).getUTCDay()
  return beijingDay === 0 || beijingDay === 6
}

/**
 * Which rate card applies at `at`.
 *
 * Takes the instant explicitly rather than reading the clock: the caller has to
 * decide WHICH instant (a request's completion time for billing, "now" for a
 * ceiling), and a hidden `new Date()` would make both untestable.
 */
export function deepseekPricingWindow(at: Date): DeepSeekPricingWindow {
  if (isBeijingWeekend(at)) return 'off-peak'
  const hour = at.getUTCHours()
  const peak = DEEPSEEK_PEAK_HOUR_RANGES_UTC.some(
    ([startHour, endHour]) => hour >= startHour && hour < endHour,
  )
  return peak ? 'peak' : 'off-peak'
}

// ---------------------------------------------------------------------------
// The expensive window
// ---------------------------------------------------------------------------

/**
 * How long before peak opens the window starts.
 *
 * One hour. A free session runs for an hour and keeps its model for all of it,
 * so a session admitted at 00:30 would still be generating deep into peak
 * pricing. Standing off an hour early means the sessions still running when the
 * rate doubles were never admitted in the first place.
 */
export const DEEPSEEK_EXPENSIVE_WINDOW_LEAD_HOURS = 1

/**
 * The single weekday window in which DeepSeek is at its most expensive,
 * [start, end) UTC — 00:00 to 10:00, which is 5pm to 3am Pacific.
 *
 * DERIVED from DEEPSEEK_PEAK_HOUR_RANGES_UTC rather than written down, so it
 * cannot drift the day DeepSeek moves its hours.
 *
 * ONE window, not two, and it deliberately swallows the 04:00-06:00 off-peak
 * gap between the peaks. Reopening for a two-hour gap would admit hour-long
 * sessions that run straight into the second peak, so every session it let
 * through would be billed at double for most of its life. A gap this short is
 * cheaper to skip than to use.
 */
export const DEEPSEEK_EXPENSIVE_WINDOW_UTC: readonly [number, number] = [
  Math.min(...DEEPSEEK_PEAK_HOUR_RANGES_UTC.map(([start]) => start)) -
    DEEPSEEK_EXPENSIVE_WINDOW_LEAD_HOURS,
  Math.max(...DEEPSEEK_PEAK_HOUR_RANGES_UTC.map(([, end]) => end)),
]

/** Whether `at` falls in the window above. Half-open like the peak check, so
 *  the closing hour is already outside it. */
export function isDeepSeekExpensiveWindow(at: Date): boolean {
  if (isBeijingWeekend(at)) return false
  const [start, end] = DEEPSEEK_EXPENSIVE_WINDOW_UTC
  const hour = at.getUTCHours()
  return hour >= start && hour < end
}

/** When the window closes — what a user is really asking when a model is
 *  unavailable. Returns `at` unchanged outside the window so callers can render
 *  "back at ..." without a second branch. */
export function deepSeekExpensiveWindowEndsAt(at: Date): Date {
  if (!isDeepSeekExpensiveWindow(at)) return new Date(at)
  const [, end] = DEEPSEEK_EXPENSIVE_WINDOW_UTC
  const ends = new Date(at)
  // The window never crosses midnight (it starts at or after 00:00 UTC), so its
  // close is always later the same UTC day.
  ends.setUTCHours(end, 0, 0, 0)
  return ends
}

/**
 * The zone to quote when nothing else is known — including by a caller that
 * deliberately wants one fixed zone for every reader on earth.
 *
 * The server is exactly that caller. `Intl.DateTimeFormat` with `timeZone:
 * undefined` resolves to whatever the PROCESS runs in, which in
 * production is UTC and on a developer laptop is anything at all; a refusal
 * string built there must not depend on which. Passing this explicitly is what
 * makes the server's copy deterministic, and naming it in the output is what
 * makes it readable — see formatWindowTimeZoneLabel.
 */
export const FALLBACK_WINDOW_TIME_ZONE = 'UTC'

/**
 * The zone these formatters actually render in.
 *
 * An explicit `timeZone` wins. Otherwise the RUNTIME's zone, which is the
 * reader's own in a browser or a desktop process — the case every picker label
 * depends on — and only falls through to UTC where the runtime has no zone to
 * report at all.
 */
export function resolveWindowTimeZone(timeZone?: string): string {
  if (timeZone) return timeZone
  try {
    return (
      Intl.DateTimeFormat().resolvedOptions().timeZone ??
      FALLBACK_WINDOW_TIME_ZONE
    )
  } catch {
    return FALLBACK_WINDOW_TIME_ZONE
  }
}

/**
 * The zone abbreviation to print beside a time, e.g. "UTC", "PDT", "GMT+2".
 *
 * Every wall-clock time Freebuff prints about this window carries one. A bare
 * "10:00 AM" is not a time — it is a time in a zone the reader has to guess,
 * and they guess their own: a user in Germany read "again at 10:00 AM" (10:00
 * UTC, so noon for them) at 10:34 on their own clock and saw a moment that had
 * already passed.
 *
 * Including the labels built in-app, which are NOT automatically the reader's
 * clock either — a CLI on a remote box renders that box's zone to a human
 * sitting somewhere else. Four characters, and the question stops arising.
 */
export function formatWindowTimeZoneLabel(on: Date, timeZone?: string): string {
  const zone = resolveWindowTimeZone(timeZone)
  const named = new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    hour: 'numeric',
    timeZoneName: 'short',
  })
    .formatToParts(on)
    .find((part) => part.type === 'timeZoneName')?.value
  return named ?? zone
}

/** Hour-of-day formatter for a window edge. Deliberately WITHOUT the zone name:
 *  a range names its zone once at the end, not on both edges. */
function windowTimeFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  })
}

/** The window in the reader's timezone, e.g. "5:00 PM – 3:00 AM PDT". Local
 *  time is the point: a user told "00:00-10:00 UTC" has to do the arithmetic.
 *  The zone is named either way — see formatWindowTimeZoneLabel. */
export function formatDeepSeekExpensiveWindowLocal(
  on: Date = new Date(),
  timeZone?: string,
): string {
  const zone = resolveWindowTimeZone(timeZone)
  const fmt = windowTimeFormatter(zone)
  const atUtcHour = (hour: number): string => {
    const d = new Date(on)
    d.setUTCHours(hour, 0, 0, 0)
    return fmt.format(d)
  }
  const [start, end] = DEEPSEEK_EXPENSIVE_WINDOW_UTC
  return `${atUtcHour(start)} – ${atUtcHour(end)} ${formatWindowTimeZoneLabel(on, zone)}`
}

/**
 * What to tell a user whose model is shut for the peak window.
 *
 * Phrased as WHEN IT COMES BACK rather than as a range, because that is the
 * question being asked. A range makes the reader do arithmetic against a clock
 * they cannot see -- and the range this replaced was not even the right window:
 * `model_unavailable` hardcoded FREEBUFF_DEPLOYMENT_HOURS_LABEL ("9am ET-5pm PT
 * every day"), which describes OUR STAFFING hours for limited-offer models and
 * has nothing to do with DeepSeek's peak pricing. A model closed 5pm-3am
 * Pacific was telling people it was open 9am-5pm.
 *
 * Local time, and one timezone — NAMED. The old label mixed two ("9am ET-5pm
 * PT"), which cannot be read as an interval by anyone; the label that replaced
 * it named none at all, which is worse, because a reader cannot tell that they
 * are missing something. See formatWindowTimeZoneLabel.
 */
export function formatDeepSeekExpensiveWindowReturn(
  on: Date = new Date(),
  timeZone?: string,
): string {
  const ends = deepSeekExpensiveWindowEndsAt(on)
  const zone = resolveWindowTimeZone(timeZone)
  return `again at ${windowTimeFormatter(zone).format(ends)} ${formatWindowTimeZoneLabel(ends, zone)}`
}

/**
 * The OFF-PEAK window in the reader's timezone, e.g. "3:00 AM – 5:00 PM" — when
 * a peak-gated model is open.
 *
 * The complement of `formatDeepSeekExpensiveWindowLocal`, and the direction a
 * picker needs: a row says when you CAN use it, not when you cannot. Written as
 * end→start because the open window is exactly the closed one inverted.
 */
export function formatDeepSeekOffPeakWindowLocal(
  on: Date = new Date(),
  timeZone?: string,
): string {
  const zone = resolveWindowTimeZone(timeZone)
  const fmt = windowTimeFormatter(zone)
  const atUtcHour = (hour: number): string => {
    const d = new Date(on)
    d.setUTCHours(hour, 0, 0, 0)
    return fmt.format(d)
  }
  const [start, end] = DEEPSEEK_EXPENSIVE_WINDOW_UTC
  return `${atUtcHour(end)} – ${atUtcHour(start)} ${formatWindowTimeZoneLabel(on, zone)}`
}
