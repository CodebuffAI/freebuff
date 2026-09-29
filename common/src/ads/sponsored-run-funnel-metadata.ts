/**
 * What a sponsored run's OUTCOME row in `ad_agentic_funnel_event` carries
 * beside it (COD-665): `run_failed`, `run_committed` and `run_delivered`.
 *
 * Before this those rows had `metadata = null`, and the only record of WHY a
 * run failed was `failure_reason` / `diagnostic_reason` on the Convex
 * proposal row -- so the Postgres funnel could count failures and say nothing
 * about them, and every "why did 38 runs fail" question was a Convex export
 * joined by hand. This is the smallest closed shape that answers it from
 * Postgres alone.
 *
 * TELEMETRY, NEVER MONEY. Nothing reads this to bill, refund or settle: the
 * `accepted` row is the one billable stage and it has its own producer. A
 * test asserts this module imports nothing from billing. The never-started
 * refund path (`sponsored-never-started-refund.ts`) does not read the stored
 * metadata either: it re-derives the code from the report itself, with
 * `sponsoredRunFailureCode`, and proves the spend from Postgres.
 *
 * CLOSED AND BOUNDED ON PURPOSE. Every key but `diagnostic_reason` is an enum
 * or a boolean, and `diagnostic_reason` is SCRUBBED (`scrubSponsoredDiagnostic`)
 * and capped at `SPONSORED_FUNNEL_DIAGNOSTIC_MAX` characters. The full,
 * unscrubbed text stays on the Convex row, which is joined by `proposal_id`
 * when an operator needs it; the funnel is for counting, and a counting table
 * is not a place for a user's paths, prompts or repository text.
 *
 * ONE BUILDER FOR EVERY PRODUCER. The funnel row is insert-once per
 * `(campaign, <type>:<proposalId>)`, so whichever producer wins the race is
 * the row analytics reads. Both producers of these three events -- the
 * Convex outbox and the off-Cloud state route -- take the metadata from
 * `buildSponsoredRunFunnelMetadata`, computed ONCE inside the Convex
 * transition and handed to the route, so the winner is the same row either way.
 */

import { z } from 'zod'

import { sponsoredExecutionSurfaceSchema } from './sponsored-capability'
import { SPONSORED_CLIENT_VERSION_PATTERN } from './sponsored-client-version'
import { SPONSORED_PARTIAL_EDITS_MARKER } from './sponsored-in-place'

/** Where the run executed. */
export const SPONSORED_RUN_EXECUTION_MODES = [
  /** Freebuff Cloud: a sandbox we own, keyed by `project_id`. */
  'cloud',
  /** Off Cloud, on its own branch in a worktree (the pre-2026-09-24 flow). */
  'worktree',
  /** Off Cloud, editing the user's working copy (`in_place_execution`). */
  'in_place',
] as const
export type SponsoredRunExecutionMode =
  (typeof SPONSORED_RUN_EXECUTION_MODES)[number]

/** The kernel the run executed under, derived from the execution surface. */
export const SPONSORED_RUN_OS = ['macos', 'linux', 'windows'] as const
export type SponsoredRunOs = (typeof SPONSORED_RUN_OS)[number]

/** The client whose Accept started the run (`acceptance.surface`). */
export const SPONSORED_RUN_CLIENTS = [
  'desktop',
  'cli',
  'web',
  'cloud',
  'chat',
] as const

/** The state a failure moved the row OUT of: `accepted` = it never ran. */
export const SPONSORED_RUN_FROM_STATES = ['accepted', 'running'] as const

/**
 * Why a run failed, as a CLOSED code.
 *
 * Cloud failures already carry a machine refusal (`failSponsoredExecution`'s
 * `refusal`); off-Cloud ones carry only the surface's `diagnostic_reason`,
 * whose leading clause is authored by our own client code
 * (`freebuff-desktop/.../sponsored-run.ts`, `cli/src/utils/sponsored-run.ts`)
 * and is therefore stable enough to classify. Anything this list does not
 * name is `other` (a Cloud refusal) or `unclassified` (a surface diagnostic),
 * never passed through: a code that reaches Postgres verbatim is a code whose
 * vocabulary Postgres no longer controls.
 */
