import {
  canFreebuffModelSpawnGeminiThinker,
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_DEPLOYMENT_HOURS_LABEL,
  FREEBUFF_GEMINI_PRO_MODEL_ID,
  FREEBUFF_LIMITED_SESSION_LIMIT,
  FREEBUFF_LIMITED_SESSION_PERIOD,
  FREEBUFF_LIMITED_SESSION_RESET_TIMEZONE,
  FREEBUFF_LIMITED_SESSION_WINDOW_HOURS,
  FREEBUFF_PREMIUM_MODEL_IDS,
  FREEBUFF_PREMIUM_SESSION_PERIOD,
  FREEBUFF_PREMIUM_SESSION_LIMIT,
  FREEBUFF_PREMIUM_SESSION_RESET_TIMEZONE,
  FREEBUFF_PREMIUM_SESSION_WINDOW_HOURS,
  isFreebuffModelAllowedForAccessTier,
  isFreebuffModelAvailable,
  isFreebuffPremiumModelId,
  isSupportedFreebuffModelId,
  resolveFreebuffModelForAccessTier,
} from '@codebuff/common/constants/freebuff-models'
import { getZonedDayBounds } from '@codebuff/common/util/zoned-time'

import {
  getInstantAdmitCapacity,
  getSessionGraceMs,
  getSessionLengthMs,
} from './config'
import {
  activeCountForModel,
  endSession,
  FreeSessionModelLockedError,
  getSessionRow,
  joinOrTakeOver,
  listRecentPremiumAdmits,
  promoteQueuedUser,
  queueDepthsByModel,
  queuePositionFor,
} from './store'
import { toSessionStateResponse } from './session-view'

import type { FreebuffAccessTier } from '@codebuff/common/constants/freebuff-models'
import type {
  FreebuffSessionRateLimit,
  FreebuffSessionServerResponse,
} from '@codebuff/common/types/freebuff-session'
import type {
  FreeSessionCountryAccessMetadata,
  InternalSessionRow,
  SessionStateResponse,
} from './types'

function roundSessionUnits(units: number): number {
  return Math.round(units * 10) / 10
}

function canStartSession(snapshot: FreebuffSessionRateLimit): boolean {
  return snapshot.recentCount < snapshot.limit
}

type SessionQuotaInfo = Omit<FreebuffSessionRateLimit, 'model'>

interface SessionQuotaSnapshot {
  info: SessionQuotaInfo
  resetsAt: Date
}

interface SessionQuotaConfig {
  models: readonly string[]
  limit: number
  period: 'pacific_day'
  resetTimeZone: string
  windowHours: number
  accessTier?: FreebuffAccessTier
}

function quotaConfigForModel(
  model: string,
  accessTier: FreebuffAccessTier,
): SessionQuotaConfig | undefined {
  if (accessTier === 'full' && !isFreebuffPremiumModelId(model)) {
    return undefined
  }
  return quotaConfigForAccessTier(accessTier)
}

function quotaConfigForAccessTier(
  accessTier: FreebuffAccessTier,
): SessionQuotaConfig {
  if (accessTier === 'limited') {
    return {
      models: [FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID],
      limit: FREEBUFF_LIMITED_SESSION_LIMIT,
      period: FREEBUFF_LIMITED_SESSION_PERIOD,
      resetTimeZone: FREEBUFF_LIMITED_SESSION_RESET_TIMEZONE,
      windowHours: FREEBUFF_LIMITED_SESSION_WINDOW_HOURS,
      accessTier,
    }
  }
  return {
    models: FREEBUFF_PREMIUM_MODEL_IDS,
    limit: FREEBUFF_PREMIUM_SESSION_LIMIT,
    period: FREEBUFF_PREMIUM_SESSION_PERIOD,
    resetTimeZone: FREEBUFF_PREMIUM_SESSION_RESET_TIMEZONE,
    windowHours: FREEBUFF_PREMIUM_SESSION_WINDOW_HOURS,
    accessTier,
  }
}

async function fetchSessionQuotaSnapshot(
  userId: string,
  config: SessionQuotaConfig,
  deps: SessionDeps,
): Promise<SessionQuotaSnapshot> {
  const now = nowOf(deps)
  const day = getZonedDayBounds(now, config.resetTimeZone)
  const admits = await deps.listRecentPremiumAdmits({
    userId,
    since: day.startsAt,
    models: config.models,
    accessTier: config.accessTier,
  })
  const recentCount = roundSessionUnits(
    admits.reduce((sum, admit) => sum + admit.sessionUnits, 0),
  )
  return {
    info: {
      limit: config.limit,
      period: config.period,
      resetTimeZone: config.resetTimeZone,
      resetAt: day.resetsAt.toISOString(),
      windowHours: config.windowHours,
      recentCount,
    },
    resetsAt: day.resetsAt,
  }
}

