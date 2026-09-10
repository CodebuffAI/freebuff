import { fnv1a } from '../util/ad-experiment'

export const SUPABASE_FORMAT_EXPERIMENT_VERSION =
  'supabase-acquisition-format-v1'

export type SupabaseFormatArm = 'display' | 'agentic'
export type SupabaseIntentAngle = 'database' | 'auth'

export type SupabaseMatchedEligibilityInput = {
  userId: string | null | undefined
  relevance:
    | {
        status: 'matched'
        angle: SupabaseIntentAngle
        decisionId: string
        policyVersion: string
      }
    | { status: 'not_matched' | 'unknown' }
  sameTaskProcedure:
    | { status: 'applicable'; procedureHash: string }
    | { status: 'not_applicable' | 'unknown' }
  executionSurface:
    | { status: 'supported'; surface: string }
    | { status: 'unsupported' | 'unknown' }
}

export type SupabaseEligibilityExclusionReason =
  | 'unauthenticated'
  | 'relevance_not_matched'
  | 'relevance_unknown'
  | 'procedure_not_applicable'
  | 'procedure_unknown'
  | 'surface_unsupported'
  | 'surface_unknown'
  | 'malformed_evidence'

export type SupabaseMatchedEligibility =
  | {
      eligible: false
      reason: SupabaseEligibilityExclusionReason
    }
  | {
      eligible: true
      experimentVersion: typeof SUPABASE_FORMAT_EXPERIMENT_VERSION
      userId: string
      angle: SupabaseIntentAngle
      decisionId: string
      policyVersion: string
      procedureHash: string
      surface: string
    }

export type SupabaseCandidateNoFillReason =
  | 'unavailable'
  | 'funding_exhausted'
  | 'conversation_cap_reached'
  | 'paused'

export type SupabaseFormatCandidate =
  | {
      status: 'available'
      candidateId: string
      campaignId: string
      contentHash: string
    }
  | { status: SupabaseCandidateNoFillReason }

export type SupabaseFormatAdmission =
  | {
      status: 'suppressed'
      reason: SupabaseEligibilityExclusionReason
    }
  | {
      status: 'no_fill'
      experimentVersion: typeof SUPABASE_FORMAT_EXPERIMENT_VERSION
      arm: SupabaseFormatArm
      userId: string
      decisionId: string
      reason: SupabaseCandidateNoFillReason | 'malformed_candidate'
    }
  | {
      status: 'serve'
      experimentVersion: typeof SUPABASE_FORMAT_EXPERIMENT_VERSION
      arm: SupabaseFormatArm
      userId: string
      angle: SupabaseIntentAngle
      decisionId: string
      policyVersion: string
      procedureHash: string
      surface: string
      candidateId: string
      campaignId: string
      contentHash: string
    }

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Stable authenticated-user assignment. The version string is the salt: a
 * cohort may only be reshuffled by starting a visibly new experiment.
 */
export function supabaseFormatArmForUser(
  userId: string | null | undefined,
): SupabaseFormatArm | null {
  if (!isNonEmptyString(userId)) return null
  return fnv1a(`${SUPABASE_FORMAT_EXPERIMENT_VERSION}:${userId}`) % 2 === 0
    ? 'display'
    : 'agentic'
}

/**
 * Admit only the intersection both formats can serve. Unknown evidence is a
 * suppression rather than a negative observation in the experiment.
 */
