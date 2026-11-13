/** Referred friends it takes to unlock themes, at limited access or when the tier is unknown. */
export const THEME_REFERRAL_REQUIREMENT = 3 as const
/**
 * The same at full access: one friend. Full-access accounts get a lower bar
 * on every referral reward (docs/freebuff-referral-rewards.md).
 */
export const THEME_REFERRAL_REQUIREMENT_FULL_ACCESS = 1 as const

/** The unlock threshold for an account's access tier; unknown reads as limited. */
export function themeReferralRequirement(
  accessTier: 'full' | 'limited' | null | undefined,
): number {
  return accessTier === 'full'
    ? THEME_REFERRAL_REQUIREMENT_FULL_ACCESS
    : THEME_REFERRAL_REQUIREMENT
}

/** Account entitlement, calculated by the server from a subscription or referred signups. */
export interface ThemeReferralAccess {
  /** 1 at full access, 3 otherwise (`themeReferralRequirement`). */
  requiredReferrals: number
  /** Progress is capped at the unlock threshold; no referred identities leave the server. */
  qualifyingReferrals: number
  unlocked: boolean
  /** The account once reached a 7-day streak, which unlocks the Streak Fire
   *  theme (`STREAK_THEME_PRESET_ID`) on its own: `unlocked` does not include
   *  it, and it does not unlock the rest. Absent from servers before
   *  2026-11-11, read as false. */
  streakThemeUnlocked?: boolean
  /** The longest streak, in days, the account has reached since the later
   *  streak themes launched (or its current one), which unlocks them for
   *  good (`STREAK_THEME_TIERS`). 0 for an account not offered them or
   *  without Streak Fire. Absent from older servers, read as 0. */
  streakThemeDays?: number
  /** The account is shown the streak (`streak_classic_2026_11`'s `classic`
   *  arm, or `streak_display_2026_11`'s `streak` arm before it), so clients
   *  show its Streak reward section: the streak themes earned and the next one
   *  to earn. Everyone else never sees it. Absent from older servers, read as
   *  false. */
  streakThemeOffered?: boolean
  referralCode: string | null
  /** When the account was created (ISO), for the browser workspace's first-visit
   *  welcome. Absent from servers before 2026-11-07. */
  accountCreatedAt?: string | null
}

export interface ThemeReferralPromptResponse {
  show: boolean
  access: ThemeReferralAccess
  /**
   * The account's timing-experiment arm, or null when it is not in the
   * experiment (or the server predates it). A deferred arm answers
   * `show: false` at the first send and is claimed later with its stage.
   */
  arm?: string | null
}

/** What the first-prompt invitation reports: `shown` once per mount, then each copy or dismissal. */
export type ThemeReferralPromptAction =
  | 'shown'
  | 'copied'
  | 'copy_failed'
  | 'dismissed'

/**
 * What every invite placement reports on `freebuff.theme_referral_prompt`:
 * the card's actions, plus `opened` for a placement that opens on a click and
 * the email invite's answer.
 */
export type ReferralInviteAction =
  | ThemeReferralPromptAction
  | 'opened'
  | 'invite_sent'
  | 'invite_failed'
