import { FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID } from '../constants/freebuff-model-ids'
import { SPONSORED_RUN_TOKEN_TTL_MS } from './sponsored-run-token'

import type {
  SponsoredExecutionSurface,
  SponsoredLocalTarget,
} from './sponsored-capability'
import type {
  SPONSORED_WINDOWS_EXECUTION_SURFACE,
  SponsoredExecutionContainment,
} from './sponsored-windows'
import type { SPONSORED_IN_PLACE_VERSION } from './sponsored-in-place'
import type { SPONSORED_RUN_SPEC_VERSION } from './sponsored-run-spec'
import type { SPONSORED_CONVERSION_TOOLS_VERSION } from './sponsored-conversion'

/** The clients a funded Accept can come from. */
export const SPONSORED_ACCEPT_SURFACES = ['desktop', 'cli', 'web'] as const

export type SponsoredAcceptSurface = (typeof SPONSORED_ACCEPT_SURFACES)[number]

/**
 * The funded Accept request, `POST /api/v1/ads/proposal/{id}/accept`, as the
 * accepting surface sends it and the route reads it.
 */
export type SponsoredAcceptRequest = {
  /**
   * Which kind of client accepts: `desktop` or `cli` over the bearer route,
   * `web` (the browser workspace) from the browser workspace's server.
   */
  surface: SponsoredAcceptSurface
  nativeDesktopTools?: boolean
  /** The run id the surface minted before consent. */
  runId: string
  /** The hash of the exact procedure the user consented to. */
  procedureSha256: string
  target?: SponsoredLocalTarget
  /**
   * The ACCEPTING CLIENT's own execution surface (COD-642): `desktop_windows`
   * from Windows Desktop, `desktop_macos` / `desktop_linux` otherwise. The
   * row's `execution_surface` says which machine the offer was minted for;
   * this says which machine is about to run it, so the two can be paired and
   * a client is never charged for a run it cannot execute (a Windows client
   * accepting a `desktop_macos` row, or the reverse). Optional on the wire
   * because an older client does not send it.
   */
  clientExecutionSurface?: SponsoredExecutionSurface
  /**
   * `1`: this client runs the accepted work IN PLACE, in the accepting
   * conversation, and its terminal state is `delivered`
   * (`./sponsored-in-place.ts`). Sent again here rather than inferred from
   * the offer, because an offer can outlive the build that was shown it: the
   * server records it on the row at Accept and binds the run's deliverable to
   * it from then on.
   */
  inPlaceExecutionVersion?: typeof SPONSORED_IN_PLACE_VERSION
  /**
   * `1`: this client runs the run spec (`./sponsored-run-spec.ts`). The 200
   * then carries `runSpec`, built from the server's own skill, on a fresh
   * Accept and on every replay of it. A procedure that names a skill the
   * server cannot resolve is refused `409 run_spec_unavailable` before
   * anything is charged (`503 run_spec_unavailable` on a replay, which
   * charges nothing again and is safe to retry).
   */
  runSpecVersion?: typeof SPONSORED_RUN_SPEC_VERSION
  /**
   * `1`: this client has the sponsored conversion tools
   * (`./sponsored-conversion.ts`). Without it a skill with a conversion
   * definition is refused before anything is charged: `409
   * client_update_required` on Desktop, `409 unsupported_surface` on the
   * CLI and web, which have no such tools in any build.
   */
  conversionToolsVersion?: typeof SPONSORED_CONVERSION_TOOLS_VERSION
  /**
   * A positive integer: this client has the `install_package` tool
   * (`./sponsored-package-resolve.ts`, COD-965). The run spec's prompt then
   * says to install through it. Untrusted; anything else reads as absent, and
   * an absent field leaves the prompt exactly as before.
   */
  installToolVersion?: number
}

/**
 * The same fact on the read-only preview (`GET .../accept`), which has no
 * body: a query parameter named like the body field.
 */
export const SPONSORED_ACCEPT_EXECUTION_SURFACE_PARAM =
  'clientExecutionSurface' as const satisfies keyof SponsoredAcceptRequest

/**
 * Whether a client on `clientSurface` may accept a row minted for
 * `rowSurface`. A row with no recorded surface (older rows, Cloud) is not a
 * mismatch; a recorded one must be exactly the client's own.
 */
export function sponsoredAcceptSurfaceMatchesRow(
  clientSurface: string | null | undefined,
  rowSurface: string | null | undefined,
): boolean {
  if (rowSurface === undefined || rowSurface === null) return true
  return clientSurface === rowSurface
}