export function evaluateSupabaseMatchedEligibility(
  input: SupabaseMatchedEligibilityInput,
): SupabaseMatchedEligibility {
  if (!isNonEmptyString(input?.userId)) {
    return { eligible: false, reason: 'unauthenticated' }
  }
  if (!input.relevance || input.relevance.status === 'unknown') {
    return { eligible: false, reason: 'relevance_unknown' }
  }
  if (input.relevance.status === 'not_matched') {
    return { eligible: false, reason: 'relevance_not_matched' }
  }
  if (
    !input.sameTaskProcedure ||
    input.sameTaskProcedure.status === 'unknown'
  ) {
    return { eligible: false, reason: 'procedure_unknown' }
  }
  if (input.sameTaskProcedure.status === 'not_applicable') {
    return { eligible: false, reason: 'procedure_not_applicable' }
  }
  if (!input.executionSurface || input.executionSurface.status === 'unknown') {
    return { eligible: false, reason: 'surface_unknown' }
  }
  if (input.executionSurface.status === 'unsupported') {
    return { eligible: false, reason: 'surface_unsupported' }
  }
  if (
    input.relevance.status !== 'matched' ||
    input.sameTaskProcedure.status !== 'applicable' ||
    input.executionSurface.status !== 'supported' ||
    !isNonEmptyString(input.relevance.decisionId) ||
    !isNonEmptyString(input.relevance.policyVersion) ||
    !isNonEmptyString(input.sameTaskProcedure.procedureHash) ||
    !isNonEmptyString(input.executionSurface.surface) ||
    (input.relevance.angle !== 'database' && input.relevance.angle !== 'auth')
  ) {
    return { eligible: false, reason: 'malformed_evidence' }
  }

  return {
    eligible: true,
    experimentVersion: SUPABASE_FORMAT_EXPERIMENT_VERSION,
    userId: input.userId,
    angle: input.relevance.angle,
    decisionId: input.relevance.decisionId,
    policyVersion: input.relevance.policyVersion,
    procedureHash: input.sameTaskProcedure.procedureHash,
    surface: input.executionSurface.surface,
  }
}

/**
 * Select only the assigned arm's candidate. Inventory state may no-fill an
 * opportunity, but it can never move the user to the other format.
 */
export function admitSupabaseFormatCandidate(input: {
  eligibility: SupabaseMatchedEligibilityInput
  candidates: Record<SupabaseFormatArm, SupabaseFormatCandidate>
}): SupabaseFormatAdmission {
  const eligibility = evaluateSupabaseMatchedEligibility(input?.eligibility)
  if (!eligibility.eligible) {
    return { status: 'suppressed', reason: eligibility.reason }
  }

  const arm = supabaseFormatArmForUser(eligibility.userId)
  // Eligibility proves a non-empty authenticated id.
  if (!arm) return { status: 'suppressed', reason: 'unauthenticated' }
  const candidate = input?.candidates?.[arm]
  if (!candidate || candidate.status !== 'available') {
    const reason =
      candidate &&
      (candidate.status === 'unavailable' ||
        candidate.status === 'funding_exhausted' ||
        candidate.status === 'conversation_cap_reached' ||
        candidate.status === 'paused')
        ? candidate.status
        : 'malformed_candidate'
    return {
      status: 'no_fill',
      experimentVersion: SUPABASE_FORMAT_EXPERIMENT_VERSION,
      arm,
      userId: eligibility.userId,
      decisionId: eligibility.decisionId,
      reason,
    }
  }
  if (
    !isNonEmptyString(candidate.candidateId) ||
    !isNonEmptyString(candidate.campaignId) ||
    !isNonEmptyString(candidate.contentHash)
  ) {
    return {
      status: 'no_fill',
      experimentVersion: SUPABASE_FORMAT_EXPERIMENT_VERSION,
      arm,
      userId: eligibility.userId,
      decisionId: eligibility.decisionId,
      reason: 'malformed_candidate',
    }
  }

  return {
    status: 'serve',
    ...eligibility,
    arm,
    candidateId: candidate.candidateId,
    campaignId: candidate.campaignId,
    contentHash: candidate.contentHash,
  }
}

type SupabaseExperimentEventBase = {
  experimentVersion: typeof SUPABASE_FORMAT_EXPERIMENT_VERSION
  eventId: string
  occurredAt: string
  userId: string
  arm: SupabaseFormatArm
  angle: SupabaseIntentAngle
  surface: string
}