function toRateLimitInfo(
  model: string,
  snapshot: SessionQuotaSnapshot,
): FreebuffSessionRateLimit {
  return {
    model,
    ...snapshot.info,
  }
}

/** Fetch the caller's current shared premium-session quota snapshot for
 *  `model`, or undefined if the model is unlimited. Used by both POST (after
 *  admit) and GET polls so the CLI's "N of M sessions used" line stays live
 *  instead of disappearing after the first poll. */
async function fetchRateLimitSnapshot(
  userId: string,
  model: string,
  accessTier: FreebuffAccessTier,
  deps: SessionDeps,
): Promise<
  | {
      info: FreebuffSessionRateLimit
      resetsAt: Date
    }
  | undefined
> {
  const config = quotaConfigForModel(model, accessTier)
  if (!config) return undefined
  const snapshot = await fetchSessionQuotaSnapshot(userId, config, deps)
  return {
    info: toRateLimitInfo(model, snapshot),
    resetsAt: snapshot.resetsAt,
  }
}

async function fetchRateLimitsByModel(
  userId: string,
  accessTier: FreebuffAccessTier,
  deps: SessionDeps,
): Promise<Record<string, FreebuffSessionRateLimit>> {
  const config = quotaConfigForAccessTier(accessTier)
  const snapshot = await fetchSessionQuotaSnapshot(userId, config, deps)
  return Object.fromEntries(
    config.models.map(
      (model) => [model, toRateLimitInfo(model, snapshot)] as const,
    ),
  )
}

function onlyUsedRateLimitsByModel(
  rateLimitsByModel: Record<string, FreebuffSessionRateLimit>,
): Record<string, FreebuffSessionRateLimit> {
  return Object.fromEntries(
    Object.entries(rateLimitsByModel).filter(
      ([, snapshot]) => snapshot.recentCount > 0,
    ),
  )
}

function nonEmptyRateLimitsByModel(
  rateLimitsByModel: Record<string, FreebuffSessionRateLimit>,
): { rateLimitsByModel: Record<string, FreebuffSessionRateLimit> } | {} {
  return Object.keys(rateLimitsByModel).length > 0 ? { rateLimitsByModel } : {}
}

export interface SessionDeps {
  getSessionRow: (userId: string) => Promise<InternalSessionRow | null>
  joinOrTakeOver: (params: {
    userId: string
    model: string
    accessTier: FreebuffAccessTier
    now: Date
    countryAccess?: FreeSessionCountryAccessMetadata
  }) => Promise<InternalSessionRow>
  endSession: (params: {
    userId: string
    now: Date
    sessionLengthMs: number
  }) => Promise<void>
  queueDepthsByModel: () => Promise<Record<string, number>>
  queuePositionFor: (params: {
    userId: string
    model: string
    queuedAt: Date
  }) => Promise<number>
  /** Instant-admit check: returns the number of active sessions currently
   *  bound to a given model. Compared against the model's configured
   *  `instantAdmitCapacity` to decide whether a new joiner skips the queue. */
  activeCountForModel: (model: string) => Promise<number>
  /** Rate-limit helper: oldest-first premium admissions since today's
   *  Pacific midnight reset. */
  listRecentPremiumAdmits: (params: {
    userId: string
    models: readonly string[]
    since: Date
    accessTier?: FreebuffAccessTier
  }) => Promise<{ admittedAt: Date; model: string; sessionUnits: number }[]>
  /** Instant-admit promotion: flips a specific queued row to active. Returns
   *  the updated row or null if the row wasn't in a queued state. */
  promoteQueuedUser: (params: {
    userId: string
    model: string
    sessionLengthMs: number
    now: Date
  }) => Promise<InternalSessionRow | null>
  /** Per-model capacity lookup. Indirected through deps so tests can
   *  force-enable / force-disable instant admit without mutating the
   *  shared model registry. */
  getInstantAdmitCapacity: (model: string) => number
  /** Plain values, not getters: these never change at runtime. The deps
   *  interface uses values rather than thunks so tests can pass numbers
   *  inline without wrapping. */
  graceMs: number
  sessionLengthMs: number
  now?: () => Date
}

