/**
 * How XP is earned (the Rewards page's XP system). One definition for the page
 * (`freebuff/web/src/lib/xp-rewards.ts`) and the server that counts it
 * (`packages/auth/src/xp.ts`).
 */

/** A friend you invited who counts (`countingReferralFriendsSql`). */
export const XP_PER_FRIEND = 1_000

/** Signing up through a friend's invite, once. */
export const XP_INVITED_BONUS = 1_000

/** The XP that unlocks custom themes, like a friend or a subscription does. */
export const XP_THEMES_UNLOCK = 1_000

/** One-time XP, each awarded once per account. */
export const XP_ONE_TIME = {
  discord: 500,
  site: 500,
  github: 250,
} as const
export type XpOneTimeKey = keyof typeof XP_ONE_TIME

/**
 * The XP one day of a streak earns, for the `streakDay`th day (1-based):
 * 5 a day in week 1, 5 more each week after, 25 a day from week 5 on.
 * A broken streak starts again at day 1.
 */
export function dailyStreakXp(streakDay: number): number {
  if (streakDay < 1) return 0
  const week = Math.ceil(streakDay / 7)
  return Math.min(week * 5, 25)
}

/**
 * Limited access earns a tenth of every XP amount here, rounded up to a
 * whole XP (a first-week streak day is 1); each level needs the same XP at
 * either tier. Applied to each amount as it is earned, never to a sum, and at
 * the tier of the request that reads it.
 */
export function xpAtTier(
  xp: number,
  tier: 'full' | 'limited' | null | undefined,
): number {
  return tier === 'limited' ? Math.ceil(xp / 10) : xp
}

/** One-time XP for reaching a streak of `days`. */
export const XP_STREAK_MILESTONES = [
  { days: 7, xp: 250 },
  { days: 30, xp: 1_000 },
  { days: 100, xp: 3_000 },
  { days: 365, xp: 10_000 },
] as const

export type XpStreakMilestone = (typeof XP_STREAK_MILESTONES)[number]
