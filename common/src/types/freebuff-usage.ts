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
  /** Days in the current run. Survives today being unused until tomorrow.
   *  Counted on the account's own days (the daily allowance's interval), the
   *  same streak the CLI and Desktop show and the +15 is paid on; the
   *  activity map and `longest` stay on Pacific dates. */
  current: number
  /** Longest run in recorded history (never below `current`). */
  longest: number
  todayUsed: boolean
  lastUsageDate: string | null
  /**
   * When the current streak day ends, as an ISO instant: the account's daily
   * reset (its own midnight). Absent from older servers, and when the account
   * day could not be read (the streak above is then the Pacific one, ending
   * at the next midnight in `timeZone`).
   */
  nextResetAt?: string
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
}

/** One Pacific day's free-mode tokens (input + output). */
export interface FreebuffTokenDay {
  /** `YYYY-MM-DD`, a PACIFIC date (`freebuff_token_day`'s key). */
  date: string
  tokens: number
}

/**
 * Every free-mode token the account has used, from `freebuff_token_day`
 * (one row per Pacific day, kept for good) plus the days the nightly roll
 * has not reached yet, read live. See docs/freebuff-account-hub.md.
 */
export interface FreebuffLifetimeTokens {
  /** input + output over the account's whole recorded history. */
  totalTokens: number
  /** Cache-inclusive, as everywhere: cache reads are inside this. */
  inputTokens: number
  outputTokens: number
  /** What those tokens would have cost using Claude Code at API prices, in
   *  USD (`claudeCodeEquivalentUsd` in web), shown as the user's saving. */
  costUsd: number
  /** The day with the most tokens, ever; null before the first. */
  peakDay: FreebuffTokenDay | null
  /** The first Pacific day with tokens; null before the first. */
  firstDate: string | null
  /** Days with tokens inside the activity-map window, oldest first. Pacific
   *  dates; quiet days are absent. */
  days: FreebuffTokenDay[]
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
  /**
   * Lifetime tokens and per-day tokens for the map. Absent from a server
   * that predates it; null when the read failed or timed out (the UI says so
   * rather than showing a zero).
   */
  lifetime?: FreebuffLifetimeTokens | null
  /**
   * The account's own charges and returns, newest first, over a short window.
   * Optional: absent from a server that predates it, and an empty array from
   * one whose ledger read failed — the UI says so rather than showing nothing.
   */
  sessionCharges?: FreebuffSessionLedgerEntry[]
  /** How many days `sessionCharges` covers, so the UI can label it. */
  sessionChargesDays?: number
}

/**
 * One session's charge and what came back from it — the per-session line the
 * account hub lists so a user can see where their hours went without asking
 * support for it.
 *
 * Amounts are FREEBUCKS, as everywhere on the wire; the client converts to
 * hours for display. `charged` is positive; `returned` is positive too (the
 * ledger stores it as a negative amount) and is 0 when nothing came back.
 */
export interface FreebuffSessionLedgerEntry {
  /** The debit's ledger row id, so a client can key the row. */
  id: string
  /** When the session was charged, as an ISO instant. */
  occurredAt: string
  /** The model the session ran on; null on a legacy row that recorded none. */
  model: string | null
  /** Freebucks taken when the session started. */
  charged: number
  /** Of `charged`, the part drawn from the wallet rather than the day's pool. */
  chargedFromWallet: number
  /** Freebucks given back when the hour settled; 0 if nothing came back. */
  returned: number
  /** Of `returned`, the part credited back to the wallet. */
  returnedToWallet: number
  /** Why the return was written: a settled hour, or a session that never
   *  started (`failed_start_refund`). Absent while nothing has come back. */
  returnReason?: string
  /**
   * When the hour can still return something, as an ISO instant. Absent once
   * the hour is over: a row with no `returned` and no `settlesAt` used its
   * whole hour, which is correct rather than a missed refund.
   */
  settlesAt?: string
}
