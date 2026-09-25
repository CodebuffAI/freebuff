import {
  AGENTIC_OFFER_PATH,
  agenticOfferResponseSchema,
} from '@codebuff/common/ads/agentic-offer'
import { SPONSORED_IN_PLACE_VERSION } from '@codebuff/common/ads/sponsored-in-place'
import { normalizeRepoFullName } from '@codebuff/common/ads/sponsored-proposal-target'
import type {
  AgenticOfferRequest,
  AgenticOfferResponse,
} from '@codebuff/common/ads/agentic-offer'
import type { SponsoredLocalTarget } from '@codebuff/common/ads/sponsored-capability'
import type { SponsoredComputeGrant } from '@codebuff/common/ads/sponsored-compute-contract'
import { createHash } from 'node:crypto'

import { FREEBUFF_WEB_URL } from '../login/constants'

import { logger } from './logger'

import type { SponsoredProposalRow } from '@codebuff/common/ads/sponsored-proposal-view'

/**
 * The CLI's transport for sponsored proposals (COD-376, Decision 2).
 *
 * REST, because the CLI has no Convex client and is not getting one for this:
 * `git grep convex -- cli/` is empty, and a websocket subscription to reach one
 * card is a dependency the terminal would carry on every launch.
 *
 * FREEBUFF.COM, not codebuff.com, which is where the display-ad calls go. The
 * Convex functions live on freebuff.com and the two web apps share one Postgres,
 * so the session token the CLI already holds signs in on either.
 *
 * ACCEPT AND STATE REPORTING ARRIVED WITH COD-396, and they are the two writes
 * here that do NOT swallow their reason. Proposal reads also preserve whether
 * the server authoritatively returned no row or could not answer, because only
 * the former may remove a card. Channel-control writes keep their boolean
 * contract. Accept is the user pressing a thing and being owed an answer, and
 * a state report is the only writer that can move a locally-executed row off
 * `accepted` — so both carry the upstream status and message.
 */

export type SponsoredProposal = SponsoredProposalRow & {
  _id: string
  advertiser_id: string
}

/**
 * A proposal read has three outcomes, and only one of them authoritatively
 * says there is no offer. Keeping transport failure separate prevents a
 * dropped request from being interpreted as a dismissal while still letting
 * a successful `{ proposal: null }` remove stale controls.
 */
export type SponsoredProposalFetchResult =
  | { status: 'present'; proposal: SponsoredProposal }
  | { status: 'absent' }
  | { status: 'unavailable' }

/**
 * What `POST .../accept` hands back: the reviewed procedure and the token every
 * state report is signed with.
 *
 * The polled row deliberately carries neither. A row is readable by anything
 * that can reach the read route, and a procedure is the text that will be
 * executed on this machine.
 */
export type SponsoredAccept = {
  proposalId: string
  state: 'accepted'
  /** The advertiser-authored task. Untrusted text; it becomes the run's prompt. */
  procedure: string
  advertiserName: string
  headline: string
  /**
   * The advertiser CTA URL as a RUNTIME INPUT to the procedure (COD-512);
   * absent until settlement minted a token. Never part of `procedure`.
   */
  advertiserLink?: string
  runToken: string
  /** ISO-8601. After this the token stops being honoured upstream. */
  expiresAt: string
  computeGrant: SponsoredComputeGrant
}

export type SponsoredAcceptPreview = {
  proposalId: string
  procedure: string
  procedureSha256: string
  /** Present for foundation offers; absent preserves outstanding legacy offers. */
  target?: SponsoredLocalTarget
}

/**
 * The execution surface this machine reports, as the Accept route pairs it with
 * the row (`acceptClientSurfacePairsWithRow`). The CLI never runs on Windows
 * (`sponsored-cli-capability.ts`), so there is no `cli_windows`.
 */
export type SponsoredCliExecutionSurface = 'cli_macos' | 'cli_linux' | 'cli_wsl'

/**
 * One transition, exactly as the state route takes it (COD-396).
 *
 * `delivered` is the IN-PLACE terminal state (#3989): the run's edits are in
 * the working copy and nothing was committed. It is the only success this CLI
 * reports now; `committed` and `landed` stay in the type because the state
 * route still speaks them and an older outbox entry may carry one.
 */
