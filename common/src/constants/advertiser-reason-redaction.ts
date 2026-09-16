/**
 * Advertiser-safe projection of operator eligibility reasons.
 *
 * This vocabulary is deliberately closed. Operator reasons can reveal another
 * campaign, allocation policy, or holdout membership, so callers must project
 * through this map and must never serialize an input reason directly.
 */
export const ADVERTISER_REASON_REDACTION_VERSION =
  'advertiser_reason_redaction_2026_09_v3'

export const ADVERTISER_OPERATOR_REASON_CODES = [
  'not_active',
  'off_flight',
  'no_creatives',
  'placement_mismatch',
  'country_excluded',
  'country_unresolved',
  'intent_gate_no',
  'semantic_requirement_invalid',
  'semantic_evidence_unavailable',
  'semantic_mismatch',
  'balance_empty',
  'daily_cap_spent',
  'total_budget_spent',
  'holdout',
  'no_campaigns',
  'primary_allocation_unassigned',
  'primary_allocation_invalid',
  'all_ineligible',
  'all_frequency_capped',
  'all_repeat_click_suppressed',
  'paced_out',
] as const

export type AdvertiserOperatorReason =
  (typeof ADVERTISER_OPERATOR_REASON_CODES)[number]

export const ADVERTISER_SAFE_REASON_CODES = [
  'not_active',
  'off_flight',
  'no_creatives',
  'placement_mismatch',
  'country_excluded',
  'country_unresolved',
  'context_filtered',
  'balance_empty',
  'daily_cap_spent',
  'total_budget_spent',
  'viewer_limits',
  'inventory_allocation',
  'paced_out',
  'temporarily_unavailable',
] as const

export type AdvertiserSafeReason = (typeof ADVERTISER_SAFE_REASON_CODES)[number]

type AdvertiserReasonRule =
  | { kind: 'show'; reason: AdvertiserSafeReason }
  | { kind: 'generalize'; reason: AdvertiserSafeReason }
  | { kind: 'hide' }

/**
 * The explicit allowlist and classification boundary.
 *
 * Only advertiser-owned campaign facts pass through unchanged. Request
 * context and viewer limits are generalized. Holdout membership, the global
 * book, and an aggregate all-ineligible verdict are hidden entirely.
 */
export const ADVERTISER_VISIBLE_REASONS = {
  not_active: { kind: 'show', reason: 'not_active' },
  off_flight: { kind: 'show', reason: 'off_flight' },
  no_creatives: { kind: 'show', reason: 'no_creatives' },
  placement_mismatch: { kind: 'show', reason: 'placement_mismatch' },
  // The advertiser wrote the country rule that refused this viewer, so naming
  // it back to them reveals nothing they do not already own. Kept as two codes
  // for the same reason serving keeps them apart: "your rule excluded them" and
  // "we could not place them at all" are different things to act on.
  country_excluded: { kind: 'show', reason: 'country_excluded' },
  country_unresolved: { kind: 'show', reason: 'country_unresolved' },
  intent_gate_no: { kind: 'generalize', reason: 'context_filtered' },
  // The advertiser owns the rule, but the viewer's evidence and whether it
  // matched remain request-private. All semantic refusal states share the
  // existing bounded context projection.
  semantic_requirement_invalid: {
    kind: 'generalize',
    reason: 'context_filtered',
  },
  semantic_evidence_unavailable: {
    kind: 'generalize',
    reason: 'context_filtered',
  },
  semantic_mismatch: { kind: 'generalize', reason: 'context_filtered' },
  balance_empty: { kind: 'show', reason: 'balance_empty' },
  daily_cap_spent: { kind: 'show', reason: 'daily_cap_spent' },
  total_budget_spent: { kind: 'show', reason: 'total_budget_spent' },
  holdout: { kind: 'hide' },
  no_campaigns: { kind: 'hide' },
  primary_allocation_unassigned: {
    kind: 'generalize',
    reason: 'inventory_allocation',
  },
  primary_allocation_invalid: {
    kind: 'generalize',
    reason: 'inventory_allocation',
  },
  all_ineligible: { kind: 'hide' },
  all_frequency_capped: { kind: 'generalize', reason: 'viewer_limits' },
  all_repeat_click_suppressed: {
    kind: 'generalize',
    reason: 'viewer_limits',
  },
  paced_out: { kind: 'show', reason: 'paced_out' },
} as const satisfies Record<AdvertiserOperatorReason, AdvertiserReasonRule>

export interface AdvertiserReasonProjection {
  reasonCodeVersion: typeof ADVERTISER_REASON_REDACTION_VERSION
  reason: AdvertiserSafeReason
  /** A fallback is always blocking; consumers must not infer readiness. */
  blocking: boolean
}

/**
 * Project one operator reason without ever returning the raw input.
 *
 * Unknown values are expected during partial deploys and after future serving
 * changes. They fail closed to the same blocking result as hidden reasons.
 */
export function projectAdvertiserReason(
  operatorReason: string | null | undefined,
): AdvertiserReasonProjection {
  const rule = Object.prototype.hasOwnProperty.call(
    ADVERTISER_VISIBLE_REASONS,
    operatorReason ?? '',
  )
    ? ADVERTISER_VISIBLE_REASONS[operatorReason as AdvertiserOperatorReason]
    : undefined

  return {
    reasonCodeVersion: ADVERTISER_REASON_REDACTION_VERSION,
    reason:
      rule && rule.kind !== 'hide' ? rule.reason : 'temporarily_unavailable',
    blocking: true,
  }
}