export type SupabaseFormatExperimentEvent =
  | (SupabaseExperimentEventBase & {
      type: 'eligible'
      decisionId: string
      policyVersion: string
      procedureHash: string
    })
  | (SupabaseExperimentEventBase & {
      type: 'exposure'
      arm: 'display'
      decisionId: string
      deliveryId: string
      contentHash: string
    })
  | (SupabaseExperimentEventBase & {
      type: 'exposure'
      arm: 'agentic'
      decisionId: string
      proposalId: string
      contentHash: string
    })
  | (SupabaseExperimentEventBase & {
      type: 'click'
      arm: 'display'
      deliveryId: string
      actionId: string
    })
  | (SupabaseExperimentEventBase & {
      type: 'accept'
      arm: 'agentic'
      proposalId: string
      actionId: string
    })
  | (SupabaseExperimentEventBase & {
      type: 'delivery'
      arm: 'agentic'
      proposalId: string
      deliveryId: string
    })
  | (SupabaseExperimentEventBase & {
      type: 'partner_outcome'
      arm: 'display'
      deliveryId: string
      outcomeId: string
      qualifiedActivation: boolean
    })
  | (SupabaseExperimentEventBase & {
      type: 'partner_outcome'
      arm: 'agentic'
      proposalId: string
      outcomeId: string
      qualifiedActivation: boolean
    })

export type SupabasePartnerOutcomeCoverage = 'complete' | 'partial' | 'unknown'

export type SupabasePrimaryAnalysisPlan = {
  /** Intention-to-treat metric clocked from each user's first eligibility. */
  metric: 'qualified_partner_activation_per_assigned_eligible_user'
  metricApproved: boolean
  attributionWindowMs: number
  windowApproved: boolean
  comparablePostbacks: boolean
  partnerOutcomeCoverage: Record<
    SupabaseFormatArm,
    SupabasePartnerOutcomeCoverage
  >
  /**
   * External assertion that every enrolled user in the reported denominator
   * has aged through the full approved attribution window.
   */
  matureWindowCoverage: Record<
    SupabaseFormatArm,
    SupabasePartnerOutcomeCoverage
  >
}

export type SupabaseFormatExperimentCounts = {
  eligibleUsers: number
  eligibleOpportunities: number
  exposures: number
  clicks: number
  accepts: number
  deliveries: number
  partnerOutcomes: number
  qualifiedPartnerOutcomes: number
}

export type SupabasePrimaryVerdict =
  | {
      status: 'unavailable'
      reasons: (
        | 'metric_unapproved'
        | 'window_unapproved'
        | 'invalid_window'
        | 'postbacks_not_comparable'
        | 'display_postback_coverage_incomplete'
        | 'agentic_postback_coverage_incomplete'
        | 'display_mature_window_coverage_incomplete'
        | 'agentic_mature_window_coverage_incomplete'
      )[]
    }
  | {
      status: 'measurement_ready'
      metric: 'qualified_partner_activation_per_assigned_eligible_user'
      attributionWindowMs: number
      display: {
        eligibleUsers: number
        activations: number
        rate: number | null
      }
      agentic: {
        eligibleUsers: number
        activations: number
        rate: number | null
      }
      winner: null
    }

export type SupabaseFormatExperimentReport = {
  experimentVersion: typeof SUPABASE_FORMAT_EXPERIMENT_VERSION
  byArm: Record<SupabaseFormatArm, SupabaseFormatExperimentCounts>
  cells: Array<
    SupabaseFormatExperimentCounts & {
      arm: SupabaseFormatArm
      angle: SupabaseIntentAngle
      surface: string
    }
  >
  rejected: {
    malformed: number
    duplicate: number
    assignmentMismatch: number
    orphaned: number
  }
  lateQualifiedPartnerOutcomes: number
  primaryVerdict: SupabasePrimaryVerdict
}

function emptyCounts(): SupabaseFormatExperimentCounts {
  return {
    eligibleUsers: 0,
    eligibleOpportunities: 0,
    exposures: 0,
    clicks: 0,
    accepts: 0,
    deliveries: 0,
    partnerOutcomes: 0,
    qualifiedPartnerOutcomes: 0,
  }
}

