/**
 * UTC day-string helpers shared by the rollup jobs and the dashboards that
 * read them.
 *
 * These used to be copied into each consumer (the
 * ad-revenue rollup and its dashboard, scripts/rollup-freebuff-spend.ts and
 * freebuff/web/src/lib/admin-spend.ts each carried a `shiftUtcDay`). The
 * window-boundary math is the sensitive part — a half-open `[start, end)` bound
 * or a trailing-window off-by-one silently drops or double-counts a day — so it
 * now lives here, in one place, instead of four copies that could drift.
 *
 * All helpers are pure string/Date math and return YYYY-MM-DD or ISO strings.
 */

/** Shift a YYYY-MM-DD UTC day string by whole days. */
export function shiftUtcDay(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

/** Today's UTC date string (YYYY-MM-DD). */
export function todayUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

/**
 * Half-open [start, end) ISO timestamps for one complete UTC day.
 *
 * The end is `shiftUtcDay(day, 1)` at midnight — never `day + 'T23:59:59.999Z'`
 * — because Postgres timestamps carry microseconds, and an inclusive
 * millisecond bound would drop rows in the last sub-millisecond of the day.
 */
export function dayWindowBounds(day: string): { start: string; end: string } {
  return {
    start: `${day}T00:00:00.000Z`,
    end: `${shiftUtcDay(day, 1)}T00:00:00.000Z`,
  }
}

/**
 * The `count` complete UTC days ending the day before `today`, oldest first.
 * This is the trailing re-roll window the rollup scripts use: `count` days
 * ending at yesterday, so today (still accumulating) is never included.
 */
export function trailingUtcDays(today: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    shiftUtcDay(today, -(count - i)),
  )
}
