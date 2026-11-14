import { z } from 'zod'

const slug = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
const origin = z
  .string()
  .max(256)
  .refine((value) => {
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && url.origin === value
    } catch {
      return false
    }
  }, 'Expected an exact HTTPS origin')

/** Reviewed metadata only. The browser reader extracts timestamps, never key values. */
const legacyConversionDefinitionSchema = z
  .object({
    id: slug,
    version: z.literal(1),
    goal: z.string().min(1).max(400),
    criteria: z
      .array(
        z
          .object({
            id: slug,
            claim: z.enum(['new_account', 'new_api_key']),
            origin,
            /** A reviewed selector for a visible ISO-8601 creation timestamp. */
            createdAtSelector: z.string().min(1).max(160),
          })
          .strict(),
      )
      .min(1)
      .max(4),
  })
  .strict()
  .refine(
    (d) => new Set(d.criteria.map((c) => c.id)).size === d.criteria.length,
    'Criterion IDs must be unique',
  )

/** Agent-owned assessment; no advertiser-specific selector is required. */
const agentCriterion = z.discriminatedUnion('claim', [
  z
    .object({
      id: slug,
      claim: z.literal('new_account'),
      origin,
      instructions: z.string().min(1).max(600),
    })
    .strict(),
  z
    .object({
      id: slug,
      claim: z.literal('new_api_key'),
      origin,
      instructions: z.string().min(1).max(600),
      credentialEnv: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)$/),
    })
    .strict(),
])
export const agentConversionDefinitionSchema = z
  .object({
    id: slug,
    version: z.literal(2),
    goal: z.string().min(1).max(400),
    criteria: z.array(agentCriterion).min(1).max(4),
  })
  .strict()
  .refine(
    (d) => new Set(d.criteria.map((c) => c.id)).size === d.criteria.length,
    'Criterion IDs must be unique',
  )
