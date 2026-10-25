import {
  scrubSponsoredRunSummary,
  SPONSORED_RUN_SUMMARY_MAX,
} from './sponsored-run-summary'
import type { SponsoredStepDriveResult } from './sponsored-step-driver'
import type { SponsoredTurnEnding } from './sponsored-in-place'

/** Only final human steps remain; setup that precedes implementation is not verification. */
export function sponsoredUserVerificationPending(
  result: SponsoredStepDriveResult,
): boolean {
  const firstPending = result.steps.findIndex(
    (step) => step.status === 'needs_user',
  )
  return (
    result.delivered &&
    !result.stoppedBecause &&
    firstPending > 0 &&
    result.steps.some((step) => step.kind === 'agent') &&
    result.steps.every((step, index) =>
      index < firstPending
        ? step.status === 'passed'
        : step.kind === 'user' &&
          (step.status === 'passed' || step.status === 'needs_user'),
    )
  )
}

/** Closed telemetry only: no paths, labels, command output, or credential values. */
export const SPONSORED_BLOCKER_CATEGORIES = [
  'scope_check',
  'needs_api_key',
  'needs_login',
  'command_failed',
  'verification_failed',
] as const
export type SponsoredBlockerCategory =
  (typeof SPONSORED_BLOCKER_CATEGORIES)[number]
export const SPONSORED_RUN_ENDINGS = [
  'completed',
  'stopped',
  'closed',
  'interrupted',
  'error',
  'grant_expired',
  'runner_restarted',
] as const
export type SponsoredRunEvidence = {
  agentSummary?: string
  version: 1
  ending: (typeof SPONSORED_RUN_ENDINGS)[number]
  checks: Array<{
    step: number
    checkId: string
    category: SponsoredBlockerCategory
  }>
  /** At least one evaluator result survived; absent on ending-only reports. */
  checksRecorded?: true
  /** Implementation checks passed; only final human verification remains. Optional for old clients. */
  verificationPending?: true
  truncated?: true
}
export const SPONSORED_EVIDENCE_CHECK_LIMIT = 20

/** Also used by Convex: keep this module free of runtime/zod dependencies. */
export function parseSponsoredRunEvidence(
  value: unknown,
): SponsoredRunEvidence | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  const v = value as Record<string, unknown>
  if (
    Object.keys(v).some(
      (k) =>
        ![
          'version',
          'agentSummary',
          'ending',
          'checks',
          'checksRecorded',
          'verificationPending',
          'truncated',
        ].includes(k),
    ) ||
    (v.agentSummary !== undefined &&
      (typeof v.agentSummary !== 'string' ||
        !v.agentSummary.trim() ||
        v.agentSummary.length > SPONSORED_RUN_SUMMARY_MAX)) ||
    v.version !== 1 ||
    !(SPONSORED_RUN_ENDINGS as readonly unknown[]).includes(v.ending) ||
    (v.verificationPending !== undefined &&
      (v.verificationPending !== true ||
        !['completed', 'closed', 'stopped', 'interrupted'].includes(
          v.ending as string,
        ))) ||
    (v.checksRecorded !== undefined && v.checksRecorded !== true) ||
    (v.truncated !== undefined && v.truncated !== true) ||
    !Array.isArray(v.checks) ||
    v.checks.length > SPONSORED_EVIDENCE_CHECK_LIMIT
  )
    return undefined
  const checks: SponsoredRunEvidence['checks'] = []
  for (const raw of v.checks) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const c = raw as Record<string, unknown>
    if (
      Object.keys(c).some(
        (k) => !['step', 'checkId', 'category'].includes(k),
      ) ||
      !Number.isInteger(c.step) ||
      (c.step as number) < 0 ||
      (c.step as number) > 100 ||
      typeof c.checkId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(c.checkId) ||
      !(SPONSORED_BLOCKER_CATEGORIES as readonly unknown[]).includes(c.category)
    )
      return undefined
    checks.push({
      step: c.step as number,
      checkId: c.checkId,
      category: c.category as SponsoredBlockerCategory,
    })
  }
  return {
    version: 1,
    ...(scrubSponsoredRunSummary(v.agentSummary)
      ? { agentSummary: scrubSponsoredRunSummary(v.agentSummary)! }
      : {}),
    ending: v.ending as SponsoredRunEvidence['ending'],
    checks,
    ...(v.verificationPending ? { verificationPending: true as const } : {}),
    ...(v.checksRecorded ? { checksRecorded: true } : {}),
    ...(v.truncated ? { truncated: true } : {}),
  }
}

/** Recover structured evidence on idempotent retries without a new proposal column. */
export function sponsoredEvidenceFromReport(
  payload: string | null | undefined,
): SponsoredRunEvidence | undefined {
  try {
    return payload
      ? parseSponsoredRunEvidence(JSON.parse(payload).runEvidence)
      : undefined
  } catch {
    return undefined
  }
}

export function sponsoredRunEvidence(
  ending: SponsoredTurnEnding,
  steps?: SponsoredStepDriveResult | null,
  errorText?: string | null,
): SponsoredRunEvidence {
  const checks: SponsoredRunEvidence['checks'] = []
  for (const step of [
    { number: 0, checks: steps?.preflight ?? [] },
    ...(steps?.steps ?? []),
  ]) {
    for (const check of step.checks) {
      if (check.status !== 'fail') continue
      const category: SponsoredBlockerCategory =
        check.kind === 'changes_within'
          ? 'scope_check'
          : check.kind === 'credential_provided'
            ? 'needs_api_key'
            : check.kind === 'user_confirmed'
              ? 'needs_login'
              : check.kind === 'command_succeeds' ||
                  check.kind === 'script_passes'
                ? 'command_failed'
                : 'verification_failed'
      // Skill ids are bounded telemetry identifiers, never arbitrary output.
      checks.push({
        step: step.number,
        checkId: /^[a-zA-Z0-9_-]{1,64}$/.test(check.id) ? check.id : 'unknown',
        category,
      })
    }
  }
  return {
    version: 1,
    ending: /cloud runner restarted/i.test(errorText ?? '')
      ? 'runner_restarted'
      : ending,
    ...(steps &&
    sponsoredUserVerificationPending(steps) &&
    ['completed', 'closed', 'stopped', 'interrupted'].includes(ending) &&
    !/cloud runner restarted/i.test(errorText ?? '')
      ? { verificationPending: true as const }
      : {}),
    ...(steps?.preflight?.length ||
    steps?.steps.some((step) => step.checks.length)
      ? { checksRecorded: true as const }
      : {}),
    checks: checks.slice(0, SPONSORED_EVIDENCE_CHECK_LIMIT),
    ...(checks.length > SPONSORED_EVIDENCE_CHECK_LIMIT
      ? { truncated: true }
      : {}),
  }
}
