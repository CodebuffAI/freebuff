import { fnv1a } from '../util/ad-experiment'
import {
  SUPABASE_FORMAT_DATABASE_PAIR,
  type SupabaseFormatArm,
} from './supabase-format-experiment'

/**
 * A separately salted experiment. Never reuse the old format-assignment salt:
 * changing price and the billed action creates a new experiment population.
 */
export const SUPABASE_FORMAT_CPC_EXPERIMENT_VERSION = 'supabase_format_cpc_v1'
export const SUPABASE_FORMAT_CPC_EXPERIMENT_SALT =
  'supabase_format_cpc_assignment_2026_09'
export const SUPABASE_FORMAT_CPC_EXPERIMENT_ENV =
  'FREEBUFF_SUPABASE_FORMAT_CPC_EXPERIMENT'
export const SUPABASE_FORMAT_CPC_DAILY_CAP_CENTS = 12_500
export const SUPABASE_FORMAT_CPC_PRICE_CENTS = Object.freeze({
  display: 100,
  agentic: 300,
} satisfies Record<SupabaseFormatArm, number>)
export const SUPABASE_AGENTIC_INITIAL_CTA_BILLING_VERSION = 1

/**
 * The agentic arm is served UNTARGETED by default: the relevance classifier is
 * skipped and the canonical database angle is offered to anyone the courtesy
 * policy allows. Set FREEBUFF_SUPABASE_AGENTIC_TARGETING=relevance to restore
 * the classifier.
 *
 * Courtesy is unaffected in both modes -- opt-out, report and cooldown are
 * still enforced -- as are consent, the capability requirements and campaign
 * review. Untargeted means the card may reach a user with no open persistence
 * need, or one already on a provider.
 */
export const SUPABASE_AGENTIC_TARGETING_ENV =
  'FREEBUFF_SUPABASE_AGENTIC_TARGETING'

export function supabaseAgenticRelevanceMode(
  raw: string | null | undefined,
): 'classified' | 'unconditional' {
  return raw === 'relevance' ? 'classified' : 'unconditional'
}

/**
 * Reach is per ARM, not per experiment. The two arms do not cost the same to
 * be wrong about: display renders a card, while agentic offers to run a
 * sponsored procedure in the user's own checkout. Both arms currently serve
 * the SAME population (Tier 1, Mac/Linux Desktop), which is what keeps the
 * 50/50 readout comparable; the table exists so that widening one arm is an
 * explicit decision rather than a side effect.
 *
 * The assignment salt is not read here, so a user's arm never moves when this
 * table does. If the arms ever diverge, they are comparable only on the
 * intersection, and a readout over the whole served population becomes a
 * delivery report rather than an experiment result.
 */
export const SUPABASE_FORMAT_CPC_ARM_REACH = Object.freeze({
  display: {
    geoTiers: ['tier1'],
    // desktop_windows is deliberately absent: the capability schema and the
    // Desktop client both stop at Mac/Linux, so adding it here alone would
    // widen nothing. It needs a client release, not a server constant.
    executionSurfaces: ['desktop_macos', 'desktop_linux'],
  },
  agentic: {
    geoTiers: ['tier1'],
    // Windows has no local containment (`windows-no-containment`), so the
    // agentic arm may never offer sponsored execution there.
    executionSurfaces: ['desktop_macos', 'desktop_linux'],
  },
} satisfies Record<
  SupabaseFormatArm,
  { geoTiers: readonly string[]; executionSurfaces: readonly string[] }
>)

export type SupabaseFormatCpcExperimentMode = 'off' | 'on'
export type SupabaseFormatCpcBillingAction =
  | 'display_click'
  | 'agentic_initial_implement_click'

export type SupabaseFormatCpcPolicy = Readonly<{
  experimentVersion: typeof SUPABASE_FORMAT_CPC_EXPERIMENT_VERSION
  arm: SupabaseFormatArm
  campaignId: string
  cpcCents: number
  dailyCapCents: typeof SUPABASE_FORMAT_CPC_DAILY_CAP_CENTS
  billingAction: SupabaseFormatCpcBillingAction
}>

export type SupabaseFormatCpcEligibilityReason =
  | 'unauthenticated'
  | 'relevance_not_qualified'
  | 'geo_not_eligible'
  | 'surface_not_eligible'
  | 'agentic_client_update_required'

export type SupabaseFormatCpcEligibility =
  | { eligible: false; reason: SupabaseFormatCpcEligibilityReason }
  | { eligible: true; userId: string; arm: SupabaseFormatArm }

export type SupabaseFormatCpcEligibilityInput = Readonly<{
  /** Authenticated server identity; no client-provided id may be used here. */
  userId: string | null | undefined
  /** Caller owns the existing broad relevance classifier and supplies its result. */
  qualifiedRelevance: boolean
  geoTier: 'tier1' | 'tier2' | 'unknown' | string | null | undefined
  executionSurface: string | null | undefined
  /** Agentic cards bill their first CTA only when the client understands v1. */
  invitationBillingVersion?: number | null | undefined
}>

export type SupabaseFormatCpcCampaignCandidate = Readonly<{
  campaignId: string
  status: string
  /** Caller derives this from the existing reviewed campaign/procedure state. */
  reviewed: boolean
  billingModel: 'cpc' | 'cpa' | string | null | undefined
  cpcCents: number
  dailyCapCents: number
  /** Null is the required no-lifetime-cap configuration. */
  totalBudgetCents: number | null | undefined
  availableBalanceCents: number
  spentTodayCents: number
}>

