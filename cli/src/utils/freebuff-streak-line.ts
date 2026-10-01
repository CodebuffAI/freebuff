// The label/dots/perk-note logic is shared with Freebuff Desktop and lives in
// common; this module re-exports it and adds the terminal rendering and layout
// gating only the CLI needs.
export {
  FREEBUFF_STREAK_WEEK,
  getFreebuffStreakBonusNote,
  getFreebuffStreakBonusStatus,
} from '@codebuff/common/util/freebuff-streak-line'
export type { FreebuffStreakLine } from '@codebuff/common/util/freebuff-streak-line'

import {
  FREEBUFF_STREAK_WEEK,
  getFreebuffStreakBonusNote,
  getFreebuffStreakBonusStatus,
  getFreebuffStreakLine as getSharedFreebuffStreakLine,
} from '@codebuff/common/util/freebuff-streak-line'

import type { FreebuffStreakResponse } from '@codebuff/common/types/freebuff-streak'

import type { FreebuffStreakLine } from '@codebuff/common/util/freebuff-streak-line'

const FREEBUFF_STREAK_BONUS_MIN_HEIGHT = 30

/** Columns between the count label and its progress dots. */
export const FREEBUFF_STREAK_LABEL_GAP = 2

/** Columns kept clear between the heading and the streak when they share a
 *  row. The heading row is laid out space-between inside a shrink-to-fit
 *  column, so when the row is the widest child there is no free space to
 *  distribute and the two would otherwise render flush against each other
 *  ("Start coding for free18 day streak"). This is the floor, and the same
 *  number decides whether they may share a row at all. */
export const FREEBUFF_STREAK_INLINE_GAP = 3

/** Progress glyphs for a terminal — the same ●/○ pair the shared module and
 *  the desktop app use. Bullet and middle dot were tried here because U+25CF
 *  is missing from a few terminal fonts and lands as a tofu box, but • and ·
 *  differ only in size: at a glance a partial week and a full one look alike,
 *  which is the whole point of the row. Filled-vs-hollow reads instantly, and
 *  the CLI already bets on ●/○ for its agent status indicators, so a font that
 *  can't draw them is already visibly broken elsewhere.
 *
 *  If a font ever fails these, █/░ (Block Elements) is the fallback pair: the
 *  ASCII logo and the progress bar are built from them, so anything that
 *  renders the CLI at all renders those. */
const TERMINAL_DOT_CHARS = { filled: '●', empty: '○' }

/** The streak line as the CLI draws it. */
export function getFreebuffStreakLine(
  streak: number,
): FreebuffStreakLine | null {
  return getSharedFreebuffStreakLine(streak, TERMINAL_DOT_CHARS)
}

/** Rendered width of the streak, e.g. "18 day streak  ●●●●●●●+". */
export function getFreebuffStreakInlineWidth(line: FreebuffStreakLine): number {
  return line.label.length + FREEBUFF_STREAK_LABEL_GAP + line.dots.length
}

/** What a user with no streak yet is about to earn. The empty slot is measured
 *  against it so the row doesn't move on day one. */
const DAY_ONE_LINE = getFreebuffStreakLine(1)!

/** Whether the heading and the streak can share a row with the inline gap left
 *  clear between them. A streak long enough to widen its own label (or a
 *  narrow terminal) pushes the streak onto its own line instead of letting the
 *  two collide. */
export function fitsFreebuffStreakOnHeadingRow(params: {
  /** null when the user has no streak yet — measured as day one. */
  line: FreebuffStreakLine | null
  headingWidth: number
  availableWidth: number
}): boolean {
  return (
    params.headingWidth +
      FREEBUFF_STREAK_INLINE_GAP +
      getFreebuffStreakInlineWidth(params.line ?? DAY_ONE_LINE) <=
    params.availableWidth
  )
}

/** Returns the earned perk note only when the landing layout can show it
 * without crowding the picker or wrapping onto additional rows. */
export function getFreebuffStreakBonusNoteForLayout(params: {
  streak: number
  accessTier: 'full' | 'limited'
  /** From the streak response: Freebucks a streak day pays on the meter, or
   *  null/undefined (an older server) for the session copy. */
  freebucksDailyBonus?: number | null
  terminalHeight: number
  availableWidth: number
}): string | null {
  if (params.streak < FREEBUFF_STREAK_WEEK) return null
  if (params.terminalHeight < FREEBUFF_STREAK_BONUS_MIN_HEIGHT) return null

  const note = getFreebuffStreakBonusNote(params)
  if (!note || note.length > params.availableWidth) return null

  return note
}

/**
 * The line under the earned perk note: whether today's Freebucks bonus has
 * landed and when the next streak day starts, in the terminal's local time.
 * Drawn only beneath a note that is itself on screen (pass that note), and
 * only when it fits one row, like the note.
 */
export function getFreebuffStreakBonusStatusForLayout(params: {
  /** The note this line sits under; null hides the status too. */
  note: string | null
  streak: FreebuffStreakResponse | undefined
  availableWidth: number
  now?: Date
  timeZone?: string
}): string | null {
  if (!params.note || !params.streak) return null
  const streak = params.streak
  const statusFor = (compact: boolean) =>
    getFreebuffStreakBonusStatus({
      streak: streak.streak,
      todayUsed: streak.todayUsed,
      todayCredited: streak.todayCredited,
      freebucksDailyBonus: streak.freebucksDailyBonus,
      nextResetAt: streak.nextResetAt,
      bonusExpiresAt: streak.bonusExpiresAt,
      now: params.now,
      timeZone: params.timeZone,
      compact,
    })
  // Prefer the line that labels its clock times "(your time)"; a narrow
  // terminal keeps the unlabelled one rather than losing the line.
  for (const compact of [false, true]) {
    const status = statusFor(compact)
    if (!status) return null
    if (status.length <= params.availableWidth) return status
  }
  return null
}