function isSyntacticallyValidEvent(
  value: unknown,
): value is SupabaseFormatExperimentEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Record<string, unknown>
  if (
    event.experimentVersion !== SUPABASE_FORMAT_EXPERIMENT_VERSION ||
    !isNonEmptyString(event.eventId) ||
    !isNonEmptyString(event.occurredAt) ||
    !Number.isFinite(Date.parse(event.occurredAt)) ||
    !isNonEmptyString(event.userId) ||
    (event.arm !== 'display' && event.arm !== 'agentic') ||
    (event.angle !== 'database' && event.angle !== 'auth') ||
    !isNonEmptyString(event.surface)
  ) {
    return false
  }
  if (supabaseFormatArmForUser(event.userId) !== event.arm) return true

  switch (event.type) {
    case 'eligible':
      return (
        isNonEmptyString(event.decisionId) &&
        isNonEmptyString(event.policyVersion) &&
        isNonEmptyString(event.procedureHash)
      )
    case 'exposure':
      return (
        isNonEmptyString(event.decisionId) &&
        isNonEmptyString(event.contentHash) &&
        (event.arm === 'display'
          ? isNonEmptyString(event.deliveryId)
          : isNonEmptyString(event.proposalId))
      )
    case 'click':
      return (
        event.arm === 'display' &&
        isNonEmptyString(event.deliveryId) &&
        isNonEmptyString(event.actionId)
      )
    case 'accept':
      return (
        event.arm === 'agentic' &&
        isNonEmptyString(event.proposalId) &&
        isNonEmptyString(event.actionId)
      )
    case 'delivery':
      return (
        event.arm === 'agentic' &&
        isNonEmptyString(event.proposalId) &&
        isNonEmptyString(event.deliveryId)
      )
    case 'partner_outcome':
      return (
        (event.arm === 'display'
          ? isNonEmptyString(event.deliveryId)
          : isNonEmptyString(event.proposalId)) &&
        isNonEmptyString(event.outcomeId) &&
        typeof event.qualifiedActivation === 'boolean'
      )
    default:
      return false
  }
}

function sameExperimentCell(
  left: SupabaseFormatExperimentEvent,
  right: SupabaseFormatExperimentEvent,
): boolean {
  return (
    left.userId === right.userId &&
    left.arm === right.arm &&
    left.angle === right.angle &&
    left.surface === right.surface
  )
}

function semanticId(event: SupabaseFormatExperimentEvent): string {
  switch (event.type) {
    case 'eligible':
      return `eligible:${event.decisionId}`
    case 'exposure':
      return `exposure:${exposureKey(event)}`
    case 'click':
    case 'accept':
      return `${event.type}:${event.actionId}`
    case 'delivery':
      return `delivery:${event.deliveryId}`
    case 'partner_outcome':
      return `partner_outcome:${event.outcomeId}`
  }
}

function exposureKey(
  event: Exclude<SupabaseFormatExperimentEvent, { type: 'eligible' }>,
): string {
  return event.arm === 'display'
    ? `display:${event.deliveryId}`
    : `agentic:${event.proposalId}`
}

/**
 * Aggregate already-normalized experiment facts. It performs no database
 * reads and infers no missing callbacks; absent partner coverage stays unknown.
 * The primary metric is intention to treat: each user's attribution window
 * starts at their first eligible event for this experiment version.
 */
