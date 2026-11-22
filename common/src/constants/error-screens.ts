import { FREEBUFF_DISCORD_INVITE_URL } from './freebuff-community'

/**
 * The full-page error screens a person can land on, by a stable id. Each one
 * reports `error_screen.shown` with its id when it is shown (the reliability
 * page counts them, docs/freebuff-reliability.md) and offers "Report the
 * issue" (the /report form, which carries the id) and "Join the Discord".
 * Add a screen here before wiring a new one.
 */
export const ERROR_SCREENS = {
  // Freebuff Web and Cloud (ship on deploy)
  'global-error': 'Something went wrong (the page crashed)',
  'global-updating': 'Updating (a stale build reloads)',
  'boundary-project': 'Project failed to load',
  'boundary-dashboard': 'This page failed to load',
  'boundary-login': 'Sign-in didn’t load',
  'boundary-marketing': 'This page didn’t load',
  'refresh-required': 'Refresh required (an old build)',
  'reload-needed': 'This page needs a reload (a translator rewrote it)',
  'project-unavailable': 'Project unavailable',
  'not-found': 'Page not found',
  'artifact-not-found': 'This link doesn’t open anything',
  'artifact-unavailable': 'This link can’t be opened right now',
  'signin-link-incomplete': 'This sign-in link is incomplete',
  'signin-link-expired': 'Sign-in link expired',
  maintenance: 'Back soon (maintenance)',
  'github-connect-failed': 'Couldn’t connect GitHub',
  // Freebuff Desktop's local shell (ships with a Desktop update)
  'desktop-launch': 'Couldn’t open Freebuff (Desktop)',
} as const

export type ErrorScreenId = keyof typeof ERROR_SCREENS

export const ERROR_SCREEN_EVENT = 'error_screen.shown'

export const isErrorScreenId = (v: unknown): v is ErrorScreenId =>
  typeof v === 'string' && Object.hasOwn(ERROR_SCREENS, v)

export const ERROR_SCREEN_DISCORD_URL = FREEBUFF_DISCORD_INVITE_URL

/** The report form for a screen: the id, and where it was seen. */
export function errorReportPath(
  screen: ErrorScreenId,
  from?: string | null,
): string {
  const q = new URLSearchParams({ screen })
  if (from) q.set('from', from.slice(0, 200))
  return `/report?${q.toString()}`
}
