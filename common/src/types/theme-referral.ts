export const THEME_REFERRAL_REQUIREMENT = 3 as const

/** Account entitlement, always calculated by the server from referred signups. */
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
}