export const SPONSORED_RUN_FAILURE_CODES = [
  // Surface diagnostics (Desktop / CLI), classified by their leading clause.
  'accept_failed',
  'accept_identity_changed',
  'containment_mismatch',
  'resume_declined',
  'app_quit',
  'interrupted',
  'grant_expired',
  'verdict_undecided',
  'commit_follow_up_failed',
  'no_edits',
  'no_commit',
  'turn_error',
  'unclassified',
  // A run that never started (`never-started: <reason>: …`), a turn that
  // ended early with partial edits, and an Accept the sponsor could not fund.
  // Added ahead of any producer (COD-665): receivers learn a code before
  // anything emits it, because Convex deploys before Render.
  'never_started_dismissed',
  'never_started_queue_expired',
  'never_started_connect_dismissed',
  'never_started_app_quit',
  'never_started_inputs_dropped',
  'never_started_other',
  'partial_edits',
  'funding_refused',
  // Cloud executor refusals (`SponsoredExecutionRefusal` + the sweep).
  'timed_out',
  'workspace_prepare_failed',
  'proposal_missing',
  'proposal_not_accepted',
  'no_thread_ref',
  'thread_missing',
  'not_sponsored',
  'thread_status_not_pending',
  'thread_busy',
  'project_missing',
  'no_sandbox',
  'isolation_unsupported',
  'workspace_not_ready',
  'no_access_tier',
  'user_missing',
  'gate_refused',
  'empty_procedure',
  'finished_no_changes',
  'run_missing',
  // `run_<status>`, one per terminal runner status (`freebuff_agent_runs`).
  'run_error',
  'run_cancelled',
  'run_paused',
  'run_timed_out',
  'run_unknown',
  'unknown',
  'other',
] as const
export type SponsoredRunFailureCode =
  (typeof SPONSORED_RUN_FAILURE_CODES)[number]

/**
 * The leading clause of every never-started diagnostic: an accepted run whose
 * turn never began, so no model was called and nothing in the project moved.
 * The reason token after it is one of {@link SPONSORED_NEVER_STARTED_REASONS}.
 */
export const SPONSORED_NEVER_STARTED_PREFIX = 'never-started'

/**
 * The machine reason a never-started diagnostic carries after the prefix. The
 * first three are the strings Desktop has written since COD-665; the funnel
 * maps each to its own `never_started_*` code.
 */
export const SPONSORED_NEVER_STARTED_REASONS = {
  dismissed: 'dismissed_while_queued',
  queueExpired: 'queue_wait_expired',
  connectDismissed: 'dismissed_during_connect',
  appQuit: 'app_quit',
  inputsDropped: 'inputs_dropped',
} as const
export type SponsoredNeverStartedReason =
  keyof typeof SPONSORED_NEVER_STARTED_REASONS

/** `never-started: <reason token>: <detail>`, the one way to author one. */
export function sponsoredNeverStartedDiagnostic(
  reason: SponsoredNeverStartedReason,
  detail: string,
): string {
  return `${SPONSORED_NEVER_STARTED_PREFIX}: ${SPONSORED_NEVER_STARTED_REASONS[reason]}: ${detail}`
}

/**
 * The leading clause of an Accept the sponsor could not fund: the row went
 * `failed` before anything ran, and nothing was charged.
 */
export const SPONSORED_FUNDING_REFUSED_PREFIX = 'funding-refused'

/** `funding-refused: <reason>`, `reason` being the settlement's refusal. */
export function sponsoredFundingRefusedDiagnostic(reason: string): string {
  return `${SPONSORED_FUNDING_REFUSED_PREFIX}: ${reason}`
}

/** The six codes of a run that was accepted and never started. */
export const SPONSORED_NEVER_STARTED_FAILURE_CODES: ReadonlySet<SponsoredRunFailureCode> =
  new Set<SponsoredRunFailureCode>([
    'never_started_dismissed',
    'never_started_queue_expired',
    'never_started_connect_dismissed',
    'never_started_app_quit',
    'never_started_inputs_dropped',
    'never_started_other',
  ])