const defaultDeps: SessionDeps = {
  getSessionRow,
  joinOrTakeOver,
  endSession,
  queueDepthsByModel,
  queuePositionFor,
  activeCountForModel,
  listRecentPremiumAdmits,
  promoteQueuedUser,
  getInstantAdmitCapacity,
  get graceMs() {
    // Read-through getter keeps the default deps aligned with config while
    // tests can still inject a plain graceMs value through SessionDeps.
    return getSessionGraceMs()
  },
  get sessionLengthMs() {
    return getSessionLengthMs()
  },
}

const nowOf = (deps: SessionDeps): Date => (deps.now ?? (() => new Date()))()

function isSessionRowCompatibleWithAccessTier(
  row: InternalSessionRow,
  accessTier: FreebuffAccessTier,
): boolean {
  if (accessTier === 'limited' && (row.access_tier ?? 'full') !== 'limited') {
    return false
  }
  return isFreebuffModelAllowedForAccessTier(row.model, accessTier)
}

async function viewForRow(
  userId: string,
  deps: SessionDeps,
  row: InternalSessionRow,
): Promise<SessionStateResponse | null> {
  const [position, depthsByModel] =
    row.status === 'queued'
      ? await Promise.all([
          deps.queuePositionFor({
            userId,
            model: row.model,
            queuedAt: row.queued_at,
          }),
          deps.queueDepthsByModel(),
        ])
      : [0, {}]
  return toSessionStateResponse({
    row,
    position,
    queueDepthByModel: depthsByModel,
    graceMs: deps.graceMs,
    now: nowOf(deps),
  })
}

export type RequestSessionResult =
  | SessionStateResponse
  | {
      /** User asked to queue/switch to a different model while their active
       *  session is still bound to another. The CLI must end the existing
       *  session first (DELETE /session) before re-queueing. */
      status: 'model_locked'
      accessTier?: FreebuffAccessTier
      currentModel: string
      requestedModel: string
    }
  | {
      /** User has hit the per-model admission quota for the current Pacific day.
       *  See `FreebuffSessionServerResponse`'s `rate_limited` variant. */
      status: 'rate_limited'
      accessTier?: FreebuffAccessTier
      model: string
      limit: number
      period: 'pacific_day'
      resetTimeZone: string
      resetAt: string
      windowHours: number
      recentCount: number
      retryAfterMs: number
    }
  | {
      status: 'model_unavailable'
      accessTier?: FreebuffAccessTier
      requestedModel: string
      availableHours: string
    }

/**
 * Client calls this on CLI startup with the model they want to use.
 * Semantics:
 *   - No existing session → create queued row for `model`, fresh instance_id
 *   - Existing active (unexpired), same model → rotate instance_id (takeover)
 *   - Existing active (unexpired), different model → { status: 'model_locked' }
 *   - Existing queued, same model → rotate instance_id, preserve position
 *   - Existing queued, different model → switch to new model and join the
 *     back of that model's queue
 *   - Existing expired → re-queue at the back of `model`'s queue with fresh
 *     instance_id
 *
 * `joinOrTakeOver` (when it doesn't throw) always returns a row that maps to
 * a non-null view (queued or active-unexpired), so the cast below is sound.
 */
