import {
  XP_STREAK_MILESTONES,
  dailyStreakXp,
  xpAtTier,
} from '../constants/freebuff-xp'
import { addDaysToDateKey, getFreebuffUsageDateKey } from './freebuff-streak'

/** One recorded account day (`freebuff_streak_day`). */
export interface XpStreakAccountDay {
  startsAt: Date
  resetsAt: Date
  firstAt: Date
}

/**
 * The gap between two account days under which they are still consecutive:
 * the streak's own rule (`MIN_STREAK_BONUS_DAY_MS`,
 * `web/src/server/free-session/freebucks-streak-day.ts`). A real missed day
 * is at least 23 hours.
 */
const STREAK_GAP_MS = 20 * 60 * 60 * 1000

/**
 * Every day the account kept a streak, oldest first, as its place in that
 * streak (1 for a streak's first day). The same days and the same rule the
 * shown streak counts (`calculateAccountDayStreak`): account days, two of
 * them consecutive when the newer starts less than 20 hours after the older
 * resets; before the first account day (the 2026-10-01 switch), the Pacific
 * usage dates, which the first account day continues when the Pacific date
 * before its first message was used.
 */
export function streakDayPositions(params: {
  accountDays: readonly XpStreakAccountDay[]
  pacificUsageDates: readonly string[]
}): number[] {
  const days = [...params.accountDays].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
  )
  const switchDate = days[0] ? getFreebuffUsageDateKey(days[0].firstAt) : null
  const pacific = [...new Set(params.pacificUsageDates)]
    .filter((date) => switchDate === null || date < switchDate)
    .sort()

  const positions: number[] = []
  let position = 0
  let lastDate: string | null = null
  for (const date of pacific) {
    position =
      lastDate !== null && addDaysToDateKey(lastDate, 1) === date
        ? position + 1
        : 1
    positions.push(position)
    lastDate = date
  }
  let lastDay: XpStreakAccountDay | null = null
  for (const day of days) {
    const continues = lastDay
      ? day.startsAt.getTime() - lastDay.resetsAt.getTime() < STREAK_GAP_MS
      : lastDate !== null && addDaysToDateKey(lastDate, 1) === switchDate
    position = continues ? position + 1 : 1
    positions.push(position)
    lastDay = day
  }
  return positions
}

/**
 * The streak XP of a history (`streakDayPositions`): each day's daily XP,
 * plus each milestone the longest streak reached, once, each at `tier`.
 */
export function streakXp(
  positions: readonly number[],
  tier?: 'full' | 'limited' | null,
): number {
  let xp = 0
  let longest = 0
  for (const position of positions) {
    xp += xpAtTier(dailyStreakXp(position), tier)
    longest = Math.max(longest, position)
  }
  for (const milestone of XP_STREAK_MILESTONES)
    if (longest >= milestone.days) xp += xpAtTier(milestone.xp, tier)
  return xp
}
