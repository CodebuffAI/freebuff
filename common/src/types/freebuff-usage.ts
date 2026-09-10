/**
 * Wire types for the account hub's usage summary — the cross-surface view of
 * one account's activity, shared by the web hub, the CLI and Desktop.
 *
 * Two sources, both read on demand and nothing written ahead of time:
 * `freebuff_daily_usage` (one narrow row per active Pacific day, which already
 * exists for the streak) and a short bounded aggregate over `message`. See
 * docs/freebuff-account-hub.md.
 */

export interface FreebuffUsageStreakSummary {
  /** Days in the current run. Survives today being unused until tomorrow. */
  current: number
  /** Longest run in recorded history. */
  longest: number
  todayUsed: boolean
  lastUsageDate: string | null
}

/**
 * Token and message totals over a short recent window.
 *
 * Deliberately not all-time: the cost of aggregating `message` scales with how
 * much the account sent rather than with the calendar, so a long lookback is
 * the one shape that cannot ship. Null when the aggregate exceeded its
 * statement timeout — the UI says so rather than showing a zero.
 */
export interface FreebuffRecentUsage {
  /** Lookback in days, so the UI can label the figures honestly. */
  days: number
  messages: number
  /** Provider-reported prompt tokens, cache-INCLUSIVE: `cacheReadTokens` is a
   *  subset of this, not an addition to it. */
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  /** input + output. Never add `cacheReadTokens` on top — it is already inside
   *  `inputTokens`, and re-adding it inflates the total ~1.8x at agentic cache
   *  hit rates. */
  totalTokens: number
  /**
   * Model spend over the same window: what these requests cost at list price,
   * USD, rounded to cents. An estimate the user can quote, never a bill.
   * ABSENT when the operator has closed the dollar figure to this account
   * (`FREEBUFF_MODEL_SPEND_AUDIENCE`), so a client that finds it missing simply
   * has no card to draw — no audience logic lives client-side.
   */
  modelSpendUsd?: number
}

export interface FreebuffUsageSessionsByModel {
  model: string
  sessions: number
  units: number
}

export interface FreebuffUsageSummary {
  timeZone: string
  /** `YYYY-MM-DD` for "today" in `timeZone`, so a client in another zone lines
   *  the activity map up with the server rather than with its own midnight. */
  todayDateKey: string
  streak: FreebuffUsageStreakSummary
  /**
   * Days the account was active inside the activity-map window, oldest first.
   * Quiet days are absent rather than listed — the renderer fills the calendar.
   */
  activeDates: string[]
  /** How many days the map window covers, ending on `todayDateKey`. */
  windowDays: number
  /** Active days over the account's whole history, not just the window. */
  allTimeActiveDays: number
  /** Null when the aggregate timed out; absent figures beat wrong ones. */
  recent: FreebuffRecentUsage | null
  /** Sessions admitted per model over the last 30 days, busiest first. */
  sessionsByModel: FreebuffUsageSessionsByModel[]
}
