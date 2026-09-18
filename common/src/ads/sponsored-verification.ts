/**
 * Independent verification of a sponsored run against a frozen acceptance
 * contract (COD-597).
 *
 * Deterministic reduction lives here so Desktop, Cloud, and tests cannot
 * disagree on what success means. An executor claiming "done", a commit, a
 * PR, or prompt injection in source is never enough. Legacy
 * {@link ./sponsored-run-outcomes.ts} results are LIMITED evidence for
 * `legacy_outcome` checks — they do not prove a live integration.
 *
 * Dependency-free: callers hand in artifacts; this module never reads a
 * repo, never bills, and never emits advertiser postbacks.
 */

import { verifyOutcomes, type SponsoredDiffFile } from './sponsored-run-outcomes'
import {
  acceptanceCriteriaSha256,
  type AcceptanceCriteriaContract,
  type AcceptanceCriterion,
  type AcceptanceEvidenceMethod,
} from './sponsored-acceptance-criteria'

export const SPONSORED_VERIFIER_VERSION = 'sponsored-verifier/1'
export const SPONSORED_VERIFICATION_RUBRIC_VERSION = 'acceptance-criteria/1'

export const VERIFICATION_ATTEMPT_LIFECYCLES = [
  'queued',
  'running',
  'terminal',
] as const
export type VerificationAttemptLifecycle =
  (typeof VERIFICATION_ATTEMPT_LIFECYCLES)[number]

export const VERIFICATION_ATTEMPT_KINDS = ['initial', 'recheck'] as const
export type VerificationAttemptKind = (typeof VERIFICATION_ATTEMPT_KINDS)[number]

export const CRITERION_VERDICTS = ['pass', 'fail', 'unknown'] as const
export type CriterionVerdict = (typeof CRITERION_VERDICTS)[number]

export const OVERALL_VERDICTS = ['success', 'failed', 'inconclusive'] as const
export type OverallVerificationVerdict = (typeof OVERALL_VERDICTS)[number]

export const USER_FACING_VERDICTS = [
  'pending',
  'success',
  'failed',
  'setup_needed',
  'code_ready',
  'couldnt_verify',
] as const
export type UserFacingVerificationVerdict =
  (typeof USER_FACING_VERDICTS)[number]

export const CRITERION_REASON_CODES = [
  'matched',
  'unmet',
  'missing_evidence',
  'unsupported_check',
  'access_unavailable',
  'timeout',
  'malformed_output',
  'budget_exhausted',
  'no_rubric',
  'awaiting_setup',
  'placeholder_credentials',
  'stale_revision',
  'executor_claim_rejected',
  'injection_ignored',
  'cross_run_rejected',
] as const
export type CriterionReasonCode = (typeof CRITERION_REASON_CODES)[number]

export const EVIDENCE_PROVENANCES = [
  'locally_observed',
  'server_observed',
  'partner_reported',
] as const
export type EvidenceProvenance = (typeof EVIDENCE_PROVENANCES)[number]

export type CriterionEvidence = {
  criterionId: string
  method: AcceptanceEvidenceMethod
  provenance: EvidenceProvenance
  observedAt: number
  artifactDigest?: string
  baseRevision?: string
  headRevision?: string
  /** Sanitized. Never secrets, private source, tokens, or env values. */
  summary: string
  /** Paths or event ids — never file contents. */
  refs: string[]
}

export type CriterionResult = {
  criterionId: string
  title: string
  phase: AcceptanceCriterion['phase']
  required: boolean
  verdict: CriterionVerdict
  reasonCode: CriterionReasonCode
  explanation: string
  evidence: CriterionEvidence[]
}

export type VerificationReduction = {
  overall: OverallVerificationVerdict
  userFacing: UserFacingVerificationVerdict
  stale: boolean
  codeReadySatisfied: boolean
  liveSetupSatisfied: boolean | null
  requiredFailedIds: string[]
  requiredUnknownIds: string[]
  missing: string[]
}