export function aggregateSupabaseFormatExperiment(
  inputEvents: readonly unknown[],
  analysisPlan?: SupabasePrimaryAnalysisPlan,
): SupabaseFormatExperimentReport {
  const rejected = {
    malformed: 0,
    duplicate: 0,
    assignmentMismatch: 0,
    orphaned: 0,
  }
  const syntactic: SupabaseFormatExperimentEvent[] = []
  for (const value of inputEvents) {
    if (!isSyntacticallyValidEvent(value)) {
      rejected.malformed++
      continue
    }
    if (supabaseFormatArmForUser(value.userId) !== value.arm) {
      rejected.assignmentMismatch++
      continue
    }
    syntactic.push(value)
  }

  syntactic.sort(
    (left, right) =>
      Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
      left.eventId.localeCompare(right.eventId),
  )
  const seenEventIds = new Set<string>()
  const seenSemanticIds = new Set<string>()
  const deduped: SupabaseFormatExperimentEvent[] = []
  for (const event of syntactic) {
    const semantic = semanticId(event)
    if (seenEventIds.has(event.eventId) || seenSemanticIds.has(semantic)) {
      rejected.duplicate++
      continue
    }
    seenEventIds.add(event.eventId)
    seenSemanticIds.add(semantic)
    deduped.push(event)
  }

  const eligibleByDecision = new Map<
    string,
    Extract<SupabaseFormatExperimentEvent, { type: 'eligible' }>
  >()
  for (const event of deduped) {
    if (event.type === 'eligible')
      eligibleByDecision.set(event.decisionId, event)
  }
  const exposureById = new Map<
    string,
    Extract<SupabaseFormatExperimentEvent, { type: 'exposure' }>
  >()
  const accepted: SupabaseFormatExperimentEvent[] = []
  for (const event of deduped) {
    if (event.type === 'eligible') {
      accepted.push(event)
      continue
    }
    if (event.type === 'exposure') {
      const eligible = eligibleByDecision.get(event.decisionId)
      if (!eligible || !sameExperimentCell(event, eligible)) {
        rejected.orphaned++
        continue
      }
      if (Date.parse(event.occurredAt) < Date.parse(eligible.occurredAt)) {
        rejected.malformed++
        continue
      }
      exposureById.set(exposureKey(event), event)
      accepted.push(event)
      continue
    }
  }
  for (const event of deduped) {
    if (event.type === 'eligible' || event.type === 'exposure') continue
    const exposure = exposureById.get(exposureKey(event))
    if (!exposure || !sameExperimentCell(event, exposure)) {
      rejected.orphaned++
      continue
    }
    if (Date.parse(event.occurredAt) < Date.parse(exposure.occurredAt)) {
      rejected.malformed++
      continue
    }
    accepted.push(event)
  }

  const byArm = {
    display: emptyCounts(),
    agentic: emptyCounts(),
  }
  const cellCounts = new Map<string, SupabaseFormatExperimentCounts>()
  const eligibleUsersByArm = {
    display: new Set<string>(),
    agentic: new Set<string>(),
  }
  const eligibleUsersByCell = new Map<string, Set<string>>()
  const firstEligibilityByUser = new Map<
    string,
    Extract<SupabaseFormatExperimentEvent, { type: 'eligible' }>
  >()
  for (const event of accepted) {
    if (event.type === 'eligible' && !firstEligibilityByUser.has(event.userId)) {
      // accepted is timestamp ordered, so this freezes experiment enrollment
      // at the user's first eligible opportunity across retries and surfaces.
      firstEligibilityByUser.set(event.userId, event)
    }
  }
  const activationUsersByArm = {
    display: new Set<string>(),
    agentic: new Set<string>(),
  }
  let lateQualifiedPartnerOutcomes = 0

  for (const event of accepted) {
    const cellKey = `${event.arm}\u0000${event.angle}\u0000${event.surface}`
    const counts = cellCounts.get(cellKey) ?? emptyCounts()
    cellCounts.set(cellKey, counts)
    if (event.type === 'eligible') {
      byArm[event.arm].eligibleOpportunities++
      counts.eligibleOpportunities++
      eligibleUsersByArm[event.arm].add(event.userId)
      const users = eligibleUsersByCell.get(cellKey) ?? new Set<string>()
      users.add(event.userId)
      eligibleUsersByCell.set(cellKey, users)
    } else if (event.type === 'exposure') {
      byArm[event.arm].exposures++
      counts.exposures++
    } else if (event.type === 'click') {
      byArm.display.clicks++
      counts.clicks++
    } else if (event.type === 'accept') {
      byArm.agentic.accepts++
      counts.accepts++
    } else if (event.type === 'delivery') {
      byArm.agentic.deliveries++
      counts.deliveries++
    } else {
      byArm[event.arm].partnerOutcomes++
      counts.partnerOutcomes++
      if (event.qualifiedActivation) {
        byArm[event.arm].qualifiedPartnerOutcomes++
        counts.qualifiedPartnerOutcomes++
        if (analysisPlan && analysisPlan.attributionWindowMs > 0) {
          const eligible = firstEligibilityByUser.get(event.userId)
          const elapsed = eligible
            ? Date.parse(event.occurredAt) - Date.parse(eligible.occurredAt)
            : -1
          if (elapsed >= 0 && elapsed <= analysisPlan.attributionWindowMs) {
            activationUsersByArm[event.arm].add(event.userId)
          } else if (elapsed > analysisPlan.attributionWindowMs) {
            lateQualifiedPartnerOutcomes++
          }
        }
      }
    }
  }
  for (const arm of ['display', 'agentic'] as const) {
    byArm[arm].eligibleUsers = eligibleUsersByArm[arm].size
  }

  const cells = [...cellCounts.entries()]
    .map(([key, counts]) => {
      const [arm, angle, surface] = key.split('\u0000') as [
        SupabaseFormatArm,
        SupabaseIntentAngle,
        string,
      ]
      return {
        arm,
        angle,
        surface,
        ...counts,
        eligibleUsers: eligibleUsersByCell.get(key)?.size ?? 0,
      }
    })
    .sort(
      (left, right) =>
        left.arm.localeCompare(right.arm) ||
        left.angle.localeCompare(right.angle) ||
        left.surface.localeCompare(right.surface),
    )

  const verdictReasons: Extract<
    SupabasePrimaryVerdict,
    { status: 'unavailable' }
  >['reasons'] = []
  if (
    analysisPlan?.metric !==
      'qualified_partner_activation_per_assigned_eligible_user' ||
    !analysisPlan.metricApproved
  ) {
    verdictReasons.push('metric_unapproved')
  }
  if (!analysisPlan?.windowApproved) verdictReasons.push('window_unapproved')
  if (
    !analysisPlan ||
    !Number.isFinite(analysisPlan.attributionWindowMs) ||
    analysisPlan.attributionWindowMs <= 0
  ) {
    verdictReasons.push('invalid_window')
  }
  if (!analysisPlan?.comparablePostbacks) {
    verdictReasons.push('postbacks_not_comparable')
  }
  if (analysisPlan?.partnerOutcomeCoverage?.display !== 'complete') {
    verdictReasons.push('display_postback_coverage_incomplete')
  }
  if (analysisPlan?.partnerOutcomeCoverage?.agentic !== 'complete') {
    verdictReasons.push('agentic_postback_coverage_incomplete')
  }
  if (analysisPlan?.matureWindowCoverage?.display !== 'complete') {
    verdictReasons.push('display_mature_window_coverage_incomplete')
  }
  if (analysisPlan?.matureWindowCoverage?.agentic !== 'complete') {
    verdictReasons.push('agentic_mature_window_coverage_incomplete')
  }

  const primaryVerdict: SupabasePrimaryVerdict = verdictReasons.length
    ? { status: 'unavailable', reasons: verdictReasons }
    : {
        status: 'measurement_ready',
        metric: 'qualified_partner_activation_per_assigned_eligible_user',
        attributionWindowMs: analysisPlan!.attributionWindowMs,
        display: {
          eligibleUsers: byArm.display.eligibleUsers,
          activations: activationUsersByArm.display.size,
          rate:
            byArm.display.eligibleUsers === 0
              ? null
              : activationUsersByArm.display.size / byArm.display.eligibleUsers,
        },
        agentic: {
          eligibleUsers: byArm.agentic.eligibleUsers,
          activations: activationUsersByArm.agentic.size,
          rate:
            byArm.agentic.eligibleUsers === 0
              ? null
              : activationUsersByArm.agentic.size / byArm.agentic.eligibleUsers,
        },
        // This primitive reports the approved primary measurement. Statistical
        // stopping and winner selection belong to the predeclared analysis.
        winner: null,
      }

  return {
    experimentVersion: SUPABASE_FORMAT_EXPERIMENT_VERSION,
    byArm,
    cells,
    rejected,
    lateQualifiedPartnerOutcomes,
    primaryVerdict,
  }
}