export async function requestSession(params: {
  userId: string
  model: string
  accessTier?: FreebuffAccessTier
  countryAccess?: FreeSessionCountryAccessMetadata
  /** True if the account is banned. Short-circuited here so banned bots never
   *  create a queued row — otherwise they inflate `queueDepth` between the
   *  15s admission ticks that run `evictBanned`. */
  userBanned?: boolean
  deps?: SessionDeps
}): Promise<RequestSessionResult> {
  const deps = params.deps ?? defaultDeps
  const accessTier = params.accessTier ?? 'full'
  const model = resolveFreebuffModelForAccessTier(params.model, accessTier)
  const now = nowOf(deps)
  if (params.userBanned) {
    return { status: 'banned' }
  }

  // Rate-limit check runs before joinOrTakeOver so heavy users never even
  // create a queued row. Premium models share one daily Pacific-time
  // session-unit pool; Minimax falls through unchanged as unlimited.
  //
  // Takeover/reclaim exception: a user who already holds a queued or
  // active+unexpired row on this same model is re-anchoring (CLI restart,
  // same-account tab switch) rather than starting a new session. Admit
  // counts are written at promotion time, so the quota only needs to gate
  // fresh admissions — blocking a reclaim here would strand a user with an
  // active 5th session unable to reconnect after a CLI restart.
  let existing = await deps.getSessionRow(params.userId)
  if (existing && !isSessionRowCompatibleWithAccessTier(existing, accessTier)) {
    await deps.endSession({
      userId: params.userId,
      now,
      sessionLengthMs: deps.sessionLengthMs,
    })
    existing = null
  }
  const isReclaim =
    !!existing &&
    existing.model === model &&
    (existing.access_tier ?? 'full') === accessTier &&
    (existing.status === 'queued' ||
      (existing.status === 'active' &&
        !!existing.expires_at &&
        existing.expires_at.getTime() > now.getTime()))

  if (!isReclaim && !isFreebuffModelAvailable(model, now)) {
    return {
      status: 'model_unavailable',
      requestedModel: model,
      availableHours: FREEBUFF_DEPLOYMENT_HOURS_LABEL,
    }
  }

  if (!isReclaim) {
    const snapshot = await fetchRateLimitSnapshot(
      params.userId,
      model,
      accessTier,
      deps,
    )
    if (snapshot && !canStartSession(snapshot.info)) {
      const retryAfterMs = Math.max(
        0,
        snapshot.resetsAt.getTime() - now.getTime(),
      )
      return {
        ...snapshot.info,
        status: 'rate_limited',
        accessTier,
        retryAfterMs,
      }
    }
  }

  let row: InternalSessionRow
  try {
    row = await deps.joinOrTakeOver({
      userId: params.userId,
      model,
      accessTier,
      now,
      countryAccess: params.countryAccess,
    })
  } catch (err) {
    if (err instanceof FreeSessionModelLockedError) {
      return {
        status: 'model_locked',
        currentModel: err.currentModel,
        requestedModel: model,
        accessTier,
      }
    }
    throw err
  }

  // Instant-admit: if the model has spare capacity (fewer active sessions
  // than its configured `instantAdmitCapacity`), skip the waiting room
  // entirely and flip the user to active in this same request. The tick
  // + FIFO queue only engage once we hit the threshold, so backpressure
  // kicks in exactly when the deployment needs it.
  //
  // Race note: two concurrent joiners may each see `active < capacity`
  // and both get admitted, overshooting the cap by up to `concurrency - 1`.
  // Capacities are chosen with headroom for this, and the configured
  // value is a comfort threshold not a hard ceiling.
  if (row.status === 'queued') {
    const capacity = deps.getInstantAdmitCapacity(model)
    if (capacity > 0) {
      const activeCount = await deps.activeCountForModel(model)
      if (activeCount < capacity) {
        const promoted = await deps.promoteQueuedUser({
          userId: params.userId,
          model,
          sessionLengthMs: deps.sessionLengthMs,
          now,
        })
        if (promoted) row = promoted
      }
    }
  }

  const view = await viewForRow(params.userId, deps, row)
  if (!view) {
    throw new Error(
      `joinOrTakeOver returned a row that maps to no view (user=${params.userId})`,
    )
  }
  return attachRateLimit(params.userId, view, deps)
}

/** Thread the current quota snapshot onto queued/active/ended views so the
 *  CLI can render "N of M sessions used" — both during the session and on
 *  the post-session banner. Other statuses pass through unchanged. Called on
 *  both POST and GET so the line stays live across polls. */
async function attachRateLimit(
  userId: string,
  view: SessionStateResponse,
  deps: SessionDeps,
): Promise<SessionStateResponse> {
  if (
    view.status !== 'queued' &&
    view.status !== 'active' &&
    view.status !== 'ended'
  ) {
    return view
  }
  const accessTier = view.accessTier ?? 'full'
  const allRateLimitsByModel = await fetchRateLimitsByModel(
    userId,
    accessTier,
    deps,
  )
  // The ended view doesn't carry a model id, so it gets the full snapshot
  // unfiltered — the banner reads any entry's recentCount (they all share the
  // same daily premium pool). Queued/active filter out unused models so the
  // landing screen and waiting-room title don't list every premium model with
  // a "0 used today" hint.
  if (view.status === 'ended') {
    return { ...view, rateLimitsByModel: allRateLimitsByModel }
  }
  const rateLimit = allRateLimitsByModel[view.model]
  return {
    ...view,
    ...(rateLimit ? { rateLimit } : {}),
    ...nonEmptyRateLimitsByModel(
      onlyUsedRateLimitsByModel(allRateLimitsByModel),
    ),
  }
}