export type LiveProbeResult = {
  probeId: string
  observedAt: number
  provenance: EvidenceProvenance
  outcome: 'authenticated' | 'unauthenticated' | 'unavailable'
  digest?: string
}

export type PartnerEvidenceInput = {
  eventType: string
  attributionId: string
  proposalId: string
  campaignId?: string
  observedAt: number
  authenticated: boolean
}

export type ControlledTestReceipt = {
  testId: string
  observedAt: number
  provenance: EvidenceProvenance
  passed: boolean
  digest: string
}

export type VerificationArtifacts = {
  proposalId: string
  runId?: string
  campaignId?: string
  contract: AcceptanceCriteriaContract | null
  contractHash?: string | null
  baseRevision?: string
  headRevision?: string
  /** Current target revision. A mismatch with head marks the result stale. */
  currentRevision?: string
  diff?: readonly SponsoredDiffFile[]
  declaredOutcomes?: readonly string[]
  /** COD-515 proof — limited evidence for legacy_outcome only. */
  verifiedOutcomes?: readonly string[]
  executorClaimedDone?: boolean
  executorLogs?: readonly string[]
  procedureText?: string
  liveProbes?: readonly LiveProbeResult[]
  partnerEvidence?: readonly PartnerEvidenceInput[]
  controlledTests?: readonly ControlledTestReceipt[]
  budgetExhausted?: boolean
  timeout?: boolean
  malformedAgentOutput?: boolean
  accessUnavailable?: boolean
  verifierCrash?: boolean
  observedAt?: number
}

const PLACEHOLDER_CREDENTIAL =
  /(?:your[-_ ]?(?:api[-_ ]?key|token|secret|anon[-_ ]?key)|changeme|todo|xxx+|placeholder|<[^>]+>|example\.com|xxxx)/i

const SECRET_LIKE =
  /(?:api[_-]?key|token|secret|password|bearer|authorization)\s*[:=]\s*\S+/gi

const INJECTION_MARKERS =
  /(?:ignore (?:all )?(?:previous|prior) instructions|you are now|system prompt|jailbreak)/i

export function sponsoredVerificationEnabled(env: unknown): boolean {
  if (env === 'on') return true
  if (!env || typeof env !== 'object') return false
  return (
    (env as { FREEBUFF_SPONSORED_VERIFICATION?: unknown })
      .FREEBUFF_SPONSORED_VERIFICATION === 'on'
  )
}

export function sanitizeVerificationText(text: string): string {
  return text
    .replace(SECRET_LIKE, '[redacted]')
    .replace(
      /\b(?:sk|rk|tok|key|secret)_[A-Za-z0-9_-]{8,}\b/g,
      '[redacted]',
    )
    .replace(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, '[redacted]')
    .slice(0, 280)
}

export function advertiserSafeEvidence(
  evidence: CriterionEvidence,
): CriterionEvidence {
  return {
    criterionId: evidence.criterionId,
    method: evidence.method,
    provenance: evidence.provenance,
    observedAt: evidence.observedAt,
    ...(evidence.artifactDigest
      ? { artifactDigest: evidence.artifactDigest }
      : {}),
    ...(evidence.baseRevision ? { baseRevision: evidence.baseRevision } : {}),
    ...(evidence.headRevision ? { headRevision: evidence.headRevision } : {}),
    summary: sanitizeVerificationText(evidence.summary),
    refs: evidence.refs
      .filter((ref) => {
        const base = ref.slice(ref.lastIndexOf('/') + 1)
        return base !== '.env' && !base.startsWith('.env.')
      })
      .slice(0, 8),
  }
}

export function advertiserSafeCriterionResult(
  result: CriterionResult,
): CriterionResult {
  return {
    ...result,
    explanation: sanitizeVerificationText(result.explanation),
    evidence: result.evidence.map(advertiserSafeEvidence),
  }
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `^${escaped.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')}$`,
  )
}