/**
 * The pairing the funded Accept applies, on the server and on Desktop alike
 * (COD-642). The row's `execution_surface` says which machine the offer was
 * minted for; `clientExecutionSurface` says which machine is about to run it.
 *
 *  - Absent (a client older than the field, and the CLI, which never sends
 *    it): any row it could accept before COD-642, and NEVER a
 *    `desktop_windows` row, whose only legitimate client sends it.
 *  - `desktop_windows`: only a `desktop_windows` row. An unrecorded row is
 *    never one, so it is refused too.
 *  - Anything else: exactly the row's own surface when the row recorded one
 *    ({@link sponsoredAcceptSurfaceMatchesRow}).
 *
 * Linux (COD-655) needs no arm of its own: it follows macOS. `desktop_linux`
 * pairs only with a `desktop_linux` row, a macOS or Windows client is refused
 * on one, and an absent field is admitted exactly as it is on a macOS row,
 * since released Linux builds already run sponsored work under bubblewrap.
 */
export function acceptClientSurfacePairsWithRow(
  clientSurface: SponsoredExecutionSurface | null | undefined,
  rowSurface: string | null | undefined,
): boolean {
  const windows = 'desktop_windows' satisfies SponsoredExecutionSurface
  if (clientSurface === undefined || clientSurface === null)
    return rowSurface !== windows
  if (clientSurface === windows && rowSurface !== windows) return false
  return sponsoredAcceptSurfaceMatchesRow(clientSurface, rowSurface)
}

/**
 * How much ACTIVE time a grant may spend once its run has started.
 *
 * Active time is the run's working time, not wall time: the server adds up
 * the gaps between consecutive reserved calls, each gap capped at
 * {@link SPONSORED_ACTIVE_GAP_CAP_MS} ({@link sponsoredActiveMsAfterCall}),
 * and Desktop pauses its own clock while the run is parked on the user (a
 * sign-up card, a credential form, a CLI login). A run waiting on the user
 * is bounded only by the run token ({@link SPONSORED_COMPUTE_START_DEADLINE_MS},
 * Accept + 24h). Replaced the 60-minute wall-clock window, which killed ~121
 * Desktop runs a week at exactly 60 minutes while they waited on the user.
 */
export const SPONSORED_COMPUTE_ACTIVE_WINDOW_MS = 90 * 60_000

/**
 * The most one gap between two reserved calls can add to a grant's active
 * time. A longer gap is the run waiting (on the user, or on a long command
 * Desktop is timing itself), and counts only this much.
 */
export const SPONSORED_ACTIVE_GAP_CAP_MS = 5 * 60_000

/**
 * A grant's active time after one more reserved call at `nowMs`: the previous
 * total plus the gap since the last call, capped at
 * {@link SPONSORED_ACTIVE_GAP_CAP_MS}. The first call (`lastCallAtMs` null)
 * adds nothing, and a clock that went backwards adds nothing.
 */
export function sponsoredActiveMsAfterCall(
  prevActiveMs: number,
  lastCallAtMs: number | null,
  nowMs: number,
): number {
  if (lastCallAtMs === null) return prevActiveMs
  const gap = Math.max(0, nowMs - lastCallAtMs)
  return prevActiveMs + Math.min(gap, SPONSORED_ACTIVE_GAP_CAP_MS)
}

/** Whether a grant has spent its active window. */
export function sponsoredActiveWindowSpent(activeMs: number): boolean {
  return activeMs > SPONSORED_COMPUTE_ACTIVE_WINDOW_MS
}

/**
 * @deprecated The wall-clock run window (COD-665), now equal to
 * {@link SPONSORED_COMPUTE_ACTIVE_WINDOW_MS}. Kept for the clients that cannot
 * tell waiting from working (the CLI's local cutoff via
 * {@link sponsoredComputeRunDeadlineMs}) and for the legacy Convex sweep. The
 * server no longer brings a grant's `expires_at` in by it; it meters active
 * time instead.
 */
export const SPONSORED_COMPUTE_RUN_WINDOW_MS =
  SPONSORED_COMPUTE_ACTIVE_WINDOW_MS

/**
 * How long an accepted grant may wait for its run to start: the hard end of
 * every grant, measured from Accept, so one whose turn never comes still dies.
 *
 * The run token's lifetime, on purpose. A run that starts later than this
 * could not report its own verdict, so a grant that outlived the token would
 * fund work nobody can close out.
 */
export const SPONSORED_COMPUTE_START_DEADLINE_MS = SPONSORED_RUN_TOKEN_TTL_MS

/**
 * The deadline a grant has once its run starts at `startedAtMs`: the run
 * window from then, never past the grant's own expiry.
 *
 * A minimum, so it is safe to apply on EVERY call and not only the first: a
 * later start can never push the deadline out, and the first one fixes it.
 * The same rule on both sides, which is what keeps Desktop's local cutoff at
 * or before the server's -- Desktop applies it when the turn takes the grant,
 * a moment before that turn's first call reaches the server. A grant issued
 * before COD-665 already expires an hour after Accept, and this leaves it so.
 *
 * Wall clock: the server no longer applies it (it meters active time), so it
 * only bounds a client that cannot pause its clock while waiting on the user.
 */
