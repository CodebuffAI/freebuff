export const THEME_REFERRAL_REQUIREMENT = 3 as const

/** Account entitlement, calculated by the server from a subscription or referred signups. */
export interface ThemeReferralAccess {
  requiredReferrals: typeof THEME_REFERRAL_REQUIREMENT
  /** Progress is capped at the unlock threshold; no referred identities leave the server. */
  qualifyingReferrals: number
  unlocked: boolean
  referralCode: string | null
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