/** Whether a failure code (from any source, unvalidated) names a never-started run. */
export function isSponsoredNeverStartedFailure(
  code: string | null | undefined,
): boolean {
  return (
    typeof code === 'string' &&
    (SPONSORED_NEVER_STARTED_FAILURE_CODES as ReadonlySet<string>).has(code)
  )
}

/** Cap on the scrubbed diagnostic. The Convex copy keeps up to 500. */
export const SPONSORED_FUNNEL_DIAGNOSTIC_MAX = 200

/**
 * The shape, as the Postgres bridge validates it. `.strict()` so a producer
 * that grew a field cannot widen the column without this file changing.
 */
export const sponsoredRunFunnelMetadataSchema = z
  .object({
    execution_mode: z.enum(SPONSORED_RUN_EXECUTION_MODES),
    execution_surface: z
      .union([sponsoredExecutionSurfaceSchema, z.literal('cloud')])
      .optional(),
    client: z.enum(SPONSORED_RUN_CLIENTS).optional(),
    os: z.enum(SPONSORED_RUN_OS).optional(),
    containment: z.literal('floor').optional(),
    from_state: z.enum(SPONSORED_RUN_FROM_STATES).optional(),
    failure_code: z.enum(SPONSORED_RUN_FAILURE_CODES).optional(),
    diagnostic_reason: z
      .string()
      .min(1)
      .max(SPONSORED_FUNNEL_DIAGNOSTIC_MAX)
      .optional(),
    llm_called: z.boolean().optional(),
    /** `desktop/<v>` or `cli/<v>` of the build that accepted (`sponsored-client-version.ts`). */
    client_version: z
      .string()
      .regex(SPONSORED_CLIENT_VERSION_PATTERN)
      .optional(),
  })
  .strict()

export type SponsoredRunFunnelMetadata = z.infer<
  typeof sponsoredRunFunnelMetadataSchema
>

/**
 * The schema a RECEIVER validates with: the same closed shape, except that a
 * `failure_code` this build does not know is recorded as `other` instead of
 * refusing the whole row.
 *
 * Convex deploys before Render, and a rollback reverts Next before Convex, so
 * for a window every deploy a newer producer talks to an older receiver. A
 * strict enum there turns each new code into a 400 on the bridge and a null
 * on the state route -- the outcome recorded, the reason lost. Only the
 * failure code is widened: an unknown KEY is still refused, so the bridge
 * cannot become a channel for text this module never named.
 */
export const sponsoredRunFunnelMetadataReceiverSchema = z.preprocess(
  (value) =>
    value !== null &&
    typeof value === 'object' &&
    'failure_code' in value &&
    typeof value.failure_code === 'string' &&
    !(SPONSORED_RUN_FAILURE_CODES as readonly string[]).includes(
      value.failure_code,
    )
      ? { ...value, failure_code: 'other' }
      : value,
  sponsoredRunFunnelMetadataSchema,
)

/** The three outcome events this metadata belongs to. */
export const SPONSORED_RUN_OUTCOME_FUNNEL_EVENTS = [
  'run_failed',
  'run_committed',
  'run_delivered',
] as const
export type SponsoredRunOutcomeFunnelEvent =
  (typeof SPONSORED_RUN_OUTCOME_FUNNEL_EVENTS)[number]

export function isSponsoredRunOutcomeFunnelEvent(
  value: string,
): value is SponsoredRunOutcomeFunnelEvent {
  return (SPONSORED_RUN_OUTCOME_FUNNEL_EVENTS as readonly string[]).includes(
    value,
  )
}

/**
 * The facts on a proposal row the builder reads. Structural, so the Convex
 * `Doc` and a test fixture both fit without this module importing Convex.
 */
export interface SponsoredRunFunnelRowFacts {
  project_id?: unknown
  in_place_execution?: true
  execution_surface?: string | null
  surface?: string | null
  acceptance?: {
    surface?: string | null
    containment?: string | null
    /** `desktop/<v>` or `cli/<v>`, written once at Accept. */
    client_version?: string | null
  } | null
  diagnostic_reason?: string | null
}

