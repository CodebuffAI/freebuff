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
  'streak-fire', 'gold-streak-fire', 'white-streak-fire', 'blue-streak-fire',
  'plasma-streak-fire', 'rainbow-streak-fire',
] as const

/**
 * The theme a 7-day streak unlocks, for good: the account reached the streak
 * once (a `freebuff_streak_reward` row exists). Neither a plan nor referrals
 * unlock it; it is earned by using Freebuff seven days in a row.
 */
export const STREAK_THEME_PRESET_ID = 'streak-fire'
/** The streak display experiment (docs/experiments.md, "Streaks"): its
 *  `streak` arm is shown the streak and offered Streak Fire. */
export const STREAK_EXPERIMENT_KEY = 'streak_display_2026_11'
/** The split of the display experiment's `control` arm (docs/experiments.md,
 *  "Streak UI"): its `classic` arm is shown the classic seven-day streak on
 *  web and Desktop and offered Streak Fire too. */
export const STREAK_UI_EXPERIMENT_KEY = 'streak_ui_2026_11'
/** The streak that unlocks it: the reward interval, whose grant is the unlock. */
export const STREAK_THEME_REQUIRED_DAYS = FREEBUFF_STREAK_REWARD_INTERVAL_DAYS

/**
 * The streak themes, in the order they unlock: a flame burning hotter (orange,
 * gold, white, blue), then past fire (plasma, a prism). Streak Fire is the
 * 7-day one above; each later one unlocks when the account's streak reaches
 * its `days` after they launched (2026-11-12), counting the streak already
 * running then, so 100 days in a row unlock them all at once and an older
 * streak unlocks nothing. All are kept for good (`freebuff_streak_theme_unlock`).
 */
export const STREAK_THEME_TIERS = [
  { id: STREAK_THEME_PRESET_ID, name: 'Streak Fire', days: STREAK_THEME_REQUIRED_DAYS },
  { id: 'gold-streak-fire', name: 'Gold Streak Fire', days: 14 },
  { id: 'white-streak-fire', name: 'White Streak Fire', days: 21 },
  { id: 'blue-streak-fire', name: 'Blue Streak Fire', days: 28 },
  { id: 'plasma-streak-fire', name: 'Plasma Streak Fire', days: 50 },
  { id: 'rainbow-streak-fire', name: 'Rainbow Streak Fire', days: 100 },
] as const
export type StreakThemeTier = (typeof STREAK_THEME_TIERS)[number]

/** The highest streak theme a streak of `days` has reached, or undefined
 *  below 7: the streak's own colours (`workspace-streak.css`). */
export function streakThemeTierForDays(days: number): StreakThemeTier | undefined {
  return [...STREAK_THEME_TIERS].reverse().find((tier) => days >= tier.days)
}

/** The streak theme `id` names, or undefined for any other preset. */
export function streakThemeTier(id: string): StreakThemeTier | undefined {
  return STREAK_THEME_TIERS.find((tier) => tier.id === id)
}

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