function matchingFiles(
  diff: readonly SponsoredDiffFile[],
  pathPattern: string,
): SponsoredDiffFile[] {
  const matcher = globToRegExp(pathPattern)
  return diff.filter((file) => matcher.test(file.path))
}

function digestRefs(paths: readonly string[]): string {
  return shaLike(paths.slice().sort().join('|'))
}

function shaLike(text: string): string {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function evidenceFor(
  criterion: AcceptanceCriterion,
  artifacts: VerificationArtifacts,
  summary: string,
  refs: string[],
  provenance: EvidenceProvenance,
): CriterionEvidence {
  return {
    criterionId: criterion.id,
    method: criterion.evidenceMethod,
    provenance,
    observedAt: artifacts.observedAt ?? 0,
    artifactDigest: refs.length > 0 ? digestRefs(refs) : undefined,
    ...(artifacts.baseRevision
      ? { baseRevision: artifacts.baseRevision }
      : {}),
    ...(artifacts.headRevision
      ? { headRevision: artifacts.headRevision }
      : {}),
    summary: sanitizeVerificationText(summary),
    refs,
  }
}

function result(
  criterion: AcceptanceCriterion,
  verdict: CriterionVerdict,
  reasonCode: CriterionReasonCode,
  explanation: string,
  evidence: CriterionEvidence[],
): CriterionResult {
  return {
    criterionId: criterion.id,
    title: criterion.title,
    phase: criterion.phase,
    required: criterion.required,
    verdict,
    reasonCode,
    explanation: sanitizeVerificationText(explanation),
    evidence,
  }
}

function evaluateCriterion(
  criterion: AcceptanceCriterion,
  artifacts: VerificationArtifacts,
): CriterionResult {
  if (artifacts.budgetExhausted) {
    return result(
      criterion,
      'unknown',
      'budget_exhausted',
      'Verification budget was exhausted before this check ran.',
      [],
    )
  }
  if (artifacts.timeout) {
    return result(
      criterion,
      'unknown',
      'timeout',
      'The verifier timed out before this check completed.',
      [],
    )
  }
  if (artifacts.verifierCrash || artifacts.malformedAgentOutput) {
    return result(
      criterion,
      'unknown',
      'malformed_output',
      'The verifier did not produce a usable result. This is not a failure of the integration.',
      [],
    )
  }
  if (artifacts.accessUnavailable) {
    return result(
      criterion,
      'unknown',
      'access_unavailable',
      'The verifier could not reach the artifacts or live service it needed.',
      [],
    )
  }

  const untrusted = [
    artifacts.procedureText ?? '',
    ...(artifacts.executorLogs ?? []),
  ].join('\n')
  const injection = INJECTION_MARKERS.test(untrusted)
  const claimed = artifacts.executorClaimedDone === true

  const check = criterion.check
  if (check.kind === 'unsupported') {
    return result(
      criterion,
      'unknown',
      'unsupported_check',
      check.reason ||
        'This platform has no approved observable for this criterion.',
      [],
    )
  }

  if (check.kind === 'path_added' || check.kind === 'content_added') {
    const diff = artifacts.diff
    if (!diff) {
      return result(
        criterion,
        'unknown',
        'missing_evidence',
        'No committed diff was available to check this code-ready criterion.',
        [],
      )
    }
    const files = matchingFiles(diff, check.pathPattern)
    if (files.length === 0) {
      return result(
        criterion,
        'fail',
        'unmet',
        `No committed file matched ${check.pathPattern}. A finished run is not enough.`,
        [
          evidenceFor(
            criterion,
            artifacts,
            `Looked for ${check.pathPattern} in the committed diff.`,
            [],
            'locally_observed',
          ),
        ],
      )
    }
    if (check.kind === 'content_added') {
      const hits = files.filter((file) => file.addedText.includes(check.pattern))
      if (hits.length === 0) {
        return result(
          criterion,
          'fail',
          'unmet',
          `Committed files matched the path but not the expected content.`,
          [
            evidenceFor(
              criterion,
              artifacts,
              `Checked added lines in ${files.length} file(s).`,
              files.map((file) => file.path),
              'locally_observed',
            ),
          ],
        )
      }
      return result(
        criterion,
        'pass',
        'matched',
        `Committed diff added the expected content in ${hits.map((file) => file.path).join(', ')}.`,
        [
          evidenceFor(
            criterion,
            artifacts,
            'Committed added lines matched the reviewed pattern.',
            hits.map((file) => file.path),
            'locally_observed',
          ),
        ],
      )
    }
    return result(
      criterion,
      'pass',
      'matched',
      `Committed diff added ${files.map((file) => file.path).join(', ')}.`,
      [
        evidenceFor(
          criterion,
          artifacts,
          'Committed path was added.',
          files.map((file) => file.path),
          'locally_observed',
        ),
      ],
    )
  }

  if (check.kind === 'config_key_declared') {
    const diff = artifacts.diff
    if (!diff) {
      return result(
        criterion,
        'unknown',
        'missing_evidence',
        'No committed diff was available to check the configuration declaration.',
        [],
      )
    }
    const files = matchingFiles(diff, check.pathPattern).filter((file) =>
      file.addedText.includes(check.keyPattern),
    )
    if (files.length === 0) {
      return result(
        criterion,
        'fail',
        'unmet',
        `No configuration file declared ${check.keyPattern}.`,
        [],
      )
    }
    const placeholders = files.some((file) =>
      PLACEHOLDER_CREDENTIAL.test(file.addedText),
    )
    return result(
      criterion,
      'pass',
      placeholders ? 'placeholder_credentials' : 'matched',
      placeholders
        ? `Configuration declared ${check.keyPattern} with placeholder values. That is not live authentication.`
        : `Configuration declared ${check.keyPattern}.`,
      [
        evidenceFor(
          criterion,
          artifacts,
          placeholders
            ? 'Config key present; values look like placeholders.'
            : 'Config key present in committed example files.',
          files.map((file) => file.path),
          'locally_observed',
        ),
      ],
    )
  }

  if (check.kind === 'legacy_outcome') {
    const declared = artifacts.declaredOutcomes ?? []
    if (!declared.includes(check.outcome)) {
      return result(
        criterion,
        'unknown',
        'unsupported_check',
        `The frozen procedure did not declare ${check.outcome}.`,
        [],
      )
    }
    const diff = artifacts.diff
    const fromDiff =
      diff &&
      verifyOutcomes(diff, [check.outcome]).some(
        (entry) => entry.outcome === check.outcome,
      )
    const fromRecorded = artifacts.verifiedOutcomes?.includes(check.outcome)
    if (fromDiff || fromRecorded) {
      const files =
        diff &&
        verifyOutcomes(diff, [check.outcome]).find(
          (entry) => entry.outcome === check.outcome,
        )?.files
      return result(
        criterion,
        'pass',
        'matched',
        `The committed diff proved the declared ${check.outcome} outcome.`,
        [
          evidenceFor(
            criterion,
            artifacts,
            'Legacy declared+diff outcome matched.',
            files ?? [check.outcome],
            'locally_observed',
          ),
        ],
      )
    }
    if (!diff && !artifacts.verifiedOutcomes) {
      return result(
        criterion,
        'unknown',
        'missing_evidence',
        'No committed diff or recorded outcome proof was available.',
        [],
      )
    }
    return result(
      criterion,
      'fail',
      'unmet',
      `Declared ${check.outcome} was not proved by the committed diff.`,
      [],
    )
  }

  if (check.kind === 'live_auth') {
    const probes = (artifacts.liveProbes ?? []).filter(
      (probe) => probe.probeId === check.probeId,
    )
    if (probes.length === 0) {
      return result(
        criterion,
        'unknown',
        'awaiting_setup',
        'No approved live probe has observed this account yet. A config diff cannot prove authentication.',
        [
          evidenceFor(
            criterion,
            artifacts,
            'Live authentication still needs an approved probe.',
            [],
            'locally_observed',
          ),
        ],
      )
    }
    const latest = probes[probes.length - 1]!
    if (latest.outcome === 'unavailable') {
      return result(
        criterion,
        'unknown',
        'access_unavailable',
        'The approved live probe could not reach the service.',
        [
          evidenceFor(
            criterion,
            artifacts,
            'Live probe was unavailable.',
            [check.probeId],
            latest.provenance,
          ),
        ],
      )
    }
    if (latest.outcome === 'unauthenticated') {
      return result(
        criterion,
        'fail',
        'unmet',
        'The approved live probe observed no authenticated session.',
        [
          evidenceFor(
            criterion,
            artifacts,
            'Live probe reported unauthenticated.',
            [check.probeId],
            latest.provenance,
          ),
        ],
      )
    }
    return result(
      criterion,
      'pass',
      'matched',
      'An approved live probe observed an authenticated session.',
      [
        evidenceFor(
          criterion,
          artifacts,
          'Approved live probe authenticated.',
          [check.probeId],
          latest.provenance,
        ),
      ],
    )
  }

  if (check.kind === 'partner_event') {
    const events = (artifacts.partnerEvidence ?? []).filter(
      (event) => event.eventType === check.eventType,
    )
    if (events.some((event) => event.proposalId !== artifacts.proposalId)) {
      return result(
        criterion,
        'unknown',
        'cross_run_rejected',
        'Partner evidence named a different proposal and was ignored.',
        [],
      )
    }
    if (
      artifacts.campaignId &&
      events.some(
        (event) =>
          event.campaignId && event.campaignId !== artifacts.campaignId,
      )
    ) {
      return result(
        criterion,
        'unknown',
        'cross_run_rejected',
        'Partner evidence named a different campaign and was ignored.',
        [],
      )
    }
    const attributed = events.filter(
      (event) =>
        event.authenticated && event.proposalId === artifacts.proposalId,
    )
    if (attributed.length === 0) {
      return result(
        criterion,
        'unknown',
        'awaiting_setup',
        'No authenticated partner evidence is attributed to this run yet.',
        [],
      )
    }
    const latest = attributed[attributed.length - 1]!
    return result(
      criterion,
      'pass',
      'matched',
      `Partner-reported ${check.eventType} is attributed to this run.`,
      [
        evidenceFor(
          criterion,
          artifacts,
          'Authenticated partner evidence matched this proposal.',
          [latest.attributionId],
          'partner_reported',
        ),
      ],
    )
  }

  if (claimed || injection) {
    return result(
      criterion,
      'unknown',
      injection ? 'injection_ignored' : 'executor_claim_rejected',
      injection
        ? 'Untrusted source or logs tried to change the rubric. They were ignored.'
        : 'The executor claiming the work is done is not evidence.',
      [],
    )
  }

  return result(
    criterion,
    'unknown',
    'unsupported_check',
    'This check is not supported on this surface.',
    [],
  )
}

export function reduceVerification(
  contract: AcceptanceCriteriaContract | null,
  results: readonly CriterionResult[],
  options: { stale?: boolean; lifecycle?: VerificationAttemptLifecycle } = {},
): VerificationReduction {
  if (options.lifecycle === 'queued' || options.lifecycle === 'running') {
    return {
      overall: 'inconclusive',
      userFacing: 'pending',
      stale: options.stale === true,
      codeReadySatisfied: false,
      liveSetupSatisfied: null,
      requiredFailedIds: [],
      requiredUnknownIds: [],
      missing: ['Verification has not finished.'],
    }
  }
  if (!contract) {
    return {
      overall: 'inconclusive',
      userFacing: 'couldnt_verify',
      stale: options.stale === true,
      codeReadySatisfied: false,
      liveSetupSatisfied: null,
      requiredFailedIds: [],
      requiredUnknownIds: [],
      missing: ['This run has no frozen acceptance-criteria contract.'],
    }
  }

  const byId = new Map(results.map((entry) => [entry.criterionId, entry]))
  const required = contract.criteria.filter((criterion) => criterion.required)
  const requiredFailedIds = required
    .filter((criterion) => byId.get(criterion.id)?.verdict === 'fail')
    .map((criterion) => criterion.id)
  const requiredUnknownIds = required
    .filter((criterion) => {
      const verdict = byId.get(criterion.id)?.verdict
      return verdict !== 'pass' && verdict !== 'fail'
    })
    .map((criterion) => criterion.id)

  const codeReadyRequired = required.filter(
    (criterion) => criterion.phase === 'code-ready',
  )
  const liveRequired = required.filter(
    (criterion) => criterion.phase === 'live-setup',
  )
  const codeReadySatisfied =
    codeReadyRequired.length > 0 &&
    codeReadyRequired.every((criterion) => byId.get(criterion.id)?.verdict === 'pass')
  const liveSetupSatisfied =
    liveRequired.length === 0
      ? null
      : liveRequired.every((criterion) => byId.get(criterion.id)?.verdict === 'pass')

  const missing: string[] = []
  for (const id of requiredUnknownIds) {
    const entry = byId.get(id)
    missing.push(
      entry
        ? `${entry.title}: ${entry.explanation}`
        : `Missing result for ${id}.`,
    )
  }

  if (requiredFailedIds.length > 0) {
    return {
      overall: 'failed',
      userFacing: 'failed',
      stale: options.stale === true,
      codeReadySatisfied,
      liveSetupSatisfied,
      requiredFailedIds,
      requiredUnknownIds,
      missing,
    }
  }
  if (requiredUnknownIds.length === 0 && required.length > 0) {
    return {
      overall: 'success',
      userFacing: 'success',
      stale: options.stale === true,
      codeReadySatisfied,
      liveSetupSatisfied: liveSetupSatisfied ?? true,
      requiredFailedIds,
      requiredUnknownIds,
      missing,
    }
  }
  if (
    codeReadySatisfied &&
    liveRequired.length > 0 &&
    liveRequired.every((criterion) => {
      const verdict = byId.get(criterion.id)?.verdict
      const reason = byId.get(criterion.id)?.reasonCode
      return verdict !== 'fail' && (verdict !== 'pass' || reason === 'awaiting_setup')
    }) &&
    liveRequired.some(
      (criterion) => byId.get(criterion.id)?.verdict !== 'pass',
    )
  ) {
    return {
      overall: 'inconclusive',
      userFacing: 'setup_needed',
      stale: options.stale === true,
      codeReadySatisfied: true,
      liveSetupSatisfied: false,
      requiredFailedIds,
      requiredUnknownIds,
      missing:
        missing.length > 0
          ? missing
          : ['Create or connect the account, then verify again.'],
    }
  }
  if (codeReadySatisfied && liveRequired.length === 0) {
    return {
      overall: required.length === 0 ? 'inconclusive' : 'success',
      userFacing: required.length === 0 ? 'code_ready' : 'success',
      stale: options.stale === true,
      codeReadySatisfied: true,
      liveSetupSatisfied: null,
      requiredFailedIds,
      requiredUnknownIds,
      missing,
    }
  }
  if (codeReadySatisfied) {
    return {
      overall: 'inconclusive',
      userFacing: 'code_ready',
      stale: options.stale === true,
      codeReadySatisfied: true,
      liveSetupSatisfied: false,
      requiredFailedIds,
      requiredUnknownIds,
      missing,
    }
  }

  return {
    overall: 'inconclusive',
    userFacing: 'couldnt_verify',
    stale: options.stale === true,
    codeReadySatisfied,
    liveSetupSatisfied,
    requiredFailedIds,
    requiredUnknownIds,
    missing:
      missing.length > 0
        ? missing
        : ['Verification could not reach a definitive result.'],
  }
}

export type VerificationEvaluation = {
  verifierVersion: typeof SPONSORED_VERIFIER_VERSION
  rubricVersion: typeof SPONSORED_VERIFICATION_RUBRIC_VERSION
  contractHash: string | null
  targetRevision: string | null
  stale: boolean
  results: CriterionResult[]
  reduction: VerificationReduction
}

export function evaluateAcceptanceCriteria(
  artifacts: VerificationArtifacts,
): VerificationEvaluation {
  const contract = artifacts.contract
  const expectedHash = contract ? acceptanceCriteriaSha256(contract) : null
  const suppliedHash = artifacts.contractHash ?? null
  const hashMismatch =
    Boolean(contract) &&
    Boolean(suppliedHash) &&
    suppliedHash !== expectedHash
  const stale =
    Boolean(artifacts.headRevision) &&
    Boolean(artifacts.currentRevision) &&
    artifacts.headRevision !== artifacts.currentRevision

  if (!contract) {
    const reduction = reduceVerification(null, [], { stale })
    return {
      verifierVersion: SPONSORED_VERIFIER_VERSION,
      rubricVersion: SPONSORED_VERIFICATION_RUBRIC_VERSION,
      contractHash: null,
      targetRevision: artifacts.headRevision ?? artifacts.currentRevision ?? null,
      stale,
      results: [],
      reduction,
    }
  }

  if (hashMismatch) {
    const reduction = reduceVerification(contract, [], { stale })
    return {
      verifierVersion: SPONSORED_VERIFIER_VERSION,
      rubricVersion: SPONSORED_VERIFICATION_RUBRIC_VERSION,
      contractHash: expectedHash,
      targetRevision: artifacts.headRevision ?? null,
      stale,
      results: contract.criteria.map((criterion) =>
        result(
          criterion,
          'unknown',
          'no_rubric',
          'The supplied contract hash does not match the frozen rubric.',
          [],
        ),
      ),
      reduction: {
        ...reduction,
        overall: 'inconclusive',
        userFacing: 'couldnt_verify',
        missing: ['The frozen rubric hash did not match this contract.'],
      },
    }
  }

  const results = contract.criteria.map((criterion) =>
    evaluateCriterion(criterion, artifacts),
  )
  const reduction = reduceVerification(contract, results, { stale })
  return {
    verifierVersion: SPONSORED_VERIFIER_VERSION,
    rubricVersion: SPONSORED_VERIFICATION_RUBRIC_VERSION,
    contractHash: expectedHash,
    targetRevision: artifacts.headRevision ?? artifacts.currentRevision ?? null,
    stale,
    results,
    reduction: stale
      ? {
          ...reduction,
          stale: true,
          userFacing:
            reduction.userFacing === 'success'
              ? 'couldnt_verify'
              : reduction.userFacing,
          missing: [
            ...reduction.missing,
            'This result is bound to a previous revision and is no longer current.',
          ],
        }
      : reduction,
  }
}

/**
 * Latest-attempt rule: an older terminal attempt cannot replace a newer one.
 * Rechecks increment sequence; duplicate completions reuse the same sequence.
 */
export function shouldApplyAttemptResult(args: {
  incomingSequence: number
  storedSequence: number | null
}): boolean {
  if (args.storedSequence === null) return true
  return args.incomingSequence >= args.storedSequence
}

export function verificationIdempotencyKey(args: {
  proposalId: string
  kind: VerificationAttemptKind
  targetRevision: string | null
  completionEventId?: string | null
  recheckId?: string | null
}): string {
  if (args.kind === 'recheck') {
    return [args.proposalId, 'recheck', args.recheckId ?? ''].join(':')
  }
  return initialVerificationIdempotencyKey(args)
}

export function initialVerificationIdempotencyKey(args: {
  proposalId: string
  targetRevision: string | null
  completionEventId?: string | null
}): string {
  return [
    args.proposalId,
    'initial',
    args.targetRevision ?? '',
    args.completionEventId ?? 'terminal',
  ].join(':')
}