export function sponsoredComputeRunDeadlineMs(
  grantExpiresAtMs: number,
  startedAtMs: number,
): number {
  return Math.min(
    grantExpiresAtMs,
    startedAtMs + SPONSORED_COMPUTE_RUN_WINDOW_MS,
  )
}

/**
 * How long past a running off-Cloud run's spend window the server waits
 * before its stale sweep fails the row (`running_window` in
 * `sponsoredExecution.ts`). A turn's last calls can land a little after its
 * grant closes, and the client's terminal report after that; half an hour
 * covers both without leaving a dead run on the card for a day.
 */
export const SPONSORED_RUNNING_SWEEP_GRACE_MS = 30 * 60_000

/**
 * How long a Freebuff Web Accept may wait for its run to START before the
 * stale sweep fails it (`web_start` in `sponsoredExecution.ts`), and before
 * the web worker refuses to start it.
 *
 * Web runs on OUR worker, which reports `running` before the turn's first
 * call, so the 24-hour run-token clock the off-Cloud rows wait on would only
 * leave a spinner on the card when the queued run was lost. The run waits
 * behind at most the chat's current turn; two hours covers a long one. The
 * worker applies the same deadline, so a run the sweep could fail is never
 * started.
 */
export const SPONSORED_WEB_START_WINDOW_MS = 2 * 60 * 60_000

/**
 * When the stale sweep may fail an off-Cloud row that reported `running` at
 * `runningAtMs`. Never past the run token's own expiry (measured from Accept),
 * because a report after that could not be authenticated anyway, and:
 *
 *  - parked on the user (`awaitingUserSinceMs` set): exactly the token's
 *    expiry. Waiting on the user does not count against the run.
 *  - otherwise: a full {@link SPONSORED_COMPUTE_ACTIVE_WINDOW_MS} from the
 *    latest of the run's start, its last reserved call and the moment it
 *    last resumed from waiting on the user (`resumedAtMs`), plus
 *    {@link SPONSORED_RUNNING_SWEEP_GRACE_MS}. A live run cannot have more
 *    than the active window left after any call, so a long command that makes
 *    no calls is never swept before Desktop's own cutoff.
 *
 * Called with two arguments (the legacy Convex sweep), it is the second arm
 * from `runningAtMs`.
 */
export function sponsoredRunningSweepDeadlineMs(
  runningAtMs: number,
  acceptedAtMs: number,
  activity: Readonly<{
    lastReservedAtMs?: number | null
    awaitingUserSinceMs?: number | null
    /** When the run last stopped waiting on the user (the marker cleared). */
    resumedAtMs?: number | null
  }> = {},
): number {
  const tokenExpiry = acceptedAtMs + SPONSORED_RUN_TOKEN_TTL_MS
  if (
    activity.awaitingUserSinceMs !== undefined &&
    activity.awaitingUserSinceMs !== null
  )
    return tokenExpiry
  const lastActivity = Math.max(
    runningAtMs,
    activity.lastReservedAtMs ?? 0,
    activity.resumedAtMs ?? 0,
  )
  return Math.min(
    lastActivity +
      SPONSORED_COMPUTE_ACTIVE_WINDOW_MS +
      SPONSORED_RUNNING_SWEEP_GRACE_MS,
    tokenExpiry,
  )
}

/**
 * The run-state report a Desktop run sends while it is parked on the user (a
 * sign-up card, a credential form, a CLI login):
 * `POST /api/v1/ads/proposal/{id}/state` with
 * `{ runToken, state: 'awaiting_user', runId }`. It sets the row's
 * `awaiting_user_since` (kept if already set), and the next `running` report
 * clears it and stamps `awaiting_user_resumed_at`, from which the sweep gives
 * the resumed run a fresh active window. Neither writes a funnel row or changes the row's state. A server
 * older than this answers 400 for it, which the client ignores.
 */
export const SPONSORED_AWAITING_USER_STATE = 'awaiting_user' as const

/** Public response shape. The bearer belongs in host memory, never a thread. */
export type SponsoredComputeGrant = Readonly<{
  token: string
  proposalId: string
  runId: string
  procedureSha256: string
  modelId: string
  /**
   * The grant's hard end: Accept + {@link SPONSORED_COMPUTE_START_DEADLINE_MS}
   * (the run token's life). Within it the server meters ACTIVE time against
   * {@link SPONSORED_COMPUTE_ACTIVE_WINDOW_MS}. A grant whose run started
   * before the active clock shipped may carry an `expires_at` already brought
   * in to its start + 1h, and a replayed Accept answers that value.
   */
  expiresAtMs: number
  allowanceUsdMicros: number
  /**
   * Present ONLY on a grant for a Windows offer (COD-642), and then both are:
   * the surface the server granted and the containment that applies — the
   * floor, not an OS sandbox. A client selects its floor-only broker only
   * when it runs on Windows AND this grant names `desktop_windows`; never as
   * a fallback. Absent means the client's own OS sandbox (macOS/Linux).
   */
  executionSurface?: typeof SPONSORED_WINDOWS_EXECUTION_SURFACE
  containment?: SponsoredExecutionContainment
}>

