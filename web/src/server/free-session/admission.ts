import {
  SUPPORTED_FREEBUFF_MODELS,
  isFreebuffModelAvailable,
} from '@codebuff/common/constants/freebuff-models'

import {
  ADMISSION_TICK_MS,
  getSessionGraceMs,
  getSessionLengthMs,
} from './config'
import { getFleetHealth } from './fireworks-health'
import {
  activeCountsByModel,
  admitFromQueue,
  evictBanned,
  queueDepth,
  sweepExpired,
} from './store'

import type { FireworksHealth, FleetHealth } from './fireworks-health'

import { logger } from '@/util/logger'

export interface AdmissionDeps {
  sweepExpired: (now: Date, graceMs: number) => Promise<number>
  evictBanned: () => Promise<number>
  queueDepth: (params: { model: string }) => Promise<number>
  activeCountsByModel: () => Promise<Record<string, number>>
  admitFromQueue: (params: {
    model: string
    sessionLengthMs: number
    now: Date
    health: FireworksHealth
  }) => Promise<{
    admitted: { user_id: string }[]
    skipped: FireworksHealth | null
  }>
  getFleetHealth: () => Promise<FleetHealth>
  /** Plain values, not thunks — these never change at runtime. */
  sessionLengthMs: number
  graceMs: number
  /** Models to run admission ticks for. Defaults to the full model registry. */
  models?: readonly string[]
  now?: () => Date
}

const defaultDeps: AdmissionDeps = {
  sweepExpired,
  evictBanned,
  queueDepth,
  activeCountsByModel,
  admitFromQueue,
  // FREEBUFF_DEV_FORCE_ADMIT lets local `dev:freebuff` drive the full
  // waiting-room → admitted → ended flow without a real upstream. Returning
  // an empty fleet means every model resolves to the absence-default of
  // 'healthy' below.
  getFleetHealth:
    process.env.FREEBUFF_DEV_FORCE_ADMIT === 'true'
      ? async () => ({})
      : getFleetHealth,
  get sessionLengthMs() {
    return getSessionLengthMs()
  },
  get graceMs() {
    return getSessionGraceMs()
  },
}

export interface AdmissionTickResult {
  expired: number
  /** Free_session rows removed because the user is banned. */
  evictedBanned: number
  admitted: number
  /** Per-model queue depth at the end of the tick. */
  queueDepthByModel: Record<string, number>
  /** Per-model active-session count at the end of the tick. Models with no
   *  active sessions are omitted. */
  activeCountByModel: Record<string, number>
  skipped: FireworksHealth | null
}

/**
 * Run a single admission tick:
 *   1. Expire sessions past their expires_at + grace.
 *   2. For each model, attempt to admit one queued user. Admission proceeds
 *      only when the upstream health probe reports `healthy`; `degraded` and
 *      `unhealthy` both pause admission so the deployment can catch up.
 *
 * Per-model admission means heavier models can sit cold without starving
 * lighter ones. Admission still drips at (1 / ADMISSION_TICK_MS) per model.
 *
 * Returns counts for observability. Safe to call concurrently across pods —
 * admitFromQueue takes a per-model advisory xact lock.
 */
export async function runAdmissionTick(
  deps: AdmissionDeps = defaultDeps,
): Promise<AdmissionTickResult> {
  const now = (deps.now ?? (() => new Date()))()
  // Run eviction before admission so a banned user freed from a slot in this
  // tick frees room for a queued user to be admitted in the same tick.
  const [expired, evictedBanned] = await Promise.all([
    deps.sweepExpired(now, deps.graceMs),
    deps.evictBanned(),
  ])

  const models = deps.models ?? SUPPORTED_FREEBUFF_MODELS.map((m) => m.id)

  // One probe per tick covers every model — the Fireworks metrics endpoint
  // returns all deployments in a single response. Models without a dedicated
  // deployment (e.g. serverless) aren't in the map; treat their absence as
  // 'healthy' so admission continues. TODO: when those models move to their
  // own deployments, drop the absence-default and require an explicit entry.
  const fleet = await deps.getFleetHealth()

  // Run per-model admission in parallel — they only contend on independent
  // advisory locks and a single update each.
  const perModel = await Promise.all(
    models.map(async (model) => {
      const isRegisteredModel = SUPPORTED_FREEBUFF_MODELS.some(
        (m) => m.id === model,
      )
      const health =
        !isRegisteredModel || isFreebuffModelAvailable(model, now)
          ? (fleet[model] ?? 'healthy')
          : 'unhealthy'
      const { admitted, skipped } = await deps.admitFromQueue({
        model,
        sessionLengthMs: deps.sessionLengthMs,
        now,
        health,
      })
      const depth = await deps.queueDepth({ model })
      return { model, admittedCount: admitted.length, depth, skipped }
    }),
  )

  const activeCountByModel = await deps.activeCountsByModel()
  const totalAdmitted = perModel.reduce((s, r) => s + r.admittedCount, 0)
  const queueDepthByModel = Object.fromEntries(
    perModel.map((r) => [r.model, r.depth]),
  )
  const skipped = perModel.find((r) => r.skipped)?.skipped ?? null

  return {
    expired,
    evictedBanned,
    admitted: totalAdmitted,
    queueDepthByModel,
    activeCountByModel,
    skipped,
  }
}

let interval: ReturnType<typeof setInterval> | null = null
let inFlight = false

function runTick() {
  if (inFlight) return
  inFlight = true
  runAdmissionTick()
    .then((result) => {
      // Emit every tick so per-model queue depth and active counts form a
      // continuous time-series that can be charted over time.
      // metric=freebuff_waiting_room makes it filterable in the log aggregator.
      logger.info(
        {
          metric: 'freebuff_waiting_room',
          admitted: result.admitted,
          expired: result.expired,
          evictedBanned: result.evictedBanned,
          queueDepthByModel: result.queueDepthByModel,
          activeCountByModel: result.activeCountByModel,
          skipped: result.skipped,
        },
        '[FreeSessionAdmission] tick',
      )
    })
    .catch((error) => {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        '[FreeSessionAdmission] tick failed',
      )
    })
    .finally(() => {
      inFlight = false
    })
}

export function startFreeSessionAdmission(): boolean {
  if (interval) return true
  interval = setInterval(runTick, ADMISSION_TICK_MS)
  if (typeof interval.unref === 'function') interval.unref()
  runTick() // fire first tick immediately
  logger.info({ tickMs: ADMISSION_TICK_MS }, '[FreeSessionAdmission] Started')
  return true
}

export function stopFreeSessionAdmission(): void {
  if (interval) clearInterval(interval)
  interval = null
  inFlight = false
}

export function __resetFreeSessionAdmissionForTests(): void {
  stopFreeSessionAdmission()
}
