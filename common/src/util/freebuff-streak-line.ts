import { FREEBUFF_STREAK_REWARDS_ENABLED } from '../constants/freebuff-models'
import {
  getFreebuffStreakGlmWeeklyUnits,
  isFreebuffStreakGlmBonusActive,
} from './freebuff-streak'

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

/** The perk a 7+ day streak pays, as copy: Freebucks on the meter (every
 *  day, into the wallet), sessions off it. */
function getFreebuffStreakPerk(params: {
  streak: number
  accessTier: 'full' | 'limited'
  freebucksDailyBonus?: number | null
}): string {
  if (params.freebucksDailyBonus != null && params.freebucksDailyBonus > 0) {
    // Streak days are Pacific (`FREEBUFF_STREAK_TIME_ZONE`), while the daily
    // pool the user watches resets on THEIR clock. East of Pacific one local
    // day spans a Pacific midnight, so two credits can land the same local
    // day and read as a double pay; naming the clock is the whole fix.
    return `+${params.freebucksDailyBonus} Freebucks every Pacific day`
  }
  // Only advertise GLM when the recurring full-access streak entitlement is
  // active, so the copy never promises a perk the gate won't honor.
  const includesGlm =
    params.accessTier === 'full' && isFreebuffStreakGlmBonusActive()
  // Below the milestone this is the first tier being unlocked (1/day); at 7+
  // it's whatever tier the current streak has earned (up to 4/day).
  const glmDaily = Math.max(1, getFreebuffStreakGlmWeeklyUnits(params.streak))
  return includesGlm
    ? `+1 bonus session every day + ${glmDaily} reward ${glmDaily === 1 ? 'session' : 'sessions'} each day`
    : '+1 bonus session every day'
}

/**
 * A short perk note for an active streak. Below the 7-day milestone it teases
 * the countdown ("N more days to unlock …") so the reward motivates the users
 * who haven't earned it yet; at 7+ it flips to describing the perk they're now
 * receiving. Returns null with no streak at all (the streak row is hidden then
 * too — a lapsed user needs a first day, not a countdown from seven).
 *
 * The daily-pool bonus (+1 session) recurs **every day** the streak stays at 7+,
 * so it's framed as "every day". The reward bonus refills with the reward pool —
 * daily since 2026-07-29 (weekly before) — while the streak remains active and
 * grows with the streak (one session per completed 7 days, max 4), so the
 * earned line shows the current tier's count. The exact remaining GLM count
 * lives in the referral banner; this line is the motivational why. GLM is
 * full-access only, so limited users get the daily session bonus alone.
 *
 * On the Freebucks meter none of that buys anything, and the streak pays
 * `freebucksDailyBonus` Freebucks a day instead (both tiers); the server says
 * which applies through the streak response, so the copy never promises a
 * currency the ledger will not credit.
 */
export function getFreebuffStreakBonusNote(params: {
  streak: number
  accessTier: 'full' | 'limited'
  /** Freebucks a streak day pays on this account (the streak response's
   *  `freebucksDailyBonus`). A positive number means the account is on the
   *  meter and the perk is Freebucks; null/undefined keeps the session copy. */
  freebucksDailyBonus?: number | null
}): string | null {
  if (!FREEBUFF_STREAK_REWARDS_ENABLED) return null
  if (params.streak <= 0) return null
  const perk = getFreebuffStreakPerk(params)

  if (params.streak < FREEBUFF_STREAK_WEEK) {
    const remaining = FREEBUFF_STREAK_WEEK - params.streak
    return `🎁 ${remaining} more ${remaining === 1 ? 'day' : 'days'} to unlock ${perk}`
  }
  return `🎁 Streak perk: ${perk}`
}