const OS_BY_SURFACE: Record<string, SponsoredRunOs> = {
  desktop_macos: 'macos',
  cli_macos: 'macos',
  desktop_linux: 'linux',
  cli_linux: 'linux',
  // WSL is a Linux kernel under Windows; the surface keeps the distinction.
  cli_wsl: 'linux',
  desktop_windows: 'windows',
}

/**
 * The closed code for a failure.
 *
 * A Cloud `refusal` is looked up, and one this list does not name (a runner
 * status added later, say) is `other`; an off-Cloud failure is classified from the leading clause of its
 * diagnostic, which our own client code writes. ORDER MATTERS below: the
 * more specific clauses are tested before the general `turn …` ones.
 */
export function sponsoredRunFailureCode(args: {
  refusal?: string | null
  diagnosticReason?: string | null
}): SponsoredRunFailureCode {
  const refusal = args.refusal?.trim()
  if (refusal) {
    return (SPONSORED_RUN_FAILURE_CODES as readonly string[]).includes(refusal)
      ? (refusal as SponsoredRunFailureCode)
      : 'other'
  }
  const text = (args.diagnosticReason ?? '').trim().toLowerCase()
  if (!text) return 'unclassified'
  if (text.startsWith(SPONSORED_NEVER_STARTED_PREFIX)) {
    return neverStartedCode(text)
  }
  if (text.startsWith(SPONSORED_FUNDING_REFUSED_PREFIX)) {
    return 'funding_refused'
  }
  if (text.startsWith('accept-identity-changed'))
    return 'accept_identity_changed'
  if (text.startsWith('accept-failed')) return 'accept_failed'
  if (text.startsWith('containment-mismatch')) return 'containment_mismatch'
  if (text.startsWith('resume-declined')) return 'resume_declined'
  if (text.startsWith('stale-sweep')) return 'timed_out'
  if (text.startsWith('app-quit')) return 'app_quit'
  if (text.startsWith('interrupted')) return 'interrupted'
  if (text.includes('the verdict could not be decided')) {
    return 'verdict_undecided'
  }
  if (text.includes('commit follow-up')) return 'commit_follow_up_failed'
  // Before every `turn …` branch: a turn that ended early with edits is its
  // own outcome whatever ended it -- which also reclassifies the diagnostics
  // shipped Desktop builds already write.
  if (text.includes(SPONSORED_PARTIAL_EDITS_MARKER)) return 'partial_edits'
  if (text.startsWith('turn grant-expired')) return 'grant_expired'
  if (
    text.startsWith('turn interrupted') ||
    text.startsWith('turn stopped') ||
    text.startsWith('turn closed')
  ) {
    return 'interrupted'
  }
  // An errored turn is `turn_error` whatever it left behind: "no file edits"
  // after an error is how a session that never started reads, too.
  if (text.startsWith('turn error')) return 'turn_error'
  if (text.startsWith('turn completed')) {
    return text.includes('recorded no file edits') ? 'no_edits' : 'no_commit'
  }
  return 'unclassified'
}

const NEVER_STARTED_CODE_BY_REASON: Record<string, SponsoredRunFailureCode> = {
  [SPONSORED_NEVER_STARTED_REASONS.dismissed]: 'never_started_dismissed',
  [SPONSORED_NEVER_STARTED_REASONS.queueExpired]: 'never_started_queue_expired',
  [SPONSORED_NEVER_STARTED_REASONS.connectDismissed]:
    'never_started_connect_dismissed',
  [SPONSORED_NEVER_STARTED_REASONS.appQuit]: 'never_started_app_quit',
  // Desktop's shutdown and boot paths wrote the quit as `app-quit: …`.
  'app-quit': 'never_started_app_quit',
  [SPONSORED_NEVER_STARTED_REASONS.inputsDropped]:
    'never_started_inputs_dropped',
}