// ---------------------------------------------------------------------------
// The format pairs (COD-446 / COD-449)
// ---------------------------------------------------------------------------

/**
 * One display + agentic campaign pair serving one intent angle, and the exact
 * reviewed procedure the agentic arm must carry. Defined ONCE here so the
 * Next serving path, the Convex reservation contract, the Convex audience
 * exception and the runtime readiness check cannot drift: before this
 * registry the same two campaign ids and one procedure hash were pinned
 * byte-for-byte in four source files.
 *
 * `procedureSha256` is the catalog hash of
 * `${procedureId}@${procedureVersion}` in
 * `evals/sponsored/procedures/supabase/acquisition-catalog.ts`; the catalog
 * test asserts the two agree. Readiness refuses to serve a pair whose stored
 * `sponsored_procedure` hashes to anything else — including the previous
 * version — so bumping the version here is a CONTRACT CHANGE that darkens the
 * pair until an operator re-POSTs the new procedure text onto the campaign.
 */
export type SupabaseFormatPair = Readonly<{
  angle: SupabaseIntentAngle
  displayCampaignId: string
  agenticCampaignId: string
  procedureId: string
  procedureVersion: string
  procedureSha256: `sha256:${string}`
  consentSummary: string
}>

/** `null` means the angle has no pair configured and every consumer treats it as absent. */
export type SupabaseFormatPairs = Readonly<
  Record<SupabaseIntentAngle, SupabaseFormatPair | null>
