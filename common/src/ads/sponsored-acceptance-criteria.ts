/**
 * Versioned acceptance-criteria contract for sponsored (agentic) ads (COD-597).
 *
 * This is the SUCCESS CONTRACT a reviewer approves: what must be true after a
 * run, independent of the executor finishing, committing, or opening a PR.
 * It is parsed and hashed here so campaign review, Accept consent, the
 * Desktop/Cloud verifiers, and the task UI cannot invent different rubrics.
 *
 * Dependency-free on purpose — same constraint as
 * {@link ./sponsored-run-outcomes.ts}: Next, Convex V8, and Desktop all import
 * this. Nothing here reads a file, talks to a model, or sees a secret.
 *
 * An LLM must never invent these requirements after execution. Legacy
 * proposals/campaigns with no contract are explicitly not verifiable.
 */

import { sha256Hex } from '../util/hash'

export const ACCEPTANCE_CRITERIA_CONTRACT_VERSION = 1 as const

export const ACCEPTANCE_CRITERIA_PHASES = ['code-ready', 'live-setup'] as const
export type AcceptanceCriteriaPhase = (typeof ACCEPTANCE_CRITERIA_PHASES)[number]

/**
 * How a criterion may be observed. A configuration diff is never live
 * authentication; a partner event is never locally attested.
 */
export const ACCEPTANCE_EVIDENCE_METHODS = [
  /** Added paths/content in the committed diff. */
  'committed_diff',
  /** A file at the bound head revision, by digest — not executor logs. */
  'committed_artifact',
  /** COD-515 declared+diff outcomes, reused as LIMITED evidence. */
  'legacy_outcome',
  /** Env/config declaration. Placeholders may pass this and MUST NOT pass live. */
  'configuration',
  /** A controlled test receipt produced by our runner, not the advertiser. */
  'controlled_test',
  /** An approved observable probe. Unsupported probes stay unknown. */
  'live_probe',
  /** Authenticated, correctly attributed partner-reported evidence. */
  'partner_evidence',
] as const
export type AcceptanceEvidenceMethod =
  (typeof ACCEPTANCE_EVIDENCE_METHODS)[number]

export const ACCEPTANCE_CHECK_KINDS = [
  'path_added',
  'content_added',
  'legacy_outcome',
  'config_key_declared',
  'live_auth',
  'partner_event',
  'unsupported',
] as const
export type AcceptanceCheckKind = (typeof ACCEPTANCE_CHECK_KINDS)[number]

export type AcceptanceCriterionCheck =
  | { kind: 'path_added'; pathPattern: string }
  | { kind: 'content_added'; pathPattern: string; pattern: string }
  | { kind: 'legacy_outcome'; outcome: 'api_key_issued' | 'mcp_installed' }
  | { kind: 'config_key_declared'; pathPattern: string; keyPattern: string }
  | { kind: 'live_auth'; probeId: string }
  | { kind: 'partner_event'; eventType: string }
  | { kind: 'unsupported'; reason?: string }

export type AcceptanceCriterion = {
  /** Stable slug. Campaign edits may not reuse an id for a different check. */
  id: string
  title: string
  /** Checkable expected result — prose the verifier can match evidence against. */
  expected: string
  required: boolean
  phase: AcceptanceCriteriaPhase
  evidenceMethod: AcceptanceEvidenceMethod
  check: AcceptanceCriterionCheck
}

export type AcceptanceCriteriaContract = {
  version: typeof ACCEPTANCE_CRITERIA_CONTRACT_VERSION
  criteria: AcceptanceCriterion[]
}

export const MAX_ACCEPTANCE_CRITERIA = 16
export const MAX_CRITERION_ID_CHARS = 64
export const MAX_CRITERION_TITLE_CHARS = 120
export const MAX_CRITERION_EXPECTED_CHARS = 400
export const MAX_CRITERION_PATTERN_CHARS = 200

const CRITERION_ID = /^[a-z][a-z0-9_-]{0,63}$/

