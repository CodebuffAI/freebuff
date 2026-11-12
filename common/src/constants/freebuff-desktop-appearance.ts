import { FREEBUFF_STREAK_REWARD_INTERVAL_DAYS } from './freebuff-models'

/**
 * Every appearance preset Freebuff Desktop ships, by id. Desktop reports which
 * one an install is running (never a custom theme's name) and the web API
 * counts them, so both sides validate against this one list.
 */
export const DESKTOP_APPEARANCE_PRESET_IDS = [
  'system', 'dark', 'light', 'shine',
  'alpine', 'dune', 'tide', 'blossom', 'orbit', 'after-rain', 'ember', 'kanagawa',
  'aurora', 'violet-hour', 'phosphor', 'mirage', 'nebula', 'frost', 'peach', 'midnight',
  'lilac', 'dusk', 'seafoam', 'graphite', 'daybreak', 'sherbet', 'paper', 'carbon',
  'streak-fire',
] as const

/**
 * The theme a 7-day streak unlocks, for good: the account reached the streak
 * once (a `freebuff_streak_reward` row exists). Neither a plan nor referrals
 * unlock it; it is earned by using Freebuff seven days in a row.
 */
export const STREAK_THEME_PRESET_ID = 'streak-fire'
/** The streak display experiment (docs/experiments.md, "Streaks"): only its
 *  `streak` arm is shown the streak and offered Streak Fire. */
export const STREAK_EXPERIMENT_KEY = 'streak_display_2026_11'
/** The streak that unlocks it: the reward interval, whose grant is the unlock. */
export const STREAK_THEME_REQUIRED_DAYS = FREEBUFF_STREAK_REWARD_INTERVAL_DAYS

/** What Desktop reports: a shipped preset, or `custom` for any saved custom theme. */
export const DESKTOP_APPEARANCE_REPORTABLE = [...DESKTOP_APPEARANCE_PRESET_IDS, 'custom'] as const
export type DesktopAppearanceLabel = (typeof DESKTOP_APPEARANCE_REPORTABLE)[number]

/** Every install starts on one of these, so a usage count on them says nothing. */
export const DESKTOP_DEFAULT_APPEARANCE_IDS: readonly string[] = ['system', 'dark', 'light']

/** An install counts toward its appearance while it has reported within this window. */
export const DESKTOP_APPEARANCE_ACTIVE_DAYS = 30

export function isDesktopAppearanceLabel(value: unknown): value is DesktopAppearanceLabel {
  return typeof value === 'string' && (DESKTOP_APPEARANCE_REPORTABLE as readonly string[]).includes(value)
}
