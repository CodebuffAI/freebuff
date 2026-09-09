import { normalizeRepoFullName } from '@codebuff/common/ads/sponsored-proposal-target'

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
}

/** One transition, exactly as the state route takes it (COD-396). */
export type SponsoredStateUpdate = {
  state: 'running' | 'committed' | 'failed' | 'landed'
  reportId?: string
  runId?: string
  head?: string
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
  | { ok: false; status: number; message: string }

const REQUEST_TIMEOUT_MS = 10_000

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
  const repo = normalizeRepoFullName(repoFullName)
  if (!repo) return { status: 'unavailable' }

  const path = `/api/v1/ads/proposal?repo=${encodeURIComponent(repo)}`
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
): Promise<
  | { ok: true; status: number; value: T }
  | { ok: false; status: number; message: string }
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    logger.debug({ error, path }, '[sponsored-proposal] request failed')
    // STATUS 0: never reached the server, so the caller may retry it. See
    // `SponsoredWriteResult`.
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
    // A 2xx whose body is not JSON is still a write that landed. Only the
    // accept needs the body, and it checks its own fields below.
    return { ok: true, status: response.status, value: {} as T }
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
  try {
    const body = (await response.json()) as {
      error?: unknown
      message?: unknown
    }
    const text = body?.error ?? body?.message
    if (typeof text === 'string' && text.trim() !== '') return text.trim()
  } catch {
    // fall through
  }
  return response.status === 401
    ? 'Sign in to Freebuff to accept a sponsored task.'
    : 'Freebuff refused this sponsored task.'
}

/**
 * Accept a repo-keyed proposal for a LOCAL run (COD-396).
 *
 * `surface: 'cli'` is not decoration: the upstream mutation branches on it to
 * decide that NOTHING is spawned server-side, and the accept route rejects any
 * value that is not `desktop` or `cli`.
 *
 * IDEMPOTENT within the token's TTL, which is what makes a retry after a lost
 * response safe — the same payload with the same `runToken` comes back, no
 * second funnel event is emitted, and a 409 `invalid_state` is not what a
 * dropped connection produces.
 */
export async function acceptSponsoredProposal(
  proposalId: string,
  authToken: string,
): Promise<SponsoredAcceptResult> {
  const attempt = await callDetailed<SponsoredAccept>(
    `/api/v1/ads/proposal/${encodeURIComponent(proposalId)}/accept`,
    authToken,
    { surface: 'cli' },
  )
  if (!attempt.ok) {
    return { ok: false, status: attempt.status, message: attempt.message }
  }
  // A 200 missing either field the run cannot proceed without is a REFUSAL,
  // not a run with an empty procedure: `callDetailed` degrades an unparseable
  // 2xx to `{}`, which is right for a write and exactly wrong here.
  if (!attempt.value?.procedure || !attempt.value?.runToken) {
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
 * Report where a local run has got to (`accepted → running → committed|failed`,
 * `accepted → failed`, `committed → landed`).
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

export async function setSponsoredProposalPrefs(
  update: { neverAdvertiserId: string } | { optedOut: boolean },
  authToken: string,
): Promise<boolean> {
  return (await call('POST', '/api/v1/ads/prefs', authToken, update)) !== null
}
