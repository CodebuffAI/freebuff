import { FREEBUFF_USAGE_MAP_DAYS } from '../constants/freebuff-models'

import {
  addDaysToDateKey,
  calculateFreebuffStreak,
  FREEBUFF_STREAK_TIME_ZONE,
} from './freebuff-streak'

import type {
  FreebuffLifetimeTokens,
  FreebuffRecentUsage,
  FreebuffTokenDay,
  FreebuffSessionLedgerEntry,
  FreebuffUsageSessionsByModel,
  FreebuffUsageSummary,
} from '../types/freebuff-usage'

/**
 * The longest run of consecutive active days in `dateKeys`.
 *
 * Unlike the current streak this has no grace day: a gap ends the run outright.
 * The current streak treats "used yesterday, not yet today" as alive because
 * the day is not over; a historical run has no such ambiguity.
 */
export function calculateLongestFreebuffStreak(
  dateKeys: readonly string[],
): number {
  const sorted = [...new Set(dateKeys)].sort()
  let longest = 0
  let run = 0
  let previous: string | null = null

  for (const dateKey of sorted) {
    run =
      previous !== null && addDaysToDateKey(previous, 1) === dateKey ? run + 1 : 1
    previous = dateKey
    if (run > longest) longest = run
  }

  return longest
}

/**
 * Assemble the account hub's summary from the account's active dates.
 *
 * Pure, so the CLI, Desktop and web all describe usage identically and the
 * arithmetic is testable without a database. `activeDates` may arrive in any
 * order and may include days after `todayDateKey` (a client whose clock has run
 * ahead of the Pacific date key); both are normalised here.
 */
export function buildFreebuffUsageSummary(params: {
  activeDates: readonly string[]
  todayDateKey: string
  recent?: FreebuffRecentUsage | null
  sessionsByModel?: readonly FreebuffUsageSessionsByModel[]
  /** Newest first; omitted entirely when the ledger was not read. */
  sessionCharges?: readonly FreebuffSessionLedgerEntry[]
  sessionChargesDays?: number
  windowDays?: number
  timeZone?: string
}): FreebuffUsageSummary {
  const windowDays = Math.max(1, params.windowDays ?? FREEBUFF_USAGE_MAP_DAYS)
  const todayDateKey = params.todayDateKey

  const allDates = [...new Set(params.activeDates)]
    .filter((date) => date <= todayDateKey)
    .sort()

  const windowStart = addDaysToDateKey(todayDateKey, -(windowDays - 1))
  const { streak, todayUsed, lastUsageDate } = calculateFreebuffStreak({
    usageDates: allDates,
    todayDateKey,
  })

  return {
    timeZone: params.timeZone ?? FREEBUFF_STREAK_TIME_ZONE,
    todayDateKey,
    streak: {
      current: streak,
      longest: calculateLongestFreebuffStreak(allDates),
      todayUsed,
      lastUsageDate,
    },
    activeDates: allDates.filter((date) => date >= windowStart),
    windowDays,
    allTimeActiveDays: allDates.length,
    recent: params.recent ?? null,
    sessionsByModel: [...(params.sessionsByModel ?? [])],
    // Omitted rather than empty when the caller passed nothing: an absent
    // field means "this server does not report charges", an empty array means
    // "it does, and there are none".
    ...(params.sessionCharges
      ? {
          sessionCharges: [...params.sessionCharges],
          ...(params.sessionChargesDays
            ? { sessionChargesDays: params.sessionChargesDays }
            : {}),
        }
      : {}),
  }
}

/** One Pacific day's tokens as a store or a live read returns them. */
export interface FreebuffTokenDayTotals {
  date: string
  inputTokens: number
  outputTokens: number
  /** Provider cost in USD; absent counts as 0. */
  costUsd?: number
}

/**
 * Merge the stored token days with the days read live into the lifetime
 * figures.
 *
 * `liveFrom` is the first Pacific date the live read covers (it reads from
 * that date's midnight to now). A stored row on or after it is IGNORED, never
 * added: the nightly roll and the live read must not both count a day. Rows
 * may repeat a date (a live day split across sources); they are summed.
 */
export function summarizeFreebuffLifetimeTokens(params: {
  stored: readonly FreebuffTokenDayTotals[]
  live: readonly FreebuffTokenDayTotals[]
  liveFrom: string
  /** Pacific today; `days` keeps the map window ending here (plus one day
   *  of slack: the map's own today can be a day ahead of Pacific). */
  todayDateKey: string
  windowDays?: number
}): FreebuffLifetimeTokens {
  const byDate = new Map<string, { input: number; output: number; cost: number }>()
  const add = (row: FreebuffTokenDayTotals) => {
    const day = byDate.get(row.date) ?? { input: 0, output: 0, cost: 0 }
    day.input += row.inputTokens
    day.output += row.outputTokens
    day.cost += row.costUsd ?? 0
    byDate.set(row.date, day)
  }
  for (const row of params.stored) if (row.date < params.liveFrom) add(row)
  for (const row of params.live) if (row.date >= params.liveFrom) add(row)

  let inputTokens = 0
  let outputTokens = 0
  let costUsd = 0
  let peakDay: FreebuffTokenDay | null = null
  let firstDate: string | null = null
  const windowDays = Math.max(1, params.windowDays ?? FREEBUFF_USAGE_MAP_DAYS)
  const windowStart = addDaysToDateKey(params.todayDateKey, -windowDays)
  const days: FreebuffTokenDay[] = []
  for (const date of [...byDate.keys()].sort()) {
    const { input, output, cost } = byDate.get(date)!
    const tokens = input + output
    if (tokens <= 0) continue
    inputTokens += input
    outputTokens += output
    costUsd += cost
    firstDate ??= date
    // The earliest of equal peaks: the record was set then.
    if (!peakDay || tokens > peakDay.tokens) peakDay = { date, tokens }
    if (date >= windowStart) days.push({ date, tokens })
  }
  return {
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    costUsd,
    peakDay,
    firstDate,
    days,
  }
}