/**
 * Check of the caller's current state. Does not rotate `instance_id`. The CLI
 * sends its currently-held `claimedInstanceId` so we can return `superseded`
 * if a newer CLI on the same account took over. Mutates only to clear rows
 * that the current access tier can no longer use, so they don't leak queue or
 * active capacity after the CLI receives `none`.
 *
 * Returns:
 *   - `none` when the user has no row at all (or the row was swept past
 *     the grace window)
 *   - `superseded` when the caller's id no longer matches the stored one
 *     (active sessions only — a queued row's id always wins)
 *   - `queued` / `active` / `ended` otherwise (see `toSessionStateResponse`)
 */
export async function getSessionState(params: {
  userId: string
  accessTier?: FreebuffAccessTier
  userBanned?: boolean
  claimedInstanceId?: string | null | undefined
  deps?: SessionDeps
}): Promise<FreebuffSessionServerResponse> {
  const deps = params.deps ?? defaultDeps
  const accessTier = params.accessTier ?? 'full'
  if (params.userBanned) {
    return { status: 'banned' }
  }
  const row = await deps.getSessionRow(params.userId)

  // Build a `none` response with live queue depths so the CLI's pre-join
  // picker can show "N ahead" hints without first committing the user to a
  // queue, plus per-user quota snapshots so exhausted models are visible
  // before POST.
  const noneResponse = async (): Promise<FreebuffSessionServerResponse> => {
    const [queueDepthByModel, rateLimitsByModel] = await Promise.all([
      deps.queueDepthsByModel(),
      fetchRateLimitsByModel(params.userId, accessTier, deps),
    ])
    return {
      status: 'none',
      accessTier,
      queueDepthByModel,
      ...nonEmptyRateLimitsByModel(
        onlyUsedRateLimitsByModel(rateLimitsByModel),
      ),
    }
  }

  if (!row) return noneResponse()

  if (!isSessionRowCompatibleWithAccessTier(row, accessTier)) {
    await deps.endSession({
      userId: params.userId,
      now: nowOf(deps),
      sessionLengthMs: deps.sessionLengthMs,
    })
    return noneResponse()
  }

  if (
    row.status === 'active' &&
    params.claimedInstanceId &&
    params.claimedInstanceId !== row.active_instance_id
  ) {
    return { status: 'superseded' }
  }

  const view = await viewForRow(params.userId, deps, row)
  if (!view) return noneResponse()
  return attachRateLimit(params.userId, view, deps)
}

export async function endUserSession(params: {
  userId: string
  deps?: SessionDeps
}): Promise<void> {
  const deps = params.deps ?? defaultDeps
  await deps.endSession({
    userId: params.userId,
    now: nowOf(deps),
    sessionLengthMs: deps.sessionLengthMs,
  })
}

export type SessionGateResult =
  | { ok: true; reason: 'active'; remainingMs: number }
  | {
      ok: true
      reason: 'draining'
      /** Time remaining until the hard cutoff (`expires_at + grace`). */
      gracePeriodRemainingMs: number
    }
  | { ok: false; code: 'waiting_room_required'; message: string }
  | { ok: false; code: 'waiting_room_queued'; message: string }
  | { ok: false; code: 'session_superseded'; message: string }
  | { ok: false; code: 'session_expired'; message: string }
  /** Active session locked to a different model than the one requested. The
   *  CLI should restart its session (DELETE then POST) to switch models. */
  | { ok: false; code: 'session_model_mismatch'; message: string }
  /** Pre-waiting-room CLI that never sends an instance id. Surfaced as a
   *  distinct code so the caller can prompt the user to restart. */
  | { ok: false; code: 'freebuff_update_required'; message: string }

/**
 * Called from the chat/completions hot path for free-mode requests. Either
 * returns `{ ok: true }` (request may proceed) or a structured rejection
 * the caller translates into a 4xx response.
 *
 * Never trusts client timestamps. The caller supplies `claimedInstanceId`
 * exactly as the CLI sent it; we compare against the server-stored
 * active_instance_id. Does a single DB read (the row); we intentionally do
 * NOT compute queue position on rejection — the client polls GET /session
 * for that detail.
 */