export type SponsoredStateUpdate = {
  state: 'running' | 'delivered' | 'committed' | 'failed' | 'landed'
  reportId?: string
  runId?: string
  head?: string
  /** Diff-verified outcomes, read from the run's own edit receipts. */
  outcomes?: string[]
  outcomeFiles?: Record<string, string[]>
  steps?: { text: string; state: 'pending' | 'active' | 'done' }[]
  branch?: string
  prUrl?: string
  /** The sentence the CARD shows. Written for the user, not for us. */
  failureReason?: string
  /**
   * The same failure, said plainly, for whoever has to fix it. Stored beside
   * `failureReason` and never rendered.
   */
  diagnosticReason?: string
}

/**
 * A write that carries WHY it failed.
 *
 * `status: 0` is the deliberate non-status for a request that never became an
 * HTTP exchange at all. It is the only failure worth retrying: a 409 or a 422
 * is an answer, and retrying an answer turns one refusal into two.
 */
export type SponsoredWriteResult =
  | { ok: true; status: number }
  | { ok: false; status: number; message: string }

export type SponsoredAcceptResult =
  | { ok: true; accept: SponsoredAccept }
  | { ok: false; status: number; message: string; code?: string | null }

const REQUEST_TIMEOUT_MS = 10_000
/**
 * The funded Accept's own timeout, longer than every other call here: it
 * settles a charge and mints a grant before it answers, and a timeout that
 * fires first turns a success into a retry. Desktop uses the same figure.
 */
const ACCEPT_TIMEOUT_MS = 30_000
const SHA256 = /^[a-f0-9]{64}$/
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const COMPUTE_TOKEN = /^scg_1_[A-Za-z0-9_-]{43}$/

export function sponsoredProcedureSha256(procedure: string): string {
  return createHash('sha256').update(procedure, 'utf8').digest('hex')
}

/**
 * The freebuff.com origin these calls go to.
 *
 * THE SAME CONSTANT THE LOGIN FLOW USES, deliberately. This read
 * `process.env.NEXT_PUBLIC_FREEBUFF_APP_URL` raw, which skipped both things
 * that constant does: the `@codebuff/common/env` schema, so an unset or
 * mistyped variable fell back to production with nothing said; and the
 * `IS_DEV` localhost branch, so a developer's proposal traffic left their
 * laptop for production while every other CLI call stayed on :3002 -- writing
 * real prefs and real dismissals against their real account from a dev build.
 */
function baseUrl(): string {
  return FREEBUFF_WEB_URL.replace(/\/+$/, '')
}