/** A cell's shade: 0 is a quiet day, 1-4 rise with the day's tokens. */
export type FreebuffUsageLevel = 0 | 1 | 2 | 3 | 4

/**
 * Shades by the account's OWN quartiles over the days it used, like a
 * contribution graph: a light user's busiest day is as dark as a heavy
 * user's, because the map is about their own rhythm, not a leaderboard.
 */
export function freebuffTokenLevel(
  tokens: number,
  quartiles: readonly [number, number, number] | null,
): FreebuffUsageLevel {
  if (tokens <= 0) return 0
  if (!quartiles) return 4
  if (tokens <= quartiles[0]) return 1
  if (tokens <= quartiles[1]) return 2
  if (tokens <= quartiles[2]) return 3
  return 4
}

/** The 25th, 50th and 75th percentiles of the positive values; null when
 *  there are none. Nearest-rank, so every threshold is a real day's total. */
export function freebuffTokenQuartiles(
  values: Iterable<number>,
): [number, number, number] | null {
  const sorted = [...values].filter((value) => value > 0).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const at = (p: number) => sorted[Math.floor(p * (sorted.length - 1))]!
  return [at(0.25), at(0.5), at(0.75)]
}

/** One cell of the activity map: an active day, a quiet day, or padding.
 *  `tokens` is present when the summary carried token days. */
export type FreebuffUsageCell =
  | {
      date: string
      active: boolean
      level: FreebuffUsageLevel
      tokens?: number
    }
  | null

/**
 * Expand the active dates into the fixed grid the activity map draws: every day
 * in the window, quiet days included, oldest first.
 *
 * The grid is laid out in columns of seven, so the first column is padded with
 * `null` for the days before the window began and the last for the days after
 * today. Callers render `null` as empty space, not as a quiet day — those days
 * either predate the window or have not happened yet.
 */
export function buildFreebuffUsageGrid(params: {
  activeDates: readonly string[]
  todayDateKey: string
  windowDays: number
  /** 0 = Sunday. The weekday `todayDateKey` falls on, resolved by the caller
   *  in the streak time zone rather than from the viewer's clock. */
  todayWeekday: number
  /**
   * Tokens per Pacific date. Shades ACTIVE days only, by the account's own
   * quartiles over the window: tokens never mark a day active the presence
   * map does not (the map is drawn on account days, the tokens on Pacific
   * ones, so for an account far from Pacific time a day's shade comes from
   * the overlapping Pacific day). An active day with no tokens recorded is
   * the lightest shade. Absent, every active day is the darkest, as before.
   */
  tokenDays?: readonly FreebuffTokenDay[]
}): FreebuffUsageCell[] {
  const active = new Set(params.activeDates)
  const tokens = params.tokenDays
    ? new Map(params.tokenDays.map((day) => [day.date, day.tokens]))
    : null
  const cells: FreebuffUsageCell[] = []

  // Pad to whole weeks so the last column ends on today's weekday and every row
  // is one weekday throughout the grid.
  const trailingPad = 6 - params.todayWeekday
  const start = addDaysToDateKey(params.todayDateKey, -(params.windowDays - 1))
  const leadingPad = (7 - ((params.windowDays + trailingPad) % 7)) % 7

  for (let index = 0; index < leadingPad; index++) cells.push(null)
  const dates = Array.from({ length: params.windowDays }, (_, index) =>
    addDaysToDateKey(start, index),
  )
  const quartiles = tokens
    ? freebuffTokenQuartiles(
        dates.filter((date) => active.has(date)).map((date) => tokens.get(date) ?? 0),
      )
    : null
  for (const date of dates) {
    const isActive = active.has(date)
    if (!tokens) {
      cells.push({ date, active: isActive, level: isActive ? 4 : 0 })
      continue
    }
    const dayTokens = isActive ? (tokens.get(date) ?? 0) : 0
    cells.push({
      date,
      active: isActive,
      level: isActive
        ? (Math.max(1, freebuffTokenLevel(dayTokens, quartiles)) as FreebuffUsageLevel)
        : 0,
      tokens: dayTokens,
    })
  }
  for (let index = 0; index < trailingPad; index++) cells.push(null)

  return cells
}