export async function checkSessionAdmissible(params: {
  userId: string
  accessTier?: FreebuffAccessTier
  claimedInstanceId: string | null | undefined
  /** Forces a real active session row check for subagent/model combinations
   *  that must be bound to trusted session state. */
  requireActiveSession?: boolean
  /** Model the chat-completions request is for. When provided, the gate
   *  rejects requests whose model doesn't match the active session's model
   *  so a stale CLI tab can't slip a request through under the wrong model. */
  requestedModel?: string | null | undefined
  deps?: SessionDeps
}): Promise<SessionGateResult> {
  const deps = params.deps ?? defaultDeps
  const accessTier = params.accessTier ?? 'full'

  // Pre-waiting-room CLIs never send a freebuff_instance_id. Classify that up
  // front so the caller gets a distinct code (→ 426 Upgrade Required) and the
  // user sees a clear "please restart" message instead of a gate reject they
  // can't interpret.
  if (!params.claimedInstanceId) {
    return {
      ok: false,
      code: 'freebuff_update_required',
      message:
        'This version of freebuff is out of date. Please restart freebuff to upgrade and continue using free mode.',
    }
  }

  const row = await deps.getSessionRow(params.userId)

  if (!row) {
    return {
      ok: false,
      code: 'waiting_room_required',
      message:
        'No active free session. Call POST /api/v1/freebuff/session first.',
    }
  }

  if (row.status === 'queued') {
    return {
      ok: false,
      code: 'waiting_room_queued',
      message:
        'You are in the waiting room. Poll GET /api/v1/freebuff/session for your position.',
    }
  }

  const now = nowOf(deps)
  const nowMs = now.getTime()
  const expiresAtMs = row.expires_at?.getTime() ?? 0
  const graceMs = deps.graceMs
  // Past the hard cutoff (`expires_at + grace`). The grace window lets the CLI
  // finish an in-flight agent run after the user's session ended; once it's
  // gone, we fall back to the same re-queue flow as a regular expiry.
  if (!row.expires_at || expiresAtMs + graceMs <= nowMs) {
    return {
      ok: false,
      code: 'session_expired',
      message:
        'Your free session has expired. Re-join the waiting room via POST /api/v1/freebuff/session.',
    }
  }

  if (params.claimedInstanceId !== row.active_instance_id) {
    return {
      ok: false,
      code: 'session_superseded',
      message:
        'Another instance of freebuff has taken over this session. Only one instance per account is allowed.',
    }
  }

  if (!isSessionRowCompatibleWithAccessTier(row, accessTier)) {
    return {
      ok: false,
      code: 'session_model_mismatch',
      message:
        'This free session is not valid for limited access. Restart freebuff to switch to DeepSeek V4 Flash.',
    }
  }

  if (
    accessTier === 'limited' &&
    params.requestedModel &&
    isSupportedFreebuffModelId(params.requestedModel) &&
    !isFreebuffModelAllowedForAccessTier(params.requestedModel, accessTier)
  ) {
    return {
      ok: false,
      code: 'session_model_mismatch',
      message: 'Limited free access is only available with DeepSeek V4 Flash.',
    }
  }

  // Smart freebuff models (Kimi, DeepSeek) can spawn the gemini-thinker
  // child agent which calls Gemini Pro under the hood. The cost-mode gate
  // already allowlists that combo; here we allow the request through against
  // the parent's session row instead of rejecting on model mismatch.
  const isSmartSessionGeminiThinker =
    params.requireActiveSession === true &&
    params.requestedModel === FREEBUFF_GEMINI_PRO_MODEL_ID &&
    canFreebuffModelSpawnGeminiThinker(row.model)

  // Reject requests for a model the session isn't bound to. Sub-agents may
  // legitimately use other models (Gemini Flash etc.) so we only enforce this
  // when the caller provides a requestedModel and it is either a supported
  // freebuff root model or the gemini-thinker model.
  if (
    params.requestedModel &&
    (isSupportedFreebuffModelId(params.requestedModel) ||
      params.requestedModel === FREEBUFF_GEMINI_PRO_MODEL_ID) &&
    params.requestedModel !== row.model &&
    !isSmartSessionGeminiThinker
  ) {
    return {
      ok: false,
      code: 'session_model_mismatch',
      message: `This session is bound to ${row.model}; restart freebuff to switch models.`,
    }
  }

  if (expiresAtMs > nowMs) {
    return {
      ok: true,
      reason: 'active',
      remainingMs: expiresAtMs - nowMs,
    }
  }

  // Inside the grace window: still admit so the agent can finish, but signal
  // to the caller (and via metrics) that no new user prompts should arrive.
  return {
    ok: true,
    reason: 'draining',
    gracePeriodRemainingMs: expiresAtMs + graceMs - nowMs,
  }
}