>

/** Catalog entry `supabase-database-persist-one-feature@1.1.0`. */
export const SUPABASE_FORMAT_DATABASE_PAIR: SupabaseFormatPair = Object.freeze({
  angle: 'database',
  displayCampaignId: '456fe7bd-2c28-47de-be2d-79b651991f3b',
  agenticCampaignId: '32f72345-38e9-4c53-b66d-8898c3ea7d8d',
  procedureId: 'supabase-database-persist-one-feature',
  procedureVersion: '1.1.0',
  procedureSha256:
    'sha256:11ed035b0bc0f75d621a2c23b3c0a41e9d891e403ba48f03259310d8a7e688fd',
  consentSummary:
    "Scaffold Supabase locally and wire one requested feature's identified create and read path.",
})

/**
 * Catalog entry `supabase-auth-one-feature@1.1.0`. The Auth pair's campaign
 * ids are not checked in: the rows do not exist yet, and they arrive through
 * `FREEBUFF_SUPABASE_AUTH_FORMAT_CAMPAIGN_IDS` (see `supabaseFormatPairs`).
 */
export const SUPABASE_FORMAT_AUTH_PROCEDURE = Object.freeze({
  angle: 'auth',
  procedureId: 'supabase-auth-one-feature',
  procedureVersion: '1.1.0',
  procedureSha256:
    'sha256:e9766dbc2575c2bbeec4fd5d8473f14585e13aeb97fbe187dee654598843b816',
  consentSummary:
    'Implement one requested Supabase Auth flow locally, including its established session and server authorization boundary.',
} as const satisfies Omit<
  SupabaseFormatPair,
  'displayCampaignId' | 'agenticCampaignId'
>)

/**
 * `"<displayCampaignId>,<agenticCampaignId>"`. Unset means no Auth pair.
 * Read from `process.env` by every consumer (Next through the env schema or
 * directly, Convex directly, the way `FREEBUFF_SUPABASE_FORMAT_AUDIENCE` is)
 * and handed to `supabaseFormatPairs` — this module never reads the
 * environment itself.
 */
export const SUPABASE_AUTH_FORMAT_CAMPAIGN_IDS_ENV =
  'FREEBUFF_SUPABASE_AUTH_FORMAT_CAMPAIGN_IDS'