export type SupabaseFormatCpcCandidateReason =
  | 'campaign_not_canonical'
  | 'campaign_not_active'
  | 'campaign_not_reviewed'
  | 'billing_model_invalid'
  | 'cpc_price_invalid'
  | 'daily_cap_invalid'
  | 'lifetime_cap_configured'
  | 'insufficient_balance'
  | 'daily_cap_exhausted'

export function supabaseFormatCpcExperimentMode(
  raw: string | null | undefined,
): SupabaseFormatCpcExperimentMode {
  return raw === 'on' ? 'on' : 'off'
}

function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Stable 50/50 assignment for authenticated users only. */
export function supabaseFormatCpcArmForUser(
  userId: string | null | undefined,
): SupabaseFormatArm | null {
  if (!nonEmpty(userId)) return null
  return fnv1a(`${SUPABASE_FORMAT_CPC_EXPERIMENT_SALT}:${userId}`) % 2 === 0
    ? 'display'
    : 'agentic'
}

export function supabaseFormatCpcPolicyForArm(
  arm: SupabaseFormatArm,
): SupabaseFormatCpcPolicy {
  return {
    experimentVersion: SUPABASE_FORMAT_CPC_EXPERIMENT_VERSION,
    arm,
    campaignId:
      arm === 'display'
        ? SUPABASE_FORMAT_DATABASE_PAIR.displayCampaignId
        : SUPABASE_FORMAT_DATABASE_PAIR.agenticCampaignId,
    cpcCents: SUPABASE_FORMAT_CPC_PRICE_CENTS[arm],
    dailyCapCents: SUPABASE_FORMAT_CPC_DAILY_CAP_CENTS,
    billingAction:
      arm === 'display'
        ? 'display_click'
        : 'agentic_initial_implement_click',
  }
}

/**
 * Assignment first, then that arm's reach. Display deliberately has no Git,
 * worktree, or paid-execution precondition, but it is held to the same Tier 1
 * Mac/Linux population as agentic so the 50/50 split stays comparable.
 * See SUPABASE_FORMAT_CPC_ARM_REACH before widening either arm.
 */
export function evaluateSupabaseFormatCpcEligibility(
  input: SupabaseFormatCpcEligibilityInput,
): SupabaseFormatCpcEligibility {
  if (!nonEmpty(input?.userId)) {
    return { eligible: false, reason: 'unauthenticated' }
  }
  if (input.qualifiedRelevance !== true)
    return { eligible: false, reason: 'relevance_not_qualified' }
  // Assign before gating: reach is a property of the arm, so the arm has to be
  // known first. Assignment reads only the salted user id, never reach.
  const arm = supabaseFormatCpcArmForUser(input.userId)
  if (!arm) return { eligible: false, reason: 'unauthenticated' }
  const reach = SUPABASE_FORMAT_CPC_ARM_REACH[arm]
  if (
    typeof input.geoTier !== 'string' ||
    !reach.geoTiers.includes(input.geoTier)
  ) {
    return { eligible: false, reason: 'geo_not_eligible' }
  }
  if (
    typeof input.executionSurface !== 'string' ||
    !reach.executionSurfaces.includes(input.executionSurface)
  ) {
    return { eligible: false, reason: 'surface_not_eligible' }
  }
  if (
    arm === 'agentic' &&
    input.invitationBillingVersion !== SUPABASE_AGENTIC_INITIAL_CTA_BILLING_VERSION
  ) {
    return { eligible: false, reason: 'agentic_client_update_required' }
  }
  return { eligible: true, userId: input.userId, arm }
}

/**
 * Configuration and live spend check for exactly one assigned canonical arm.
 * It never selects or falls back to the opposite campaign.
 */
export function validateSupabaseFormatCpcCandidate(input: {
  arm: SupabaseFormatArm
  candidate: SupabaseFormatCpcCampaignCandidate
}): { valid: true; policy: SupabaseFormatCpcPolicy } | {
  valid: false
  reason: SupabaseFormatCpcCandidateReason
} {
  const policy = supabaseFormatCpcPolicyForArm(input.arm)
  const candidate = input.candidate
  if (candidate.campaignId !== policy.campaignId)
    return { valid: false, reason: 'campaign_not_canonical' }
  if (candidate.status !== 'active') {
    return { valid: false, reason: 'campaign_not_active' }
  }
  if (!candidate.reviewed) {
    return { valid: false, reason: 'campaign_not_reviewed' }
  }
  if (candidate.billingModel !== 'cpc')
    return { valid: false, reason: 'billing_model_invalid' }
  if (candidate.cpcCents !== policy.cpcCents)
    return { valid: false, reason: 'cpc_price_invalid' }
  if (
    !Number.isSafeInteger(candidate.dailyCapCents) ||
    candidate.dailyCapCents <= 0 ||
    candidate.dailyCapCents > policy.dailyCapCents
  ) {
    return { valid: false, reason: 'daily_cap_invalid' }
  }
  if (candidate.totalBudgetCents !== null)
    return { valid: false, reason: 'lifetime_cap_configured' }
  if (candidate.availableBalanceCents < policy.cpcCents)
    return { valid: false, reason: 'insufficient_balance' }
  if (candidate.spentTodayCents + policy.cpcCents > candidate.dailyCapCents)
    return { valid: false, reason: 'daily_cap_exhausted' }
  return { valid: true, policy }
}
