import { FREEBUFF_STREAK_REWARDS_ENABLED } from '../constants/freebuff-models'
import {
  getFreebuffStreakGlmWeeklyUnits,
  isFreebuffStreakGlmBonusActive,
} from './freebuff-streak'
import { getZonedParts, getZonedYmd } from './zoned-time'

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

/** The perk a 7+ day streak pays, as copy: Freebucks on the meter (added to
 *  each day's allowance, gone at its reset), sessions off it. */
function getFreebuffStreakPerk(params: {
  streak: number
  accessTier: 'full' | 'limited'
  freebucksDailyBonus?: number | null
}): string {
  if (params.freebucksDailyBonus != null && params.freebucksDailyBonus > 0) {
    // Says WHERE it goes and WHEN it lands: into the daily allowance (never
    // the wallet, so it does not pile up), with the first message of a streak
    // day, not sign-in. WHICH day, and when it expires, is the status line's
    // job (`getFreebuffStreakBonusStatus`), in the reader's own clock — "every
    // Pacific day" named the zone but still left Asia and Europe expecting it
    // at their midnight (2026-09-27/28 "streak bonus not credited" reports).
    return `+${params.freebucksDailyBonus} to your daily allowance with each day's first message`
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
 * On the Freebucks meter none of that buys anything, and the streak adds
 * `freebucksDailyBonus` Freebucks to each streak day's allowance instead (both
 * tiers; it expires with the allowance, never reaching the wallet); the server
 * says which applies through the streak response, so the copy never promises
 * a currency the meter will not grant.
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

/**
 * When a streak day ends, as copy in the reader's clock: "midnight",
 * "3:00 PM", or "3:00 PM tomorrow" once that time of day has already passed
 * locally. `resetAt` is the server's `nextResetAt` (the next Pacific
 * midnight), always less than a day ahead, so a date is never needed.
 *
 * `timeZone` defaults to the runtime's own zone — the user's, on the CLI, the
 * Desktop orchestrator and a browser. A server must pass one.
 *
 * `labelReaderClock` marks a clock time as the reader's: "11:00 AM (your
 * time)". East of Pacific the streak day turns over at an odd hour, and a bare
 * "11:00 AM" had a Dubai reader asking whether it meant server time or their
 * PC's (2026-10-01). "midnight" is left bare: it is the reader's own.
 */
export function formatFreebuffStreakResetTime(params: {
  resetAt: Date
  now: Date
  timeZone?: string
  labelReaderClock?: boolean
}): string {
  const timeZone =
    params.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const { hour, minute } = getZonedParts(params.resetAt, timeZone)
  // Pacific readers (and anyone on its offset): the day ends tonight.
  if (hour === 0 && minute === 0) return 'midnight'
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  })
    .format(params.resetAt)
    // Newer ICU puts a narrow no-break space before AM/PM; a terminal may not
    // draw it, and it throws off width math that counts columns.
    .replace(/\s/g, ' ')
  const when =
    getZonedYmd(params.resetAt, timeZone) === getZonedYmd(params.now, timeZone)
      ? time
      : `${time} tomorrow`
  return params.labelReaderClock ? `${when} (your time)` : when
}

/**
 * Where today's Freebucks streak bonus stands, for a 7+ day streak on the
 * meter: added to today's allowance (and until when), already expired with
 * the allowance, still to come with a message, or next due after the streak
 * day's reset — every time in the reader's own clock. Null off the meter,
 * below the milestone, or without a server `nextResetAt` (an older server),
 * so a client never guesses the boundary.
 *
 * The rules it states are the award's (`awardFreebuffDailyStreakReward`): one
 * grant per Pacific day, made by the first free-mode message of that day,
 * which raises the daily allowance until the allowance's own reset
 * (`bonusExpiresAt`). Nothing here changes them.
 */
export function getFreebuffStreakBonusStatus(params: {
  streak: number
  todayUsed: boolean
  /** The streak response's `todayCredited`; null/undefined = unknown. */
  todayCredited?: boolean | null
  freebucksDailyBonus?: number | null
  nextResetAt?: string | null
  /** The streak response's `bonusExpiresAt`: when today's granted bonus
   *  leaves the allowance; null once it has. Undefined = not reported. */
  bonusExpiresAt?: string | null
  now?: Date
  /** Render zone; the runtime's own when omitted. */
  timeZone?: string
  /** Drop the "(your time)" label on the next streak day's clock time, for a
   *  surface too narrow for it (the CLI falls back to this before hiding the
   *  line). */
  compact?: boolean
}): string | null {
  if (!FREEBUFF_STREAK_REWARDS_ENABLED) return null
  const bonus = params.freebucksDailyBonus
  if (bonus == null || !(bonus > 0)) return null
  if (params.streak < FREEBUFF_STREAK_WEEK) return null
  if (!params.nextResetAt) return null
  const resetAt = new Date(params.nextResetAt)
  const now = params.now ?? new Date()
  // A payload held past its own reset describes a day that is already over.
  if (!Number.isFinite(resetAt.getTime()) || resetAt <= now) return null
  // East of Pacific the next streak day starts at an odd hour of the reader's
  // clock, which they misread as server time; label it. "midnight" (the
  // allowance's reset for a reader at home) stays bare.
  const when = formatFreebuffStreakResetTime({
    resetAt,
    now,
    timeZone: params.timeZone,
    labelReaderClock: !params.compact,
  })
  if (params.todayCredited === true) {
    // The bonus lives in the DAILY allowance and leaves with it at the
    // allowance's reset (local midnight in the account's reset zone), which is
    // not the streak day's Pacific reset. Say both, in the reader's clock.
    const expiresAt =
      typeof params.bonusExpiresAt === 'string'
        ? new Date(params.bonusExpiresAt)
        : null
    if (expiresAt && Number.isFinite(expiresAt.getTime()) && expiresAt > now) {
      const until = formatFreebuffStreakResetTime({
        resetAt: expiresAt,
        now,
        timeZone: params.timeZone,
        labelReaderClock: !params.compact,
      })
      // One reset for both (a Pacific reader): say it once.
      if (expiresAt.getTime() === resetAt.getTime()) {
        return `+${bonus} added to today's allowance until ${until} · next +${bonus} with your first message after that`
      }
      return `+${bonus} added to today's allowance until ${until} · next +${bonus} after ${when}`
    }
    // Granted, but the allowance it raised has since reset: east of Pacific,
    // between local midnight and the Pacific reset, the grant belongs to the
    // reader's YESTERDAY (2026-09-29 report, 17-day streak in India).
    if (params.bonusExpiresAt === null || expiresAt) {
      return `+${bonus} expired at your daily reset · next +${bonus} with your first message after ${when}`
    }
    return `+${bonus} credited · next +${bonus} with your first message after ${when}`
  }
  // Today already counted, so its first message has been sent: whatever
  // became of that credit, the next one belongs to the next day.
  if (params.todayUsed) {
    return `Next +${bonus} with your first message after ${when}`
  }
  return `Send a message before ${when} to earn +${bonus}`
}