/** The code of a (lower-cased) `never-started: <token>…` diagnostic. */
function neverStartedCode(text: string): SponsoredRunFailureCode {
  const rest = text.slice(SPONSORED_NEVER_STARTED_PREFIX.length)
  if (!rest.startsWith(': ')) return 'never_started_other'
  const body = rest.slice(2)
  // Desktop's rewind / close / delete paths wrote a sentence, not a token.
  if (body.startsWith('the conversation was')) {
    return 'never_started_inputs_dropped'
  }
  const token = body.split(/[:;\s]/, 1)[0] ?? ''
  return NEVER_STARTED_CODE_BY_REASON[token] ?? 'never_started_other'
}

/**
 * Whether a model was called, ONLY where the answer is certain.
 *
 * `false` for a failure that by construction happened before any turn could
 * be queued (the accept-side closes on Desktop, every Cloud pre-queue refusal,
 * and a Cloud row swept out of `accepted`). `true` for a turn that completed
 * or produced work. Absent everywhere else -- "turn error" includes a session
 * that never started, and a local row swept out of `accepted` may still have
 * run without its advisory `running` report landing.
 */
const NO_TURN_CODES: ReadonlySet<SponsoredRunFailureCode> = new Set([
  'accept_failed',
  'accept_identity_changed',
  'containment_mismatch',
  'resume_declined',
  'workspace_prepare_failed',
  'proposal_missing',
  'proposal_not_accepted',
  'no_thread_ref',
  'thread_missing',
  'not_sponsored',
  'thread_status_not_pending',
  'thread_busy',
  'project_missing',
  'no_sandbox',
  'isolation_unsupported',
  'workspace_not_ready',
  'no_access_tier',
  'user_missing',
  'gate_refused',
  'empty_procedure',
  ...SPONSORED_NEVER_STARTED_FAILURE_CODES,
  'funding_refused',
])

/** Each of these is a turn that COMPLETED, which a model call is part of. */
const TURN_RAN_CODES: ReadonlySet<SponsoredRunFailureCode> = new Set([
  'finished_no_changes',
  'no_edits',
  'no_commit',
  'commit_follow_up_failed',
  // Edits of the run's own are a model's work.
  'partial_edits',
])

/**
 * The scrubbed, capped copy of a diagnostic for the funnel.
 *
 * Operator text is authored by our code, but its CAUSE clause is whatever the
 * failing link said -- an exception's first line, a git error, a provider
 * message -- and any of those can name a user's home directory, a file in
 * their repository, a URL or a token. So: first line only, control characters
 * dropped, then every span that could carry user content replaced by a
 * placeholder naming what was removed, then capped. What survives is the
 * SHAPE of the failure (`turn error: <path> could not be opened; HEAD is
 * still the base commit`), which is what a count needs. The unscrubbed text is
 * still on the Convex row.
 *
 * `null` when nothing is left, so the key is omitted rather than empty.
 */
