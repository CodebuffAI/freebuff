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
] as const

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
