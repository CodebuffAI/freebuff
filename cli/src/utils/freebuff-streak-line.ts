// The label/dots/perk-note logic is shared with Freebuff Desktop and lives in
// common; this module re-exports it and adds the terminal rendering and layout
// gating only the CLI needs.
export {
  FREEBUFF_STREAK_WEEK,
  getFreebuffStreakBonusNote,
} from '@codebuff/common/util/freebuff-streak-line'
export type { FreebuffStreakLine } from '@codebuff/common/util/freebuff-streak-line'

import {
  FREEBUFF_STREAK_WEEK,
  getFreebuffStreakBonusNote,
  getFreebuffStreakLine as getSharedFreebuffStreakLine,
} from '@codebuff/common/util/freebuff-streak-line'

import type { FreebuffStreakLine } from '@codebuff/common/util/freebuff-streak-line'

const FREEBUFF_STREAK_BONUS_MIN_HEIGHT = 30

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
