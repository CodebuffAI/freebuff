/** Compatibility notices, not spend enforcement.
 * Completions uses the capacity/restricted notices for live request-rate limits.
 * The local Freebucks stub and legacy refusal mapping retain the older copy.
 */
export const FREEBUFF_CAPACITY_NOTICE =
  'Capacity is now limited per account — sustained automated abuse forced us to cap how much any one account can use.'

export const FREEBUFF_RESTRICTED_NOTICE =
  'This account has reduced capacity: it was flagged for VPN or proxy usage, a restricted location, or an email domain commonly used by bot farms. If you are on a VPN, connecting directly restores normal limits.'

export const FREEBUFF_FREEBUCKS_CEILING_NOTICE =
  'This account hit today’s hard usage cap. Freebucks pay for sessions, but the compute a day can draw is capped at three times what its Freebucks are worth, to protect the service from runaway usage.'

export const FREEBUFF_BUDGET_NOTICE =
  'You have used all of today’s free usage on this account.'

const FREEBUFF_RESTRICTED_NOTICE_REASONS: ReadonlySet<string> = new Set([
  'privacy_egress',
  'restricted_country',
  'flagged_email_domain',
  'unverified_egress',
])

const FREEBUFF_BUDGET_NOTICE_REASONS: ReadonlySet<string> = new Set([
  'region',
  'elevated_country',
  'trust_level',
])

export function freebuffSpendNoticeFor(reason: string): string {
  if (FREEBUFF_RESTRICTED_NOTICE_REASONS.has(reason)) {
    return FREEBUFF_RESTRICTED_NOTICE
  }
  if (FREEBUFF_BUDGET_NOTICE_REASONS.has(reason)) return FREEBUFF_BUDGET_NOTICE
  if (reason === 'freebucks_plan') return FREEBUFF_FREEBUCKS_CEILING_NOTICE
  return FREEBUFF_CAPACITY_NOTICE
}