const CAMPAIGN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Parse the Auth pair's ids. Anything but exactly two distinct lowercase
 * campaign UUIDs, neither of which is a database-pair id, reads as ABSENT:
 * a malformed value must darken the Auth pair rather than admit a stray id
 * into the format contract.
 */
export function parseSupabaseAuthFormatCampaignIds(
  raw: string | null | undefined,
): Pick<SupabaseFormatPair, 'displayCampaignId' | 'agenticCampaignId'> | null {
  if (typeof raw !== 'string') return null
  const parts = raw.split(',').map((part) => part.trim().toLowerCase())
  if (parts.length !== 2) return null
  const [displayCampaignId, agenticCampaignId] = parts as [string, string]
  const reserved = new Set([
    SUPABASE_FORMAT_DATABASE_PAIR.displayCampaignId,
    SUPABASE_FORMAT_DATABASE_PAIR.agenticCampaignId,
  ])
  if (
    !CAMPAIGN_ID_PATTERN.test(displayCampaignId) ||
    !CAMPAIGN_ID_PATTERN.test(agenticCampaignId) ||
    displayCampaignId === agenticCampaignId ||
    reserved.has(displayCampaignId) ||
    reserved.has(agenticCampaignId)
  ) {
    return null
  }
  return { displayCampaignId, agenticCampaignId }
}

export type SupabaseFormatPairsEnv = {
  FREEBUFF_SUPABASE_AUTH_FORMAT_CAMPAIGN_IDS?: string | null | undefined
}

/**
 * The registry, keyed by intent angle. The database pair is fixed; the Auth
 * pair exists only while its env value parses. Callers pass `process.env`
 * (or any object carrying that one key) so tests can set the value per case.
 */
export function supabaseFormatPairs(env: SupabaseFormatPairsEnv): SupabaseFormatPairs {
  const authIds = parseSupabaseAuthFormatCampaignIds(
    env.FREEBUFF_SUPABASE_AUTH_FORMAT_CAMPAIGN_IDS,
  )
  return Object.freeze({
    database: SUPABASE_FORMAT_DATABASE_PAIR,
    auth: authIds
      ? Object.freeze({ ...SUPABASE_FORMAT_AUTH_PROCEDURE, ...authIds })
      : null,
  })
}

/** Angles in the order every consumer iterates them. */
export const SUPABASE_INTENT_ANGLES: readonly SupabaseIntentAngle[] =
  Object.freeze(['database', 'auth'])

/** Every configured pair, database first. */
export function configuredSupabaseFormatPairs(
  pairs: SupabaseFormatPairs,
): SupabaseFormatPair[] {
  return SUPABASE_INTENT_ANGLES.flatMap((angle) => {
    const pair = pairs[angle]
    return pair ? [pair] : []
  })
}

/** Every campaign id in every configured pair. */
export function supabaseFormatCampaignIds(pairs: SupabaseFormatPairs): string[] {
  return configuredSupabaseFormatPairs(pairs).flatMap((pair) => [
    pair.displayCampaignId,
    pair.agenticCampaignId,
  ])
}

export function supabaseFormatCampaignIdForArm(
  pair: SupabaseFormatPair,
  arm: SupabaseFormatArm,
): string {
  return arm === 'display' ? pair.displayCampaignId : pair.agenticCampaignId
}

/** Which configured pair and arm a campaign id belongs to, if any. */
export function supabaseFormatPairForCampaignId(
  pairs: SupabaseFormatPairs,
  campaignId: string | null | undefined,
): { pair: SupabaseFormatPair; arm: SupabaseFormatArm } | null {
  if (!isNonEmptyString(campaignId)) return null
  for (const pair of configuredSupabaseFormatPairs(pairs)) {
    if (campaignId === pair.displayCampaignId) return { pair, arm: 'display' }
    if (campaignId === pair.agenticCampaignId) return { pair, arm: 'agentic' }
  }
  return null
}