export function scrubSponsoredDiagnostic(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null
  let text = raw.split(/\r?\n/, 1)[0] ?? ''
  // Control characters (C0 + DEL), as a scan-free replace.
  text = text.replace(/[\u0000-\u001f\u007f]/g, ' ')
  text = text
    // URLs of any scheme, before paths, so `https://x/y` is one placeholder.
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
    // Quoted spans are where an error echoes its input (a file name, a
    // command, a model's words). The run state in backticks is ours, but it
    // costs nothing to lose: `from_state` carries it.
    .replace(/`[^`]*`/g, '<quoted>')
    .replace(/"[^"]*"/g, '<quoted>')
    // Single quotes only where one OPENS a quote, so "can't" is not a quote.
    .replace(/(^|[\s(=:])'[^']*'/g, '$1<quoted>')
    // Windows absolute paths and UNC shares.
    .replace(/\b[a-z]:[\\/][^\s;,)]*/gi, '<path>')
    .replace(/\\\\[^\s;,)]+/g, '<path>')
    // POSIX absolute and home-relative paths. `/dev/null` is kept: it names no
    // user and it is the exact string one real macOS failure turned on.
    .replace(/(^|[\s(=:])~?\/(?!dev\/null\b)[^\s;,)]+/g, '$1<path>')
    // Relative paths that name a file (`src/app.ts`); a model id such as
    // `deepseek/deepseek-v4-flash` has no extension and is kept.
    .replace(/\b[\w.-]+(?:\/[\w.-]+)+\.[a-z0-9]{1,8}\b/gi, '<path>')
    // Long opaque tokens: hashes, keys, ids.
    .replace(/\b[a-f0-9]{16,}\b/gi, '<hex>')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<token>')
    // Last: every remaining number, so `95 minutes` and `96 minutes` count as
    // one shape. After the hex and token passes, which need the digits.
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null
  return text.length > SPONSORED_FUNNEL_DIAGNOSTIC_MAX
    ? `${text.slice(0, SPONSORED_FUNNEL_DIAGNOSTIC_MAX - 1)}…`
    : text
}

/**
 * The metadata for one outcome row, from the proposal row AFTER the
 * transition was written.
 *
 * `refusal` is the Cloud executor's machine code when it is the writer;
 * `fromState` is the state the transition left, when the writer knows it (a
 * replay of an old report does not, and the key is then omitted).
 */
export function buildSponsoredRunFunnelMetadata(args: {
  eventType: SponsoredRunOutcomeFunnelEvent
  row: SponsoredRunFunnelRowFacts
  fromState?: string | null
  refusal?: string | null
}): SponsoredRunFunnelMetadata {
  const { row } = args
  const executionMode: SponsoredRunExecutionMode = row.project_id
    ? 'cloud'
    : row.in_place_execution === true
      ? 'in_place'
      : 'worktree'
  const surface = sponsoredExecutionSurfaceSchema.safeParse(
    row.execution_surface,
  )
  const executionSurface = surface.success
    ? surface.data
    : executionMode === 'cloud'
      ? ('cloud' as const)
      : undefined
  const clientRaw = row.acceptance?.surface ?? row.surface ?? null
  const client = (SPONSORED_RUN_CLIENTS as readonly string[]).includes(
    clientRaw ?? '',
  )
    ? (clientRaw as (typeof SPONSORED_RUN_CLIENTS)[number])
    : undefined
  const os = surface.success ? OS_BY_SURFACE[surface.data] : undefined
  const fromState = (SPONSORED_RUN_FROM_STATES as readonly string[]).includes(
    args.fromState ?? '',
  )
    ? (args.fromState as (typeof SPONSORED_RUN_FROM_STATES)[number])
    : undefined
  const diagnostic = scrubSponsoredDiagnostic(row.diagnostic_reason)
  const clientVersion = row.acceptance?.client_version
  const validClientVersion =
    typeof clientVersion === 'string' &&
    SPONSORED_CLIENT_VERSION_PATTERN.test(clientVersion)
      ? clientVersion
      : undefined

  let failureCode: SponsoredRunFailureCode | undefined
  let llmCalled: boolean | undefined
  if (args.eventType === 'run_failed') {
    failureCode = sponsoredRunFailureCode({
      refusal: args.refusal,
      diagnosticReason: row.diagnostic_reason,
    })
    if (NO_TURN_CODES.has(failureCode)) llmCalled = false
    else if (TURN_RAN_CODES.has(failureCode)) llmCalled = true
    // A Cloud row the sweep took out of `accepted` was never queued. A local
    // one may have run with its advisory `running` report lost, so it stays
    // unknown.
    else if (
      failureCode === 'timed_out' &&
      executionMode === 'cloud' &&
      fromState === 'accepted'
    ) {
      llmCalled = false
    }
  } else {
    // A commit or a delivered edit set is work a turn produced.
    llmCalled = true
  }

  return {
    execution_mode: executionMode,
    ...(executionSurface ? { execution_surface: executionSurface } : {}),
    ...(client ? { client } : {}),
    ...(os ? { os } : {}),
    ...(row.acceptance?.containment === 'floor'
      ? { containment: 'floor' as const }
      : {}),
    ...(fromState ? { from_state: fromState } : {}),
    ...(failureCode ? { failure_code: failureCode } : {}),
    ...(diagnostic ? { diagnostic_reason: diagnostic } : {}),
    ...(llmCalled !== undefined ? { llm_called: llmCalled } : {}),
    ...(validClientVersion ? { client_version: validClientVersion } : {}),
  }
}