/**
 * Which campaigns the sponsored runtime may execute. `all` admits every
 * campaign; each consumer still requires the campaign's own reviewed procedure,
 * so approval is what makes a campaign runnable. `listed` is the scalpel.
 */
export type SponsoredComputeCampaigns =
  | Readonly<{ kind: 'all' }>
  | Readonly<{ kind: 'listed'; ids: readonly string[] }>

export type SponsoredComputePolicy = Readonly<{
  modelId: string
  campaigns: SponsoredComputeCampaigns
  allowanceUsdMicros: number
  acceptancePriceCents: number
  /**
   * The grant's active-time budget once its run has started
   * ({@link SPONSORED_COMPUTE_ACTIVE_WINDOW_MS}); not wall time.
   */
  ttlMs: number
}>

export type SponsoredComputePolicyEnv = {
  FREEBUFF_SPONSORED_COMPUTE_ENABLED?: string
  FREEBUFF_SPONSORED_COMPUTE_CAMPAIGN_IDS?: string
  FREEBUFF_SPONSORED_COMPUTE_MODEL_ID?: string
  FREEBUFF_SPONSORED_COMPUTE_ACCEPTANCE_PRICE_CENTS?: string
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Absent preserves the existing paid contract; malformed prices close admission. */
export function sponsoredComputeAcceptancePriceCents(
  raw?: string,
): number | null {
  if (raw === undefined) return 200
  if (!/^[1-9][0-9]*$/.test(raw)) return null
  const cents = Number(raw)
  return Number.isSafeInteger(cents) ? cents : null
}

/** The value of `FREEBUFF_SPONSORED_COMPUTE_CAMPAIGN_IDS` that admits every campaign. */
export const SPONSORED_COMPUTE_ALL_CAMPAIGNS = '*'

function parseSponsoredComputeCampaigns(
  raw: string | undefined,
): SponsoredComputeCampaigns | null {
  const trimmed = raw?.trim()
  if (!trimmed) return null
  // Only the whole value. `*,<uuid>` is a typo, and a typo must close
  // admission rather than widen it.
  if (trimmed === SPONSORED_COMPUTE_ALL_CAMPAIGNS) {
    return Object.freeze({ kind: 'all' })
  }
  const ids = trimmed.split(',').map((id) => id.trim())
  if (ids.length > 100 || ids.some((id) => !UUID.test(id))) return null
  return Object.freeze({
    kind: 'listed',
    ids: Object.freeze([...new Set(ids)]),
  })
}

/** Whether the sponsored runtime may execute this campaign's reviewed procedure. */
export function sponsoredComputeAdmitsCampaign(
  policy: Pick<SponsoredComputePolicy, 'campaigns'>,
  campaignId: string,
): boolean {
  return policy.campaigns.kind === 'all'
    ? UUID.test(campaignId)
    : policy.campaigns.ids.includes(campaignId)
}

/** Server configuration only. An absent or incomplete policy admits nothing. */
export function readSponsoredComputePolicy(
  env: SponsoredComputePolicyEnv,
): SponsoredComputePolicy | null {
  if (env.FREEBUFF_SPONSORED_COMPUTE_ENABLED !== 'true') return null
  const acceptancePriceCents = sponsoredComputeAcceptancePriceCents(
    env.FREEBUFF_SPONSORED_COMPUTE_ACCEPTANCE_PRICE_CENTS,
  )
  const modelId = env.FREEBUFF_SPONSORED_COMPUTE_MODEL_ID?.trim()
  const campaigns = parseSponsoredComputeCampaigns(
    env.FREEBUFF_SPONSORED_COMPUTE_CAMPAIGN_IDS,
  )
  if (
    acceptancePriceCents === null ||
    !modelId ||
    modelId !== FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID ||
    modelId.length > 128 ||
    !/^[a-zA-Z0-9._:/-]+$/.test(modelId) ||
    !campaigns
  )
    return null
  return Object.freeze({
    modelId,
    campaigns,
    // The configured acceptance fee is the only commercial charge. Compute is an
    // internal, bounded cost of fulfilling that offer, capped here.
    allowanceUsdMicros: 2_500_000,
    acceptancePriceCents,
    ttlMs: SPONSORED_COMPUTE_ACTIVE_WINDOW_MS,
  })
}