export type AcceptanceCriteriaParseError = {
  path: string
  message: string
}

export type AcceptanceCriteriaParseResult =
  | { ok: true; contract: AcceptanceCriteriaContract }
  | { ok: false; errors: AcceptanceCriteriaParseError[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPhase(value: unknown): value is AcceptanceCriteriaPhase {
  return (
    typeof value === 'string' &&
    (ACCEPTANCE_CRITERIA_PHASES as readonly string[]).includes(value)
  )
}

function isMethod(value: unknown): value is AcceptanceEvidenceMethod {
  return (
    typeof value === 'string' &&
    (ACCEPTANCE_EVIDENCE_METHODS as readonly string[]).includes(value)
  )
}

function methodForCheck(kind: AcceptanceCheckKind): AcceptanceEvidenceMethod {
  switch (kind) {
    case 'path_added':
    case 'content_added':
      return 'committed_diff'
    case 'legacy_outcome':
      return 'legacy_outcome'
    case 'config_key_declared':
      return 'configuration'
    case 'live_auth':
      return 'live_probe'
    case 'partner_event':
      return 'partner_evidence'
    case 'unsupported':
      return 'controlled_test'
  }
}

function parseCheck(
  value: unknown,
  path: string,
  errors: AcceptanceCriteriaParseError[],
): AcceptanceCriterionCheck | null {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    errors.push({ path, message: 'Each criterion needs a check kind.' })
    return null
  }
  const kind = value.kind
  const text = (key: string) =>
    typeof value[key] === 'string' ? value[key].trim() : ''

  if (kind === 'path_added') {
    const pathPattern = text('pathPattern')
    if (!pathPattern || pathPattern.length > MAX_CRITERION_PATTERN_CHARS) {
      errors.push({
        path: `${path}.pathPattern`,
        message: 'path_added needs a path pattern.',
      })
      return null
    }
    return { kind, pathPattern }
  }
  if (kind === 'content_added') {
    const pathPattern = text('pathPattern')
    const pattern = text('pattern')
    if (
      !pathPattern ||
      !pattern ||
      pathPattern.length > MAX_CRITERION_PATTERN_CHARS ||
      pattern.length > MAX_CRITERION_PATTERN_CHARS
    ) {
      errors.push({
        path: `${path}`,
        message: 'content_added needs a path pattern and a content pattern.',
      })
      return null
    }
    return { kind, pathPattern, pattern }
  }
  if (kind === 'legacy_outcome') {
    const outcome = text('outcome')
    if (outcome !== 'api_key_issued' && outcome !== 'mcp_installed') {
      errors.push({
        path: `${path}.outcome`,
        message: 'legacy_outcome must be api_key_issued or mcp_installed.',
      })
      return null
    }
    return { kind, outcome }
  }
  if (kind === 'config_key_declared') {
    const pathPattern = text('pathPattern')
    const keyPattern = text('keyPattern')
    if (
      !pathPattern ||
      !keyPattern ||
      pathPattern.length > MAX_CRITERION_PATTERN_CHARS ||
      keyPattern.length > MAX_CRITERION_PATTERN_CHARS
    ) {
      errors.push({
        path: `${path}`,
        message: 'config_key_declared needs a path pattern and a key pattern.',
      })
      return null
    }
    return { kind, pathPattern, keyPattern }
  }
  if (kind === 'live_auth') {
    const probeId = text('probeId')
    if (!probeId || !CRITERION_ID.test(probeId)) {
      errors.push({
        path: `${path}.probeId`,
        message: 'live_auth needs an approved probe id.',
      })
      return null
    }
    return { kind, probeId }
  }
  if (kind === 'partner_event') {
    const eventType = text('eventType')
    if (!eventType || eventType.length > MAX_CRITERION_ID_CHARS) {
      errors.push({
        path: `${path}.eventType`,
        message: 'partner_event needs an event type.',
      })
      return null
    }
    return { kind, eventType }
  }
  if (kind === 'unsupported') {
    const reason = text('reason')
    return reason ? { kind, reason } : { kind }
  }
  errors.push({ path: `${path}.kind`, message: `Unknown check kind "${kind}".` })
  return null
}

/**
 * Parse a campaign- or proposal-stored contract.
 *
 * `null` / `undefined` is the legacy "no rubric" case — not an error.
 * A present empty or malformed value is an error: that is a NEW contract
 * that failed review, not a historical row.
 */
export function parseAcceptanceCriteriaContract(
  value: unknown,
): AcceptanceCriteriaParseResult {
  if (value === null || value === undefined) {
    return {
      ok: false,
      errors: [
        {
          path: '',
          message: 'No acceptance-criteria contract is stored.',
        },
      ],
    }
  }
  if (!isRecord(value)) {
    return {
      ok: false,
      errors: [{ path: '', message: 'Acceptance criteria must be an object.' }],
    }
  }
  const errors: AcceptanceCriteriaParseError[] = []
  if (value.version !== ACCEPTANCE_CRITERIA_CONTRACT_VERSION) {
    errors.push({
      path: 'version',
      message: `Unsupported contract version ${String(value.version)}.`,
    })
  }
  if (!Array.isArray(value.criteria)) {
    errors.push({ path: 'criteria', message: 'Criteria must be an array.' })
    return { ok: false, errors }
  }
  if (value.criteria.length === 0) {
    errors.push({
      path: 'criteria',
      message: 'A new acceptance-criteria contract cannot be empty.',
    })
  }
  if (value.criteria.length > MAX_ACCEPTANCE_CRITERIA) {
    errors.push({
      path: 'criteria',
      message: `At most ${MAX_ACCEPTANCE_CRITERIA} criteria.`,
    })
  }

  const ids = new Set<string>()
  const criteria: AcceptanceCriterion[] = []
  for (const [index, raw] of value.criteria.entries()) {
    const path = `criteria[${index}]`
    if (!isRecord(raw)) {
      errors.push({ path, message: 'Criterion must be an object.' })
      continue
    }
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (!CRITERION_ID.test(id)) {
      errors.push({
        path: `${path}.id`,
        message: 'Criterion id must be a lowercase slug.',
      })
    } else if (ids.has(id)) {
      errors.push({ path: `${path}.id`, message: `Duplicate criterion id "${id}".` })
    } else {
      ids.add(id)
    }
    const title = typeof raw.title === 'string' ? raw.title.trim() : ''
    if (!title || title.length > MAX_CRITERION_TITLE_CHARS) {
      errors.push({ path: `${path}.title`, message: 'Criterion needs a title.' })
    }
    const expected = typeof raw.expected === 'string' ? raw.expected.trim() : ''
    if (!expected || expected.length > MAX_CRITERION_EXPECTED_CHARS) {
      errors.push({
        path: `${path}.expected`,
        message: 'Criterion needs a checkable expected result.',
      })
    }
    if (typeof raw.required !== 'boolean') {
      errors.push({
        path: `${path}.required`,
        message: 'Criterion required must be true or false.',
      })
    }
    if (!isPhase(raw.phase)) {
      errors.push({
        path: `${path}.phase`,
        message: 'Criterion phase must be code-ready or live-setup.',
      })
    }
    if (!isMethod(raw.evidenceMethod)) {
      errors.push({
        path: `${path}.evidenceMethod`,
        message: 'Criterion evidence method is not supported.',
      })
    }
    const check = parseCheck(raw.check, `${path}.check`, errors)
    if (
      check &&
      isMethod(raw.evidenceMethod) &&
      methodForCheck(check.kind) !== raw.evidenceMethod &&
      check.kind !== 'unsupported'
    ) {
      errors.push({
        path: `${path}.evidenceMethod`,
        message: `evidenceMethod ${raw.evidenceMethod} does not match check ${check.kind}.`,
      })
    }
    if (
      check?.kind === 'live_auth' &&
      raw.phase === 'code-ready'
    ) {
      errors.push({
        path: `${path}.phase`,
        message: 'live_auth criteria belong in the live-setup phase.',
      })
    }
    if (
      check &&
      id &&
      title &&
      expected &&
      typeof raw.required === 'boolean' &&
      isPhase(raw.phase) &&
      isMethod(raw.evidenceMethod)
    ) {
      criteria.push({
        id,
        title,
        expected,
        required: raw.required,
        phase: raw.phase,
        evidenceMethod: raw.evidenceMethod,
        check,
      })
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    contract: {
      version: ACCEPTANCE_CRITERIA_CONTRACT_VERSION,
      criteria,
    },
  }
}

const UNSUPPORTED_REVIEW_MESSAGE =
  'We cannot verify this check as written. Name a file, a config key, or say a live connection should succeed.'

/**
 * Review/consent input: absent is the legacy omit; present must parse as a
 * non-empty contract. Used at campaign review so a new empty `[]` cannot
 * sneak through as "no criteria".
 */
export function parseReviewAcceptanceCriteria(
  value: unknown,
):
  | { kind: 'legacy' }
  | { kind: 'contract'; contract: AcceptanceCriteriaContract }
  | { kind: 'invalid'; errors: AcceptanceCriteriaParseError[] } {
  if (value === null || value === undefined) return { kind: 'legacy' }
  const parsed = parseAcceptanceCriteriaContract(value)
  if (!parsed.ok) return { kind: 'invalid', errors: parsed.errors }
  const unsupported = parsed.contract.criteria.filter(
    (criterion) => criterion.check.kind === 'unsupported',
  )
  if (unsupported.length > 0) {
    return {
      kind: 'invalid',
      errors: unsupported.map((criterion) => ({
        path: criterion.id,
        message:
          (criterion.check.kind === 'unsupported' && criterion.check.reason) ||
          `“${criterion.title}” cannot be verified as written. ${UNSUPPORTED_REVIEW_MESSAGE}`,
      })),
    }
  }
  return { kind: 'contract', contract: parsed.contract }
}

/** Canonical JSON for hashing — key order is fixed so two equal contracts match. */
export function canonicalizeAcceptanceCriteriaContract(
  contract: AcceptanceCriteriaContract,
): string {
  const criteria = [...contract.criteria]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((criterion) => ({
      id: criterion.id,
      title: criterion.title,
      expected: criterion.expected,
      required: criterion.required,
      phase: criterion.phase,
      evidenceMethod: criterion.evidenceMethod,
      check: criterion.check,
    }))
  return JSON.stringify({
    version: contract.version,
    criteria,
  })
}

export function acceptanceCriteriaSha256(
  contract: AcceptanceCriteriaContract,
): string {
  return sha256Hex(canonicalizeAcceptanceCriteriaContract(contract))
}

export function summarizeAcceptanceCriteria(
  contract: AcceptanceCriteriaContract,
): Array<{
  id: string
  title: string
  required: boolean
  phase: AcceptanceCriteriaPhase
  expected: string
}> {
  return contract.criteria.map((criterion) => ({
    id: criterion.id,
    title: criterion.title,
    required: criterion.required,
    phase: criterion.phase,
    expected: criterion.expected,
  }))
}

/**
 * Advertiser-authored success checks. The platform maps these to evidence
 * methods; advertisers never write JSON, check kinds, or shell.
 */
export type AdvertiserSuccessCheckDraft = {
  id?: string
  title: string
  expected: string
  required?: boolean
}

export type MappedAdvertiserSuccessCheck = {
  criterion: AcceptanceCriterion
  supported: boolean
  confirmation: string
  feedback?: string
}

export const SUGGESTED_ADVERTISER_SUCCESS_CHECKS: ReadonlyArray<{
  title: string
  expected: string
}> = [
  { title: 'SDK is installed', expected: '' },
  { title: 'Application uses the SDK', expected: '' },
  { title: 'A test connection succeeds', expected: '' },
]

const FILE_PATH_RE =
  /(?:^|[\s`'"(])((?:\.?[\w.-]+\/)+[\w.-]+|\.?[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|toml|ya?ml|env(?:\.\w+)?))(?=$|[\s`'"),])/
const ENV_KEY_RE = /\b([A-Z][A-Z0-9_]{3,})\b/
const PACKAGE_RE = /(@[\w.-]+\/[\w.-]+)/
const LIVE_RE =
  /\b(test connection|connection succeeds|authenticat|logged[- ]?in|live (?:account|session|setup)|account (?:is )?connected|connect(?:ed)? an account)\b/i
const ACCOUNT_CREATED_RE =
  /\b(account created|creates? an account|signed up|sign[- ]up)\b/i
const CONFIG_RE =
  /\b(\.env(?:\.\w+)?|api[_ -]?key|env(?:ironment)? var|config(?:uration)?(?: key)?)\b/i
const INSTALL_RE = /\b(install|installed|added|present|sdk|package|dependenc)\b/i
const USES_RE = /\b(uses|import|require|from |calls?)\b/i

export function criterionIdFromTitle(
  title: string,
  used: ReadonlySet<string> = new Set(),
): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  let slug = /^[a-z]/.test(base) ? base : `check-${base || 'item'}`
  if (!CRITERION_ID.test(slug)) slug = 'check-item'
  let candidate = slug
  let n = 2
  while (used.has(candidate)) {
    const suffix = `-${n++}`
    candidate = `${slug.slice(0, 64 - suffix.length)}${suffix}`
  }
  return candidate
}

function firstMatch(text: string, pattern: RegExp): string {
  const match = pattern.exec(text)
  return match?.[1]?.trim() ?? ''
}

/**
 * Map a plain-language advertiser check onto a supported evidence method.
 * Ambiguous text stays unsupported with actionable feedback — never a silent
 * unverifiable promise.
 */
export function mapAdvertiserSuccessCheck(
  draft: AdvertiserSuccessCheckDraft,
  usedIds: ReadonlySet<string> = new Set(),
): MappedAdvertiserSuccessCheck {
  const title = draft.title.trim()
  const expected = draft.expected.trim()
  const required = draft.required !== false
  const id =
    draft.id && CRITERION_ID.test(draft.id)
      ? draft.id
      : criterionIdFromTitle(title || 'check', usedIds)
  const text = `${title}\n${expected}`
  const path = firstMatch(text, FILE_PATH_RE)
  const envKey = firstMatch(text, ENV_KEY_RE)
  const pkg = firstMatch(text, PACKAGE_RE)

  const base = {
    id,
    title: title || 'Untitled check',
    expected: expected || title || 'Describe the expected result',
    required,
  }

  if (!title && !expected) {
    return {
      criterion: {
        ...base,
        phase: 'code-ready',
        evidenceMethod: 'controlled_test',
        check: {
          kind: 'unsupported',
          reason: 'Describe what should be true after the integration.',
        },
      },
      supported: false,
      confirmation: '',
      feedback: 'Describe what should be true after the integration.',
    }
  }

  if (LIVE_RE.test(text)) {
    return {
      criterion: {
        ...base,
        expected: expected || title,
        phase: 'live-setup',
        evidenceMethod: 'live_probe',
        check: { kind: 'live_auth', probeId: 'approved-session' },
      },
      supported: true,
      confirmation:
        'Checked after account setup: an approved live probe must see an authenticated session. A config example is not enough.',
    }
  }

  if (ACCOUNT_CREATED_RE.test(text)) {
    return {
      criterion: {
        ...base,
        expected: expected || title,
        phase: 'live-setup',
        evidenceMethod: 'partner_evidence',
        check: { kind: 'partner_event', eventType: 'account_created' },
      },
      supported: true,
      confirmation:
        'Checked after account setup using authenticated partner evidence attributed to this run.',
    }
  }

  if (envKey && (CONFIG_RE.test(text) || path.includes('.env'))) {
    return {
      criterion: {
        ...base,
        expected: expected || `${path || '.env.example'} names ${envKey}`,
        phase: 'code-ready',
        evidenceMethod: 'configuration',
        check: {
          kind: 'config_key_declared',
          pathPattern: path || '.env.example',
          keyPattern: envKey,
        },
      },
      supported: true,
      confirmation: `Checked when the code is ready: ${path || '.env.example'} must declare ${envKey}. Placeholder values can pass this and cannot prove a live login.`,
    }
  }

  if (path && (pkg || expected) && (USES_RE.test(text) || INSTALL_RE.test(text))) {
    const pattern = pkg || expected.slice(0, MAX_CRITERION_PATTERN_CHARS)
    return {
      criterion: {
        ...base,
        expected: expected || `${path} includes ${pattern}`,
        phase: 'code-ready',
        evidenceMethod: 'committed_diff',
        check: { kind: 'content_added', pathPattern: path, pattern },
      },
      supported: true,
      confirmation: `Checked when the code is ready: committed ${path} must include ${pattern}.`,
    }
  }

  if (path) {
    return {
      criterion: {
        ...base,
        expected: expected || `${path} is added`,
        phase: 'code-ready',
        evidenceMethod: 'committed_diff',
        check: { kind: 'path_added', pathPattern: path },
      },
      supported: true,
      confirmation: `Checked when the code is ready: the committed diff must add ${path}.`,
    }
  }

  if (pkg && (INSTALL_RE.test(text) || USES_RE.test(text))) {
    return {
      criterion: {
        ...base,
        expected: expected || `package.json includes ${pkg}`,
        phase: 'code-ready',
        evidenceMethod: 'committed_diff',
        check: {
          kind: 'content_added',
          pathPattern: 'package.json',
          pattern: pkg,
        },
      },
      supported: true,
      confirmation: `Checked when the code is ready: package.json must include ${pkg}.`,
    }
  }

  return {
    criterion: {
      ...base,
      phase: 'code-ready',
      evidenceMethod: 'controlled_test',
      check: { kind: 'unsupported', reason: UNSUPPORTED_REVIEW_MESSAGE },
    },
    supported: false,
    confirmation: '',
    feedback: UNSUPPORTED_REVIEW_MESSAGE,
  }
}

export function buildAcceptanceCriteriaFromAdvertiserChecks(
  drafts: readonly AdvertiserSuccessCheckDraft[],
):
  | { ok: true; contract: AcceptanceCriteriaContract }
  | {
      ok: false
      errors: AcceptanceCriteriaParseError[]
      contract: AcceptanceCriteriaContract | null
    } {
  const filled = drafts.filter(
    (draft) => draft.title.trim() || draft.expected.trim(),
  )
  if (filled.length === 0) {
    return {
      ok: false,
      errors: [
        {
          path: 'criteria',
          message: 'A new acceptance-criteria contract cannot be empty.',
        },
      ],
      contract: null,
    }
  }
  const used = new Set<string>()
  const mapped = filled.map((draft) => {
    const result = mapAdvertiserSuccessCheck(draft, used)
    used.add(result.criterion.id)
    return result
  })
  const contract: AcceptanceCriteriaContract = {
    version: ACCEPTANCE_CRITERIA_CONTRACT_VERSION,
    criteria: mapped.map((entry) => entry.criterion),
  }
  const errors = mapped
    .filter((entry) => !entry.supported)
    .map((entry) => ({
      path: entry.criterion.id,
      message: entry.feedback || UNSUPPORTED_REVIEW_MESSAGE,
    }))
  if (errors.length > 0) return { ok: false, errors, contract }
  const parsed = parseReviewAcceptanceCriteria(contract)
  if (parsed.kind === 'invalid') {
    return { ok: false, errors: parsed.errors, contract }
  }
  return { ok: true, contract }
}