async function call<T>(
  method: string,
  path: string,
  authToken: string,
  payload?: unknown,
): Promise<T | null> {
  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${authToken}`,
        ...(payload === undefined
          ? {}
          : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return null
    return (await response.json()) as T
  } catch (error) {
    // Logged at debug, never surfaced: this whole channel is optional, and a
    // terminal that reports an ad rail's network trouble to the user is
    // spending their attention on our problem.
    logger.debug({ error, path }, '[sponsored-proposal] request failed')
    return null
  }
}

/**
 * The authoritative proposal state for a repository.
 *
 * Only a successful `{ proposal: null }` is absence. HTTP failures, network
 * failures and malformed successful bodies are unavailable, so the poller can
 * stand stale controls down without pretending the server removed the offer.
 */
export async function fetchSponsoredProposal(
  repoFullName: string,
  authToken: string,
): Promise<SponsoredProposalFetchResult> {
  const workspace = /^workspace:([0-9a-f-]{36})$/i.exec(repoFullName)?.[1]
  const repo = workspace ? null : normalizeRepoFullName(repoFullName)
  if (!repo && !workspace) return { status: 'unavailable' }

  // `surface=cli`: only rows minted for THIS surface. A Desktop open on the
  // same repository has its own row, and accepting that one from here is a
  // 409 `accept_surface_mismatch` -- so it is never shown here at all. A
  // server older than the filter ignores the parameter.
  const path = workspace
    ? `/api/v1/ads/proposal?workspace=${encodeURIComponent(workspace)}&surface=cli`
    : `/api/v1/ads/proposal?repo=${encodeURIComponent(repo!)}&surface=cli`
  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return { status: 'unavailable' }
    const result = (await response.json()) as { proposal?: unknown }
    if (result?.proposal === null) return { status: 'absent' }
    if (!isSponsoredProposal(result?.proposal)) {
      return { status: 'unavailable' }
    }
    return { status: 'present', proposal: result.proposal }
  } catch (error) {
    logger.debug({ error, path }, '[sponsored-proposal] request failed')
    return { status: 'unavailable' }
  }
}

function isSponsoredProposal(value: unknown): value is SponsoredProposal {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<SponsoredProposal>
  return (
    typeof row._id === 'string' &&
    typeof row.advertiser_id === 'string' &&
    typeof row.advertiser_name === 'string' &&
    typeof row.headline === 'string' &&
    typeof row.body === 'string' &&
    SPONSORED_PROPOSAL_STATES.has(row.state ?? '') &&
    optionalString(row.advertiser_logo_token) &&
    optionalString(row.why_this) &&
    optionalString(row.thread_ref) &&
    optionalString(row.branch) &&
    optionalString(row.pr_url) &&
    optionalString(row.advertiser_cta_url) &&
    optionalString(row.failure_reason) &&
    (row.steps === undefined ||
      (Array.isArray(row.steps) &&
        row.steps.every(
          (step) =>
            typeof step?.text === 'string' &&
            (step.state === 'pending' ||
              step.state === 'active' ||
              step.state === 'done'),
        )))
  )
}

const SPONSORED_PROPOSAL_STATES = new Set([
  'offered',
  'accepted',
  'running',
  'delivered',
  'committed',
  'landed',
  'failed',
  'merged',
])

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

export async function dismissSponsoredProposal(
  proposalId: string,
  authToken: string,
): Promise<boolean> {
  return (
    (await call(
      'POST',
      `/api/v1/ads/proposal/${encodeURIComponent(proposalId)}/dismiss`,
      authToken,
      {},
    )) !== null
  )
}

export async function reportSponsoredProposal(
  proposalId: string,
  authToken: string,
  reason?: string,
): Promise<boolean> {
  return (
    (await call(
      'POST',
      `/api/v1/ads/proposal/${encodeURIComponent(proposalId)}/report`,
      authToken,
      reason ? { reason } : {},
    )) !== null
  )
}

/**
 * Best-effort acknowledgement from a mounted terminal card. This is telemetry
 * only; a failed request never changes the transcript or a user's controls.
 */
export async function acknowledgeSponsoredProposalDisplay(
  proposalId: string,
  authToken: string,
): Promise<boolean> {
  return (
    (await call(
      'POST',
      `/api/v1/ads/proposal/${encodeURIComponent(proposalId)}/display`,
      authToken,
      {},
    )) !== null
  )
}

/**
 * A standing channel preference: one advertiser refused, or the whole channel
 * turned off. Exactly one per call — they are different weights of answer, and
 * a request that did both would leave no record of which the user chose.
 */
/**
 * The same request, with its refusal intact.
 *
 * `call` above answers `null` for a timeout, a 401, a 409 and a malformed body
 * alike, which is right for a channel where the user's response to all four is
 * to see no card. It is exactly wrong for the two calls below: one of them is
 * the user having just pressed something, and the other is the only thing that
 * can stop a card spinning on `accepted` forever.
 */
async function callDetailed<T>(
  path: string,
  authToken: string,
  payload: unknown,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<
  | { ok: true; status: number; value: T }
  | { ok: false; status: number; message: string; code: string | null }
> {
  let response: Response
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${authToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    logger.debug({ error, path }, '[sponsored-proposal] request failed')
    // STATUS 0: never reached the server, so the caller may retry it. See
    // `SponsoredWriteResult`.
    return {
      ok: false,
      status: 0,
      message: 'Could not reach Freebuff.',
      code: null,
    }
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      ...(await upstreamRefusal(response)),
    }
  }
  try {
    return {
      ok: true,
      status: response.status,
      value: (await response.json()) as T,
    }
  } catch {
    // A 2xx whose body is not JSON is still a write that landed. Only the
    // accept needs the body, and it checks its own fields below.
    return { ok: true, status: response.status, value: {} as T }
  }
}

/** Read the immutable procedure before showing terminal consent. */
async function getDetailed<T>(
  path: string,
  authToken: string,
): Promise<
  | { ok: true; status: number; value: T }
  | { ok: false; status: number; message: string }
> {
  let response: Response
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    logger.debug({ error, path }, '[sponsored-proposal] request failed')
    return { ok: false, status: 0, message: 'Could not reach Freebuff.' }
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: await upstreamMessage(response),
    }
  }
  try {
    return {
      ok: true,
      status: response.status,
      value: (await response.json()) as T,
    }
  } catch {
    return {
      ok: false,
      status: 502,
      message: 'Freebuff did not return the reviewed task.',
    }
  }
}

/**
 * Upstream's own sentence, or a fallback.
 *
 * Preferred over a status-code table because the accept route's refusals are
 * specific and actionable — `cloud_keyed`, `campaign_not_serving`,
 * `not_offered` — and "409" is not.
 */
async function upstreamMessage(response: Response): Promise<string> {
  return (await upstreamRefusal(response)).message
}

/**
 * The refusal's machine code beside its sentence. The run service needs the
 * code for exactly one decision: `procedure_changed` is answered by showing the
 * new task, where every other refusal is shown and left.
 */
async function upstreamRefusal(
  response: Response,
): Promise<{ code: string | null; message: string }> {
  let code: string | null = null
  try {
    const body = (await response.json()) as {
      error?: unknown
      message?: unknown
    }
    const written = typeof body?.message === 'string' ? body.message.trim() : ''
    const error = typeof body?.error === 'string' ? body.error.trim() : ''
    // An ENUMERATED CODE is not a sentence (COD-438). The routes ship the
    // code in `error` and, when they have one, the English in `message`; the
    // code used to win and the user read `funded_accept_required` in a
    // terminal. A known code gets our sentence, an unknown one gets whatever
    // prose came with it, and only genuine prose in `error` is shown as-is.
    if (error) {
      if (looksLikeMachineCode(error)) code = error
      const mapped = PROPOSAL_ERROR_SENTENCES[error]
      if (mapped) return { code, message: mapped }
      if (!looksLikeMachineCode(error)) return { code, message: error }
      if (written) return { code, message: written }
    } else if (written) {
      return { code, message: written }
    }
  } catch {
    // fall through
  }
  return {
    code,
    message:
      response.status === 401
        ? 'Sign in to Freebuff to accept a sponsored task.'
        : 'Freebuff refused this sponsored task.',
  }
}

/**
 * The accept and state routes' refusal codes, as sentences a person can act on.
 *
 * THE SAME KEYS as Desktop's map (`freebuff-desktop/src/server/services/
 * proposals.ts`), in this surface's words: where Desktop says "update Freebuff
 * Desktop", a terminal says "update Freebuff". Before the funded codes were
 * mapped every one of them reached the terminal as "Freebuff refused this
 * sponsored task."
 */
const PROPOSAL_ERROR_SENTENCES: Record<string, string> = {
  campaign_missing:
    'This sponsored task is no longer available. Nothing was started.',
  campaign_not_serving:
    'This sponsored task is not cleared to run right now. Nothing was started.',
  empty_procedure:
    'This sponsored task has nothing to do yet. Nothing was started.',
  invalid_state: 'This proposal is no longer on offer.',
  cloud_keyed:
    'This proposal belongs to a Freebuff Cloud project. Open it in the web app.',
  funded_accept_required:
    'Update Freebuff to accept sponsored tasks. Nothing was started.',
  invalid_transition:
    'This sponsored task has already finished, so it could not be updated.',
  report_conflict:
    'This sponsored task’s result was already recorded, so it was not recorded again.',
  campaign_not_runnable:
    'This sponsored task is not available to run right now. Nothing was started.',
  unfunded_impression: 'This sponsored offer has expired. Nothing was started.',
  offer_procedure_unavailable:
    'This sponsored task is no longer available. Nothing was started.',
  procedure_changed:
    'This sponsored task changed after you reviewed it. Review the updated task to continue. Nothing was started.',
  accept_target_mismatch:
    'This sponsored task was offered for a different project. Nothing was started.',
  accept_surface_mismatch:
    'This sponsored task was offered in a different Freebuff app. Nothing was started.',
  execution_surface_mismatch:
    'This sponsored task was offered for a different kind of computer. Nothing was started.',
  execution_surface_unavailable:
    'Sponsored tasks can’t be started here yet. Nothing was started.',
  unsupported_surface:
    'Sponsored tasks can’t be started here yet. Nothing was started.',
  client_update_required:
    'Update Freebuff to accept this sponsored task. Nothing was started.',
  invalid_binding:
    'This sponsored task no longer matches what you approved. Nothing was started.',
  accept_binding_changed:
    'This sponsored task was already started from another window or device. Nothing new was started.',
  accept_identity_conflict:
    'This sponsored task was already started with a different approval. Nothing new was started.',
  acceptance_evidence_missing:
    'Freebuff could not finish starting this sponsored task. Try again in a moment.',
  sponsor_billing_failed:
    'Freebuff could not finish starting this sponsored task. Try again in a moment.',
  sponsor_funding_unavailable:
    'Freebuff could not finish starting this sponsored task. Try again in a moment.',
  compute_grant_persistence_failed:
    'Freebuff could not finish starting this sponsored task. Try again in a moment.',
}

/** `snake_case` or a bare lowercase word: how the routes spell a code. */
function looksLikeMachineCode(said: string): boolean {
  return /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(said)
}

/**
 * Accept a repo- or workspace-keyed proposal for a LOCAL, IN-PLACE run
 * (COD-396, #3989).
 *
 * `surface: 'cli'` is not decoration: the upstream mutation branches on it to
 * decide that NOTHING is spawned server-side, and the accept route rejects any
 * value that is not `desktop` or `cli`. `inPlaceExecutionVersion: 1` says this
 * build runs the accepted offer as a turn in the current conversation, editing
 * the working copy with no worktree or commit -- the grant, the target and the
 * terminal vocabulary all differ on it, so it is sent on every Accept.
 *
 * IDEMPOTENT within the token's TTL, which is what makes a retry after a lost
 * response safe — the same payload with the same `runToken` comes back, no
 * second funnel event is emitted, and a 409 `invalid_state` is not what a
 * dropped connection produces.
 */
export async function acceptSponsoredProposal(
  proposalId: string,
  authToken: string,
  binding?: {
    runId: string
    procedureSha256: string
    target?: SponsoredLocalTarget
    clientExecutionSurface?: SponsoredCliExecutionSurface
  },
): Promise<SponsoredAcceptResult> {
  if (
    !binding ||
    !UUID.test(binding.runId) ||
    !SHA256.test(binding.procedureSha256)
  ) {
    return {
      ok: false,
      status: 400,
      message:
        'Review this sponsored task in the terminal before accepting it.',
    }
  }
  const attempt = await callDetailed<SponsoredAccept>(
    `/api/v1/ads/proposal/${encodeURIComponent(proposalId)}/accept`,
    authToken,
    {
      surface: 'cli',
      ...binding,
      inPlaceExecutionVersion: SPONSORED_IN_PLACE_VERSION,
    },
    ACCEPT_TIMEOUT_MS,
  )
  if (!attempt.ok) {
    return {
      ok: false,
      status: attempt.status,
      message: attempt.message,
      code: attempt.code,
    }
  }
  // A 200 missing either field the run cannot proceed without is a REFUSAL,
  // not a run with an empty procedure: `callDetailed` degrades an unparseable
  // 2xx to `{}`, which is right for a write and exactly wrong here.
  if (!isFundedAccept(attempt.value, proposalId, binding)) {
    return {
      ok: false,
      status: 502,
      message:
        'Freebuff accepted the proposal but did not return the task to run.',
    }
  }
  return { ok: true, accept: attempt.value }
}

/**
 * The server's exact reviewed procedure. GET is deliberately separate from
 * accept: the user sees these bytes before a funded acceptance is recorded.
 */
export async function previewSponsoredProposal(
  proposalId: string,
  authToken: string,
  target?: SponsoredLocalTarget,
  clientExecutionSurface?: SponsoredCliExecutionSurface,
): Promise<
  | { ok: true; preview: SponsoredAcceptPreview }
  | { ok: false; status: number; message: string }
> {
  const query = [
    ...(target
      ? [
          target.kind === 'repo'
            ? `repo=${encodeURIComponent(target.repoFullName)}`
            : `workspace=${encodeURIComponent(target.workspaceId)}`,
        ]
      : []),
    ...(clientExecutionSurface
      ? [`clientExecutionSurface=${encodeURIComponent(clientExecutionSurface)}`]
      : []),
  ]
  const attempt = await getDetailed<SponsoredAcceptPreview>(
    `/api/v1/ads/proposal/${encodeURIComponent(proposalId)}/accept${
      query.length ? `?${query.join('&')}` : ''
    }`,
    authToken,
  )
  if (!attempt.ok) return attempt
  const preview = attempt.value
  if (
    !preview ||
    preview.proposalId !== proposalId ||
    typeof preview.procedure !== 'string' ||
    !preview.procedure ||
    typeof preview.procedureSha256 !== 'string' ||
    !SHA256.test(preview.procedureSha256) ||
    sponsoredProcedureSha256(preview.procedure) !== preview.procedureSha256
  ) {
    return {
      ok: false,
      status: 502,
      message: 'Freebuff returned an invalid reviewed task.',
    }
  }
  return { ok: true, preview }
}

function isFundedAccept(
  value: SponsoredAccept | undefined,
  proposalId: string,
  binding: { runId: string; procedureSha256: string },
): value is SponsoredAccept {
  const grant = value?.computeGrant
  return Boolean(
    value &&
    value.proposalId === proposalId &&
    typeof value.procedure === 'string' &&
    value.procedure &&
    sponsoredProcedureSha256(value.procedure) === binding.procedureSha256 &&
    typeof value.runToken === 'string' &&
    grant &&
    typeof grant.token === 'string' &&
    COMPUTE_TOKEN.test(grant.token) &&
    grant.proposalId === proposalId &&
    grant.runId === binding.runId &&
    grant.procedureSha256 === binding.procedureSha256 &&
    typeof grant.modelId === 'string' &&
    Boolean(grant.modelId) &&
    Number.isSafeInteger(grant.expiresAtMs) &&
    grant.expiresAtMs > Date.now() &&
    Number.isSafeInteger(grant.allowanceUsdMicros) &&
    grant.allowanceUsdMicros > 0,
  )
}

/**
 * Report where a local run has got to (`accepted → running → delivered|failed`,
 * `accepted → failed`; the worktree flow's `committed → landed` is still
 * accepted upstream but no longer sent from here).
 *
 * Signed with the run token as well as the session bearer: the token is scoped
 * to this one accepted proposal, so a bug elsewhere in the CLI cannot report
 * state for somebody else's row.
 *
 * `landed` REQUIRES a `prUrl` that survives upstream sanitization. A hostile or
 * missing one is 422 `invalid_pr_url` and the row stays `committed` — every
 * other state keeps the drop-the-link-keep-the-state behaviour.
 */
export async function reportSponsoredRunState(
  proposalId: string,
  runToken: string,
  update: SponsoredStateUpdate,
  authToken: string,
): Promise<SponsoredWriteResult> {
  const attempt = await callDetailed<unknown>(
    `/api/v1/ads/proposal/${encodeURIComponent(proposalId)}/state`,
    authToken,
    { runToken, ...update },
  )
  return attempt.ok
    ? { ok: true, status: attempt.status }
    : { ok: false, status: attempt.status, message: attempt.message }
}

/**
 * Ask the agentic offer route whether this turn earns a sponsored offer.
 *
 * Once per user-typed turn, beside the turn and never in front of it. The
 * response names WHAT was offered and nothing about how to draw it: a proposal
 * is then read through `GET /api/v1/ads/proposal` like every other proposal.
 * Every failure -- transport, a non-2xx, a body the contract does not accept --
 * is null, which the caller treats exactly as `none`.
 *
 * The product User-Agent is load-bearing rather than cosmetic: the route admits
 * a CLI caller only beside a `Freebuff-CLI/` UA, the same pairing the display
 * auction applies to a `cli_*` capability.
 */
export async function requestAgenticOffer(
  body: AgenticOfferRequest,
  authToken: string,
  userAgent: string,
): Promise<AgenticOfferResponse | null> {
  try {
    const response = await fetch(`${baseUrl()}${AGENTIC_OFFER_PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${authToken}`,
        'content-type': 'application/json',
        'user-agent': userAgent,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const parsed = agenticOfferResponseSchema.safeParse(await response.json())
    return parsed.success ? parsed.data : null
  } catch (error) {
    logger.debug({ error }, '[sponsored-proposal] agentic offer failed')
    return null
  }
}

export async function setSponsoredProposalPrefs(
  update: { neverAdvertiserId: string } | { optedOut: boolean },
  authToken: string,
): Promise<boolean> {
  return (await call('POST', '/api/v1/ads/prefs', authToken, update)) !== null
}
