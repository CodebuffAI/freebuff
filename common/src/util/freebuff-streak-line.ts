import { FREEBUFF_STREAK_REWARDS_ENABLED } from '../constants/freebuff-models'

/** Days in a streak "week" — the milestone the progress dots fill toward. */
export const FREEBUFF_STREAK_WEEK = 7

export interface FreebuffStreakLine {
  /** Count label, e.g. "2 day streak". */
  label: string
  /** A week's worth of progress dots toward the 7-day milestone, e.g.
   *  "●●○○○○○". Fills to "●●●●●●●" at 7, then gains a trailing "+"
   *  ("●●●●●●●+") for any streak beyond the week so long runs read as
   *  "earned and still going" rather than just maxed out. */
  dots: string
  /** The same progress as counts, for a surface that draws its own dots rather
   *  than glyphs (the desktop app draws CSS circles). `total` is always
   *  FREEBUFF_STREAK_WEEK, carried so a renderer that can't import this module
   *  knows how many slots to draw; `beyond` is the trailing "+". */
  progress: { filled: number; total: number; beyond: boolean }
}

/** One slot of the week a graphical surface draws: a streak day, today's
 *  (still unsent) or ahead. */
export type FreebuffStreakSlot = 'done' | 'today' | 'empty'

/**
 * The week toward the 7-day milestone as slots, for the workspace's streak
 * card and popup (the phone apps mirror it): one per streak day, filling to
 * seven and staying full past it as the dots do. While today is still
 * unsent, the next slot is today's.
 */
export function getFreebuffStreakWeekSlots(
  streak: number,
  todayUsed: boolean,
): FreebuffStreakSlot[] {
  const filled = Math.min(Math.max(streak, 0), FREEBUFF_STREAK_WEEK)
  return Array.from({ length: FREEBUFF_STREAK_WEEK }, (_, index) =>
    index < filled ? 'done' : index === filled && !todayUsed ? 'today' : 'empty',
  )
}

/** Glyph pair used to draw the progress dots. */
export interface FreebuffStreakDotChars {
  filled: string
  empty: string
}

/**
 * Pure presentation logic for the streak line shown on the CLI landing screen
 * and the desktop account popover: a plain count plus a week of filled/empty
 * progress dots. Returns null for streak <= 0 so the caller hides the row
 * entirely — new / lapsed users should be nudged to start using the product,
 * not shown an empty streak.
 *
 * The glyphs default to ●/○, which is what a real UI font renders best; a
 * surface whose font can't be trusted with those passes its own pair.
 */
export function getFreebuffStreakLine(
  streak: number,
  chars: FreebuffStreakDotChars = { filled: '●', empty: '○' },
): FreebuffStreakLine | null {
  if (streak <= 0) return null

  // Fill toward the 7-day milestone, then stay full — a 19-day streak should
  // read as fully earned, not roll back over into a partial second week. Past
  // the week, a trailing "+" marks that the streak has run beyond the row.
  const filled = Math.min(streak, FREEBUFF_STREAK_WEEK)
  const beyond = streak > FREEBUFF_STREAK_WEEK
  const dots =
    chars.filled.repeat(filled) +
    chars.empty.repeat(FREEBUFF_STREAK_WEEK - filled) +
    (beyond ? '+' : '')

  // "day" stays singular — it's a compound modifier ("7 day streak"), not a
  // count of days on its own.
  return {
    label: `${streak} day streak`,
    dots,
    progress: { filled, total: FREEBUFF_STREAK_WEEK, beyond },
  }
}

/**
 * The streak's perk note: every streak day earns XP on the Rewards page
 * (docs/freebuff-xp.md). Null with no streak at all (the streak row is hidden
 * then too). Until 2026-11-24 a 7+ day streak added Freebucks or a session to
 * each day's allowance; that bonus is retired, so the server no longer sends
 * `freebucksDailyBonus` and the note no longer reads it.
 */
export function getFreebuffStreakBonusNote(params: {
  streak: number
}): string | null {
  if (!FREEBUFF_STREAK_REWARDS_ENABLED) return null
  if (params.streak <= 0) return null
  return '🎁 Every streak day earns XP toward rewards'
}
