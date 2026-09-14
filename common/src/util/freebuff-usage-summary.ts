import { FREEBUFF_USAGE_MAP_DAYS } from '../constants/freebuff-models'

import {
  addDaysToDateKey,
  calculateFreebuffStreak,
  FREEBUFF_STREAK_TIME_ZONE,
} from './freebuff-streak'

import type {
  FreebuffRecentUsage,
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
  windowDays?: number
  timeZone?: string
}): FreebuffUsageSummary {
  const safeWindowDays = params.windowDays !== undefined && Number.isFinite(params.windowDays) ? params.windowDays : FREEBUFF_USAGE_MAP_DAYS
  const windowDays = Math.max(1, safeWindowDays)
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
  }
}

/** One cell of the activity map: an active day, a quiet day, or padding. */
export type FreebuffUsageCell =
  | { date: string; active: boolean }
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
}): FreebuffUsageCell[] {
  const active = new Set(params.activeDates)
  const cells: FreebuffUsageCell[] = []

  // Pad to whole weeks so the last column ends on today's weekday and every row
  // is one weekday throughout the grid.
  const trailingPad = 6 - params.todayWeekday
  const start = addDaysToDateKey(params.todayDateKey, -(params.windowDays - 1))
  const leadingPad = (7 - ((params.windowDays + trailingPad) % 7)) % 7

  for (let index = 0; index < leadingPad; index++) cells.push(null)
  for (let index = 0; index < params.windowDays; index++) {
    const date = addDaysToDateKey(start, index)
    cells.push({ date, active: active.has(date) })
  }
  for (let index = 0; index < trailingPad; index++) cells.push(null)

  return cells
}