/** New skills can measure onboarding only; no model-authored goal or instructions. */
export const simpleConversionDefinitionSchema = z
  .object({
    id: z.literal('onboarding'),
    version: z.literal(3),
    goal: z.literal('Verify product onboarding'),
    criteria: z
      .array(
        z.discriminatedUnion('claim', [
          z
            .object({
              id: z.literal('sign-in'),
              claim: z.literal('signed_in'),
              origin,
            })
            .strict(),
          z
            .object({
              id: z.literal('api-key'),
              claim: z.literal('new_api_key'),
              origin,
              credentialEnv: z
                .string()
                .regex(/^[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)$/),
            })
            .strict(),
          z
            .object({
              id: z.literal('product-download'),
              claim: z.literal('product_download'),
              origin,
              product: z.enum(['cli', 'sdk']),
              package: z.string().min(1).max(214),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(2),
  })
  .strict()
  .refine(
    (d) =>
      new Set(d.criteria.map((c) => c.id)).size === d.criteria.length &&
      d.criteria.filter((c) => c.claim !== 'signed_in').length <= 1,
    'Use sign-in and at most one of API-key creation or CLI/SDK download',
  )

export function validConversionBasis(claim: string, basis: string): boolean {
  if (claim === 'signed_in') return basis === 'authenticated_session'
  if (claim === 'product_download') return basis === 'installation_verified'
  return (
    basis === 'creation_metadata' ||
    basis === (claim === 'new_account' ? 'signup_completion' : 'key_creation')
  )
}

export const conversionDefinitionSchema = z.union([
  simpleConversionDefinitionSchema,
  legacyConversionDefinitionSchema,
  agentConversionDefinitionSchema,
])

const agentBasis = z.enum([
  'authenticated_session',
  'installation_verified',
  'signup_completion',
  'key_creation',
  'creation_metadata',
  'existing_resource',
  'insufficient_evidence',
])
/** Model supplies a decision, never credentials, page text, or campaign/run identity. */
export const agentConversionInputSchema = z
  .object({
    criteria: z
      .array(
        z
          .object({
            criterionId: slug,
            snapshotId: z.string().uuid(),
            verdict: z.enum(['satisfied', 'inconclusive']),
            basis: agentBasis,
          })
          .strict(),
      )
      .min(1)
      .max(4),
  })
  .strict()
export type AgentConversionInput = z.infer<typeof agentConversionInputSchema>

const legacyEvidence = z
  .object({
    criterionId: slug,
    source: z.literal('browser_metadata'),
    origin,
    observedAt: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict()
const agentEvidence = z
  .object({
    criterionId: slug,
    source: z.enum(['agent_browser', 'agent_install']),
    origin,
    observedAt: z.number().int().nonnegative(),
    verdict: z.enum(['satisfied', 'inconclusive']),
    basis: agentBasis,
    projectCredentialAvailable: z.boolean().optional(),
    installationVerified: z.boolean().optional(),
  })
  .strict()

export type ConversionDefinition = z.infer<typeof conversionDefinitionSchema>
export const CONVERSION_DIRECTIVE = 'conversion-definition: '

/**
 * The conversion tool set a client build carries: `request_sponsored_signup`'s
 * assessment hand-off, `assess_sponsored_conversion` and
 * `report_sponsored_conversion` (Desktop's `SPONSORED_CONVERSION_TOOLS`). A
 * Desktop that has them sends `conversionToolsVersion` with this value on the
 * agentic offer request, on `/api/ads` and on the Accept body. It is a
 * capability, not a version floor: a Desktop release cut without the tools
 * never sends it, whatever its version number.
 */
export const SPONSORED_CONVERSION_TOOLS_VERSION = 2 as const

/**
 * Whether a request's `conversionToolsVersion` (untrusted, as sent) says the
 * client has the original browser tools (set 1) or newer. V3 definitions
 * additionally require set 2 in sponsoredConversionClientRefusal.
 */
export function clientHasSponsoredConversionTools(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

/**
 * How long after Accept a run can still produce evidence: a compute grant may
 * start up to 24 hours after Accept and then run for up to an hour.
 */
export const CONVERSION_EVIDENCE_WINDOW_MS = 25 * 60 * 60_000
/**
 * `observedAt` is stamped by the reporting client's clock and `acceptedAt` by
 * the server's. Tolerate this much disagreement before discarding evidence.
 */
export const CONVERSION_CLOCK_SKEW_MS = 5 * 60_000

export function conversionDefinitionFromProcedure(
  procedure: string | null | undefined,
): ConversionDefinition | null {
  const lines =
    procedure
      ?.split('\n')
      .filter((line) => line.startsWith(CONVERSION_DIRECTIVE)) ?? []
  if (lines.length !== 1 || lines[0]!.length > 4096) return null
  try {
    const parsed = conversionDefinitionSchema.safeParse(
      JSON.parse(lines[0]!.slice(CONVERSION_DIRECTIVE.length)),
    )
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export const conversionReportSchema = z
  .object({
    userAnswer: z.enum(['confirmed', 'declined', 'unknown']),
    lifecycle: z.enum(['pending', 'completed', 'interrupted', 'timed_out']),
    reason: z.enum([
      'awaiting_user',
      'user_declined',
      'not_assessed',
      'browser_unavailable',
      'tab_closed',
      'origin_mismatch',
      'metadata_missing',
      'insufficient_evidence',
      'project_key_missing',
      'existing_resource',
      'criteria_satisfied',
      'interrupted',
      'timed_out',
    ]),
    /** No prose, HTML, screenshots, URL paths, credentials or resource IDs. */
    evidence: z.array(z.union([legacyEvidence, agentEvidence])).max(4),
  })
  .strict()
export type ConversionReport = z.infer<typeof conversionReportSchema>
export type ConversionAssessment = ConversionReport & {
  definition: ConversionDefinition
  assessment: 'not_assessed' | 'inconclusive' | 'satisfied'
  acceptedAt: number
  updatedAt: number
}

export function pendingConversion(
  definition: ConversionDefinition,
  acceptedAt: number,
): ConversionAssessment {
  return {
    definition,
    acceptedAt,
    updatedAt: acceptedAt,
    userAnswer: 'unknown',
    lifecycle: 'pending',
    reason: 'awaiting_user',
    evidence: [],
    assessment: 'not_assessed',
  }
}

/** Report reasons that carry no evidence of their own. */
const WEAK_REPORT_REASONS: ReadonlySet<ConversionReport['reason']> = new Set([
  'awaiting_user',
  'not_assessed',
  'interrupted',
  'timed_out',
])

/** One run/definition identity. Retries and later weaker reports cannot erase observed evidence. */
export function mergeConversionReport(
  current: ConversionAssessment,
  report: ConversionReport,
  now: number,
): ConversionAssessment {
  const evidence = new Map(current.evidence.map((e) => [e.criterionId, e]))
  for (const item of report.evidence) {
    const criterion = current.definition.criteria.find(
      (c) => c.id === item.criterionId,
    )
    if (
      !criterion ||
      criterion.origin !== item.origin ||
      item.observedAt < current.acceptedAt - CONVERSION_CLOCK_SKEW_MS ||
      item.observedAt > now + CONVERSION_CLOCK_SKEW_MS ||
      item.observedAt >
        current.acceptedAt +
          CONVERSION_EVIDENCE_WINDOW_MS +
          CONVERSION_CLOCK_SKEW_MS
    )
      continue
    if (item.source === 'browser_metadata') {
      if (
        current.definition.version !== 1 ||
        item.createdAt < current.acceptedAt ||
        item.createdAt > item.observedAt + CONVERSION_CLOCK_SKEW_MS
      )
        continue
    } else {
      if (current.definition.version === 1) continue
      if (
        (criterion.claim === 'product_download') !==
        (item.source === 'agent_install')
      )
        continue
      if (
        item.verdict === 'satisfied' &&
        ((criterion.claim !== 'product_download' &&
          (current.userAnswer === 'unknown'
            ? report.userAnswer
            : current.userAnswer) !== 'confirmed') ||
          !validConversionBasis(criterion.claim, item.basis) ||
          (criterion.claim === 'product_download'
            ? item.source !== 'agent_install' ||
              item.installationVerified !== true
            : item.source !== 'agent_browser') ||
          (criterion.claim === 'new_api_key' &&
            item.projectCredentialAvailable !== true))
      )
        continue
    }
    const prior = evidence.get(item.criterionId)
    if (
      !prior ||
      (prior.source !== 'browser_metadata' && prior.verdict !== 'satisfied')
    )
      evidence.set(item.criterionId, item)
  }
  const satisfied = current.definition.criteria.every((c) => {
    const item = evidence.get(c.id)
    return (
      item &&
      (item.source === 'browser_metadata' || item.verdict === 'satisfied')
    )
  })
  const userAnswer =
    current.userAnswer === 'unknown' ? report.userAnswer : current.userAnswer
  return {
    ...current,
    userAnswer,
    updatedAt: now,
    evidence: [...evidence.values()],
    lifecycle: satisfied
      ? 'completed'
      : current.lifecycle !== 'pending' && report.lifecycle === 'pending'
        ? current.lifecycle
        : report.lifecycle,
    reason: satisfied
      ? 'criteria_satisfied'
      : report.reason === 'criteria_satisfied'
        ? current.definition.version !== 1
          ? 'insufficient_evidence'
          : 'metadata_missing'
        : current.assessment === 'inconclusive' &&
            WEAK_REPORT_REASONS.has(report.reason)
          ? // A later "not assessed"/interruption adds nothing, so it must not
            // replace the evidence-backed reason the assessment rests on.
            current.reason
          : report.reason,
    assessment: satisfied
      ? 'satisfied'
      : [
            'browser_unavailable',
            'tab_closed',
            'origin_mismatch',
            'metadata_missing',
            'insufficient_evidence',
            'project_key_missing',
            'existing_resource',
            'criteria_satisfied',
          ].includes(report.reason)
        ? 'inconclusive'
        : current.assessment,
  }
}

/**
 * The criterion ids whose reported evidence `merged` did not keep: outside the
 * time window, the wrong origin, unknown, or a satisfied verdict without the
 * confirmation, basis or saved key it needs. Evidence replaced only because a
 * stronger item was already stored is not rejected.
 */
export function rejectedConversionEvidence(
  merged: ConversionAssessment,
  report: ConversionReport,
): string[] {
  const rejected = report.evidence.flatMap((item) => {
    const kept = merged.evidence.find((e) => e.criterionId === item.criterionId)
    if (!kept) return [item.criterionId]
    if (kept.source === item.source && kept.observedAt === item.observedAt)
      return []
    const stronger =
      kept.source === 'browser_metadata' || kept.verdict === 'satisfied'
    return stronger ? [] : [item.criterionId]
  })
  return [...new Set(rejected)]
}

/** Parse the host's fixed browser response; all unexpected page fields are discarded. */
export function browserConversionReport(
  current: ConversionAssessment,
  raw: unknown,
  now: number,
): ConversionReport {
  const base: ConversionReport = {
    userAnswer: current.userAnswer,
    lifecycle: 'completed',
    reason: 'metadata_missing',
    evidence: [],
  }
  if (current.definition.version !== 1) return base
  const parsed = z
    .object({
      origin: z.string(),
      observations: z
        .array(
          z.object({
            criterionId: slug,
            createdAt: z.number().int().nonnegative().nullable(),
          }),
        )
        .max(4),
    })
    .safeParse(raw)
  if (!parsed.success) return base
  if (!current.definition.criteria.some((c) => c.origin === parsed.data.origin))
    return { ...base, reason: 'origin_mismatch' }
  for (const criterion of current.definition.criteria) {
    const observation = parsed.data.observations.find(
      (o) => o.criterionId === criterion.id,
    )
    if (
      criterion.origin !== parsed.data.origin ||
      observation?.createdAt == null
    )
      continue
    if (observation.createdAt < current.acceptedAt) {
      base.reason = 'existing_resource'
      continue
    }
    if (observation.createdAt > now) continue
    base.evidence.push({
      criterionId: criterion.id,
      source: 'browser_metadata',
      origin: criterion.origin,
      observedAt: now,
      createdAt: observation.createdAt,
    })
  }
  if (base.evidence.length === current.definition.criteria.length)
    base.reason = 'criteria_satisfied'
  return base
}

/** Missing reports remain measurable even after a client crash; no timer implies a decline. */
export function effectiveConversion(
  current: ConversionAssessment,
  now: number,
): ConversionAssessment {
  if (
    current.lifecycle !== 'pending' ||
    now <= current.acceptedAt + CONVERSION_EVIDENCE_WINDOW_MS
  )
    return current
  return {
    ...current,
    lifecycle: 'timed_out',
    reason: current.assessment === 'satisfied' ? current.reason : 'timed_out',
  }
}

/** Fixed, read-only DOM extraction: no model-provided JS and no arbitrary page text crosses the bridge. */
export function conversionBrowserExpression(
  definition: ConversionDefinition,
): string {
  if (definition.version !== 1)
    throw new Error('Agent definitions require browser inspection')
  return `(() => {
    const criteria = ${JSON.stringify(definition.criteria)};
    return { origin: location.origin, observations: criteria.filter(c => c.origin === location.origin).map(c => {
      const nodes = Array.from(document.querySelectorAll(c.createdAtSelector)).slice(0, 20);
      const times = nodes.filter(n => n.getClientRects().length > 0 && getComputedStyle(n).visibility !== 'hidden')
        .map(n => (n.getAttribute('datetime') || n.textContent || '').trim())
        .filter(t => /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$/.test(t))
        .map(t => Date.parse(t)).filter(t => Number.isFinite(t));
      return { criterionId: c.id, createdAt: times.length ? Math.max(...times) : null };
    }) };
  })()`
}
