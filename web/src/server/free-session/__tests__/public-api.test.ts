import { beforeEach, describe, expect, test } from 'bun:test'

import {
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
  FREEBUFF_GEMINI_PRO_MODEL_ID,
  FREEBUFF_KIMI_MODEL_ID,
  FREEBUFF_LIMITED_SESSION_LIMIT,
  FREEBUFF_PREMIUM_SESSION_LIMIT,
  FREEBUFF_PREMIUM_SESSION_WINDOW_HOURS,
} from '@codebuff/common/constants/freebuff-models'

import {
  checkSessionAdmissible,
  endUserSession,
  getSessionState,
  requestSession,
} from '../public-api'
import { FreeSessionModelLockedError } from '../store'

import type { SessionDeps } from '../public-api'
import type { InternalSessionRow } from '../types'

const SESSION_LEN = 60 * 60 * 1000
const GRACE_MS = 30 * 60 * 1000
const DEFAULT_MODEL = 'minimax/minimax-m2.7'
const REMOVED_GLM_MODEL = 'z-ai/glm-5.1'
const DEFAULT_PREMIUM_RESET_AT = '2026-04-18T07:00:00.000Z'

function expectedRateLimit(model: string, recentCount: number) {
  return {
    model,
    limit: FREEBUFF_PREMIUM_SESSION_LIMIT,
    period: 'pacific_day',
    resetTimeZone: 'America/Los_Angeles',
    resetAt: DEFAULT_PREMIUM_RESET_AT,
    windowHours: FREEBUFF_PREMIUM_SESSION_WINDOW_HOURS,
    recentCount,
  } as const
}

interface AdmitRecord {
  user_id: string
  model: string
  access_tier?: 'full' | 'limited'
  admitted_at: Date
  session_units?: number
}

function makeDeps(overrides: Partial<SessionDeps> = {}): SessionDeps & {
  rows: Map<string, InternalSessionRow>
  admits: AdmitRecord[]
  _tick: (n: Date) => void
  _now: () => Date
} {
  const rows = new Map<string, InternalSessionRow>()
  const admits: AdmitRecord[] = []
  let currentNow = new Date('2026-04-17T12:00:00Z')
  let instanceCounter = 0

  const newInstanceId = () => `inst-${++instanceCounter}`

  const deps: SessionDeps & {
    rows: Map<string, InternalSessionRow>
    admits: AdmitRecord[]
    _tick: (n: Date) => void
    _now: () => Date
  } = {
    rows,
    admits,
    _tick: (n: Date) => {
      currentNow = n
    },
    _now: () => currentNow,
    graceMs: GRACE_MS,
    sessionLengthMs: SESSION_LEN,
    // Test default: instant-admit disabled (capacity 0) so existing FIFO
    // queue tests stay green. Tests that exercise instant admission opt in
    // via `getInstantAdmitCapacity: () => N`.
    getInstantAdmitCapacity: () => 0,
    activeCountForModel: async (model) => {
      let n = 0
      for (const r of rows.values()) {
        if (r.status === 'active' && r.model === model) n++
      }
      return n
    },
    listRecentPremiumAdmits: async ({ userId, models, since, accessTier }) => {
      return admits
        .filter(
          (a) =>
            a.user_id === userId &&
            models.includes(a.model) &&
            a.admitted_at.getTime() >= since.getTime() &&
            (!accessTier || (a.access_tier ?? 'full') === accessTier),
        )
        .sort((a, b) => a.admitted_at.getTime() - b.admitted_at.getTime())
        .map((a) => ({
          admittedAt: a.admitted_at,
          model: a.model,
          sessionUnits: a.session_units ?? 1,
        }))
    },
    promoteQueuedUser: async ({ userId, model, sessionLengthMs, now }) => {
      const row = rows.get(userId)
      if (!row || row.status !== 'queued' || row.model !== model) return null
      row.status = 'active'
      row.admitted_at = now
      row.expires_at = new Date(now.getTime() + sessionLengthMs)
      row.updated_at = now
      admits.push({
        user_id: userId,
        model,
        access_tier: row.access_tier ?? 'full',
        admitted_at: now,
        session_units: 1,
      })
      return row
    },
    now: () => currentNow,
    getSessionRow: async (userId) => rows.get(userId) ?? null,
    endSession: async ({ userId, now, sessionLengthMs }) => {
      const row = rows.get(userId)
      if (
        row?.status === 'active' &&
        row.admitted_at &&
        row.expires_at &&
        row.expires_at.getTime() > now.getTime()
      ) {
        const latest = admits
          .filter((a) => a.user_id === userId && a.model === row.model)
          .sort((a, b) => b.admitted_at.getTime() - a.admitted_at.getTime())[0]
        if (latest) {
          const usedMs = Math.max(
            0,
            Math.min(
              sessionLengthMs,
              now.getTime() - row.admitted_at.getTime(),
            ),
          )
          latest.session_units = Math.ceil((usedMs / sessionLengthMs) * 10) / 10
        }
      }
      rows.delete(userId)
    },
    queueDepthsByModel: async () => {
      const out: Record<string, number> = {}
      for (const r of rows.values()) {
        if (r.status !== 'queued') continue
        out[r.model] = (out[r.model] ?? 0) + 1
      }
      return out
    },
    queuePositionFor: async ({ userId, model, queuedAt }) => {
      let pos = 0
      for (const r of rows.values()) {
        if (r.status !== 'queued' || r.model !== model) continue
        if (
          r.queued_at.getTime() < queuedAt.getTime() ||
          (r.queued_at.getTime() === queuedAt.getTime() && r.user_id <= userId)
        ) {
          pos++
        }
      }
      return pos
    },
    joinOrTakeOver: async ({ userId, model, accessTier, now }) => {
      const existing = rows.get(userId)
      const nextInstance = newInstanceId()
      if (!existing) {
        const r: InternalSessionRow = {
          user_id: userId,
          status: 'queued',
          active_instance_id: nextInstance,
          model,
          access_tier: accessTier,
          queued_at: now,
          admitted_at: null,
          expires_at: null,
          created_at: now,
          updated_at: now,
        }
        rows.set(userId, r)
        return r
      }
      if (
        existing.status === 'active' &&
        existing.expires_at &&
        existing.expires_at.getTime() > now.getTime()
      ) {
        if (existing.model !== model) {
          throw new FreeSessionModelLockedError(existing.model)
        }
        existing.active_instance_id = nextInstance
        existing.updated_at = now
        return existing
      }
      if (existing.status === 'queued') {
        existing.active_instance_id = nextInstance
        if (existing.model !== model) {
          existing.model = model
          existing.queued_at = now
        }
        existing.access_tier = accessTier
        existing.updated_at = now
        return existing
      }
      existing.status = 'queued'
      existing.active_instance_id = nextInstance
      existing.model = model
      existing.access_tier = accessTier
      existing.queued_at = now
      existing.admitted_at = null
      existing.expires_at = null
      existing.updated_at = now
      return existing
    },
    ...overrides,
  }
  return deps
}

describe('requestSession', () => {
  let deps: ReturnType<typeof makeDeps>
  beforeEach(() => {
    deps = makeDeps()
  })

  test('banned user is rejected before joinOrTakeOver runs', async () => {
    const state = await requestSession({
      userId: 'u1',
      model: DEFAULT_MODEL,
      userBanned: true,
      deps,
    })
    expect(state).toEqual({ status: 'banned' })
    // No row should be created — the point is to keep banned bots out of
    // queueDepthsByModel entirely, not just until the next evictBanned tick.
    expect(deps.rows.size).toBe(0)
  })

  test('first call puts user in queue at position 1', async () => {
    const state = await requestSession({
      userId: 'u1',
      model: DEFAULT_MODEL,
      deps,
    })
    expect(state.status).toBe('queued')
    if (state.status !== 'queued') throw new Error('unreachable')
    expect(state.position).toBe(1)
    expect(state.queueDepth).toBe(1)
    expect(state.instanceId).toBe('inst-1')
  })

  test('removed GLM 5.1 request falls back to the default model', async () => {
    const state = await requestSession({
      userId: 'u1',
      model: REMOVED_GLM_MODEL,
      deps,
    })
    expect(state.status).toBe('queued')
    if (state.status !== 'queued') throw new Error('unreachable')
    expect(state.model).toBe(DEFAULT_MODEL)
    expect(deps.rows.get('u1')?.model).toBe(DEFAULT_MODEL)
  })

  test('removed GLM 5.1 active session cannot be reclaimed', async () => {
    const admittedAt = new Date(deps._now().getTime() - 10 * 60 * 1000)
    deps.rows.set('u1', {
      user_id: 'u1',
      status: 'active',
      active_instance_id: 'inst-pre',
      model: REMOVED_GLM_MODEL,
      queued_at: admittedAt,
      admitted_at: admittedAt,
      expires_at: new Date(deps._now().getTime() + SESSION_LEN),
      created_at: admittedAt,
      updated_at: admittedAt,
    })

    const state = await requestSession({
      userId: 'u1',
      model: REMOVED_GLM_MODEL,
      deps,
    })
    expect(state.status).toBe('queued')
    if (state.status !== 'queued') throw new Error('unreachable')
    expect(state.model).toBe(DEFAULT_MODEL)
    expect(deps.rows.get('u1')?.model).toBe(DEFAULT_MODEL)
  })

  test('queued response includes a per-model depth snapshot for the selector', async () => {
    deps._tick(new Date('2026-04-17T16:00:00Z'))
    // Seed 2 users in MiniMax + 1 in DeepSeek so the returned map captures both.
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    deps._tick(new Date(deps._now().getTime() + 1000))
    await requestSession({ userId: 'u2', model: DEFAULT_MODEL, deps })
    deps._tick(new Date(deps._now().getTime() + 1000))
    await requestSession({
      userId: 'u3',
      model: 'deepseek/deepseek-v4-pro',
      deps,
    })

    const state = await getSessionState({ userId: 'u1', deps })
    if (state.status !== 'queued') throw new Error('unreachable')
    expect(state.queueDepthByModel).toEqual({
      [DEFAULT_MODEL]: 2,
      'deepseek/deepseek-v4-pro': 1,
    })
  })

  test('second call from same user rotates instance id, keeps queue position', async () => {
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    const second = await requestSession({
      userId: 'u1',
      model: DEFAULT_MODEL,
      deps,
    })
    if (second.status !== 'queued') throw new Error('unreachable')
    expect(second.position).toBe(1)
    expect(second.instanceId).toBe('inst-2')
  })

  test('multiple users queue in FIFO order', async () => {
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    deps._tick(new Date(deps._now().getTime() + 1000))
    await requestSession({ userId: 'u2', model: DEFAULT_MODEL, deps })

    const s1 = await getSessionState({ userId: 'u1', deps })
    const s2 = await getSessionState({ userId: 'u2', deps })
    if (s1.status !== 'queued' || s2.status !== 'queued')
      throw new Error('unreachable')
    expect(s1.position).toBe(1)
    expect(s2.position).toBe(2)
  })

  test('active unexpired session → rotate instance id, preserve active state', async () => {
    // Prime a user into active state manually.
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    const row = deps.rows.get('u1')!
    row.status = 'active'
    row.admitted_at = deps._now()
    row.expires_at = new Date(deps._now().getTime() + SESSION_LEN)

    const second = await requestSession({
      userId: 'u1',
      model: DEFAULT_MODEL,
      deps,
    })
    expect(second.status).toBe('active')
    if (second.status !== 'active') throw new Error('unreachable')
    expect(second.instanceId).not.toBe('inst-1') // rotated
  })

  test('instant-admit: below capacity admits the user in the same request', async () => {
    const admitDeps = makeDeps({ getInstantAdmitCapacity: () => 3 })
    const state = await requestSession({
      userId: 'u1',
      model: DEFAULT_MODEL,
      deps: admitDeps,
    })
    expect(state.status).toBe('active')
    if (state.status !== 'active') throw new Error('unreachable')
    expect(state.remainingMs).toBe(SESSION_LEN)
    // The row in storage is flipped too, so the next GET /session also sees active.
    expect(admitDeps.rows.get('u1')?.status).toBe('active')
  })

  test('instant-admit: queues once active-count reaches capacity', async () => {
    const admitDeps = makeDeps({ getInstantAdmitCapacity: () => 2 })
    const s1 = await requestSession({
      userId: 'u1',
      model: DEFAULT_MODEL,
      deps: admitDeps,
    })
    const s2 = await requestSession({
      userId: 'u2',
      model: DEFAULT_MODEL,
      deps: admitDeps,
    })
    const s3 = await requestSession({
      userId: 'u3',
      model: DEFAULT_MODEL,
      deps: admitDeps,
    })
    expect(s1.status).toBe('active')
    expect(s2.status).toBe('active')
    expect(s3.status).toBe('queued')
  })

  test('instant-admit: per-model capacities are independent', async () => {
    // MiniMax saturated at 1 active, DeepSeek still has room.
    const admitDeps = makeDeps({
      getInstantAdmitCapacity: (model) => (model === DEFAULT_MODEL ? 1 : 10),
    })
    admitDeps._tick(new Date('2026-04-17T16:00:00Z'))
    await requestSession({
      userId: 'u1',
      model: DEFAULT_MODEL,
      deps: admitDeps,
    })
    const s2 = await requestSession({
      userId: 'u2',
      model: DEFAULT_MODEL,
      deps: admitDeps,
    })
    const s3 = await requestSession({
      userId: 'u3',
      model: 'deepseek/deepseek-v4-pro',
      deps: admitDeps,
    })
    expect(s2.status).toBe('queued')
    expect(s3.status).toBe('active')
  })

  // Per-user premium session limit (5 units per Pacific day) — the wire
  // limit is hard-coded in public-api.ts, so tests seed the fake admit log
  // directly rather than configuring it.
  const PREMIUM_MODEL = FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID
  const KIMI_MODEL = FREEBUFF_KIMI_MODEL_ID
  const PREMIUM_LIMIT = FREEBUFF_PREMIUM_SESSION_LIMIT
  const PREMIUM_WINDOW_HOURS = FREEBUFF_PREMIUM_SESSION_WINDOW_HOURS
  const PREMIUM_OPEN_TIME = new Date('2026-04-17T16:00:00Z')

  test('rate_limited: shared premium pool blocks the next premium session at 5 units', async () => {
    deps._tick(PREMIUM_OPEN_TIME)
    const now = deps._now()
    for (let i = 0; i < PREMIUM_LIMIT; i++) {
      deps.admits.push({
        user_id: 'u1',
        model: i === 0 ? KIMI_MODEL : PREMIUM_MODEL,
        admitted_at: new Date(now.getTime() - i * 60 * 60 * 1000),
      })
    }

    const state = await requestSession({
      userId: 'u1',
      model: PREMIUM_MODEL,
      deps,
    })
    expect(state.status).toBe('rate_limited')
    if (state.status !== 'rate_limited') throw new Error('unreachable')
    expect(state.model).toBe(PREMIUM_MODEL)
    expect(state.limit).toBe(PREMIUM_LIMIT)
    expect(state.windowHours).toBe(PREMIUM_WINDOW_HOURS)
    expect(state.recentCount).toBe(PREMIUM_LIMIT)
    expect(state.retryAfterMs).toBe(15 * 60 * 60 * 1000)
    expect(deps.rows.has('u1')).toBe(false)
  })

  test('rate_limited: reset follows Pacific midnight across DST changes', async () => {
    deps._tick(new Date('2026-03-08T09:00:00Z'))
    const now = deps._now()
    for (let i = 0; i < PREMIUM_LIMIT; i++) {
      deps.admits.push({
        user_id: 'u1',
        model: PREMIUM_MODEL,
        admitted_at: new Date(now.getTime() - i * 60_000),
      })
    }

    const state = await requestSession({
      userId: 'u1',
      model: PREMIUM_MODEL,
      deps,
    })

    expect(state.status).toBe('rate_limited')
    if (state.status !== 'rate_limited') throw new Error('unreachable')
    expect(state.retryAfterMs).toBe(22 * 60 * 60 * 1000)
  })

  test('rate_limited: DeepSeek admit before Pacific midnight does not count', async () => {
    deps._tick(PREMIUM_OPEN_TIME)
    deps.admits.push({
      user_id: 'u1',
      model: PREMIUM_MODEL,
      admitted_at: new Date('2026-04-17T06:59:00Z'),
    })

    const state = await requestSession({
      userId: 'u1',
      model: PREMIUM_MODEL,
      deps,
    })
    expect(state.status).toBe('queued')
    if (state.status !== 'queued') throw new Error('unreachable')
    expect(state.rateLimit).toEqual(expectedRateLimit(PREMIUM_MODEL, 0))
  })

  test('rate_limited: 5th Kimi admit today blocks the 6th attempt', async () => {
    deps._tick(PREMIUM_OPEN_TIME)
    // Seed 5 admits inside today's Pacific day. retryAfter points at the
    // next Pacific midnight reset, not the oldest admit.
    const now = deps._now()
    const ages = [8, 4, 3, 2, 1]
    for (const hoursAgo of ages) {
      deps.admits.push({
        user_id: 'u1',
        model: KIMI_MODEL,
        admitted_at: new Date(now.getTime() - hoursAgo * 60 * 60 * 1000),
      })
    }

    const state = await requestSession({
      userId: 'u1',
      model: KIMI_MODEL,
      deps,
    })
    expect(state.status).toBe('rate_limited')
    if (state.status !== 'rate_limited') throw new Error('unreachable')
    expect(state.model).toBe(KIMI_MODEL)
    expect(state.limit).toBe(PREMIUM_LIMIT)
    expect(state.windowHours).toBe(PREMIUM_WINDOW_HOURS)
    expect(state.recentCount).toBe(PREMIUM_LIMIT)
    expect(state.retryAfterMs).toBe(15 * 60 * 60 * 1000)
    // Blocked before any row is written — the user doesn't take a queue slot.
    expect(deps.rows.has('u1')).toBe(false)
  })

  test('rate_limited: removed GLM 5.1 request does not use the shared premium quota', async () => {
    deps._tick(PREMIUM_OPEN_TIME)
    const now = deps._now()
    for (let i = 0; i < PREMIUM_LIMIT; i++) {
      deps.admits.push({
        user_id: 'u1',
        model: PREMIUM_MODEL,
        admitted_at: new Date(now.getTime() - (i + 1) * 60 * 60 * 1000),
      })
    }

    const state = await requestSession({
      userId: 'u1',
      model: REMOVED_GLM_MODEL,
      deps,
    })
    expect(state.status).toBe('queued')
    if (state.status !== 'queued') throw new Error('unreachable')
    expect(state.model).toBe(DEFAULT_MODEL)
  })

  test("rate_limited: admits before today's Pacific reset do not count", async () => {
    deps._tick(PREMIUM_OPEN_TIME)
    for (let i = 0; i < 5; i++) {
      deps.admits.push({
        user_id: 'u1',
        model: PREMIUM_MODEL,
        admitted_at: new Date(`2026-04-17T06:5${i}:00Z`),
      })
    }
    const state = await requestSession({
      userId: 'u1',
      model: PREMIUM_MODEL,
      deps,
    })
    expect(state.status).toBe('queued')
    if (state.status !== 'queued') throw new Error('unreachable')
    expect(state.rateLimit?.recentCount).toBe(0)
  })

  test('rate_limited: Minimax is unlimited even with many recent admits', async () => {
    const now = deps._now()
    for (let i = 0; i < 20; i++) {
      deps.admits.push({
        user_id: 'u1',
        model: DEFAULT_MODEL,
        admitted_at: new Date(now.getTime() - i * 60_000),
      })
    }
    const state = await requestSession({
      userId: 'u1',
      model: DEFAULT_MODEL,
      deps,
    })
    expect(state.status).toBe('queued')
    if (state.status !== 'queued') throw new Error('unreachable')
    // No rate-limit info for unrated models — the CLI skips the quota line.
    expect(state.rateLimit).toBeUndefined()
  })

  test('limited access coerces any requested model to DeepSeek Flash', async () => {
    const state = await requestSession({
      userId: 'u1',
      model: DEFAULT_MODEL,
      accessTier: 'limited',
      deps,
    })
    expect(state.status).toBe('queued')
    if (state.status !== 'queued') throw new Error('unreachable')
    expect(state.accessTier).toBe('limited')
    expect(state.model).toBe('deepseek/deepseek-v4-flash')
    expect(deps.rows.get('u1')?.access_tier).toBe('limited')
  })

  test('limited access re-anchors an existing full-tier Flash row', async () => {
    const admittedAt = new Date(deps._now().getTime() - 10 * 60_000)
    deps.rows.set('u1', {
      user_id: 'u1',
      status: 'active',
      active_instance_id: 'full-inst',
      model: 'deepseek/deepseek-v4-flash',
      access_tier: 'full',
      queued_at: admittedAt,
      admitted_at: admittedAt,
      expires_at: new Date(deps._now().getTime() + SESSION_LEN),
      created_at: admittedAt,
      updated_at: admittedAt,
    })

    const state = await requestSession({
      userId: 'u1',
      model: 'deepseek/deepseek-v4-flash',
      accessTier: 'limited',
      deps,
    })
    expect(state.status).toBe('queued')
    if (state.status !== 'queued') throw new Error('unreachable')
    expect(state.accessTier).toBe('limited')
    expect(state.instanceId).not.toBe('full-inst')
    expect(deps.rows.get('u1')?.access_tier).toBe('limited')
  })

  test('rate_limited: limited access blocks the next Flash session at 5 units', async () => {
    const now = deps._now()
    for (let i = 0; i < FREEBUFF_LIMITED_SESSION_LIMIT; i++) {
      deps.admits.push({
        user_id: 'u1',
        model: 'deepseek/deepseek-v4-flash',
        access_tier: 'limited',
        admitted_at: new Date(now.getTime() - i * 60_000),
      })
    }

    const state = await requestSession({
      userId: 'u1',
      model: DEFAULT_MODEL,
      accessTier: 'limited',
      deps,
    })
    expect(state.status).toBe('rate_limited')
    if (state.status !== 'rate_limited') throw new Error('unreachable')
    expect(state.accessTier).toBe('limited')
    expect(state.model).toBe('deepseek/deepseek-v4-flash')
    expect(state.limit).toBe(FREEBUFF_LIMITED_SESSION_LIMIT)
    expect(state.recentCount).toBe(FREEBUFF_LIMITED_SESSION_LIMIT)
    expect(deps.rows.has('u1')).toBe(false)
  })

  test('rate_limited: full Flash sessions do not consume the limited quota', async () => {
    const now = deps._now()
    for (let i = 0; i < FREEBUFF_LIMITED_SESSION_LIMIT; i++) {
      deps.admits.push({
        user_id: 'u1',
        model: 'deepseek/deepseek-v4-flash',
        access_tier: 'full',
        admitted_at: new Date(now.getTime() - i * 60_000),
      })
    }

    const state = await requestSession({
      userId: 'u1',
      model: DEFAULT_MODEL,
      accessTier: 'limited',
      deps,
    })
    expect(state.status).toBe('queued')
    if (state.status !== 'queued') throw new Error('unreachable')
    expect(state.rateLimit?.recentCount).toBe(0)
  })

  test('queued DeepSeek response carries the current admit count', async () => {
    deps._tick(PREMIUM_OPEN_TIME)
    const now = deps._now()
    // 2 admits today — under the limit so the user still queues.
    deps.admits.push({
      user_id: 'u1',
      model: PREMIUM_MODEL,
      admitted_at: new Date(now.getTime() - 60 * 60 * 1000),
    })
    deps.admits.push({
      user_id: 'u1',
      model: PREMIUM_MODEL,
      admitted_at: new Date(now.getTime() - 30 * 60 * 1000),
    })
    const state = await requestSession({
      userId: 'u1',
      model: PREMIUM_MODEL,
      deps,
    })
    if (state.status !== 'queued') throw new Error('unreachable')
    expect(state.rateLimit).toEqual(expectedRateLimit(PREMIUM_MODEL, 2))
  })

  test('rate_limited: fractional premium usage under the cap can start another session', async () => {
    deps._tick(PREMIUM_OPEN_TIME)
    const now = deps._now()
    deps.admits.push({
      user_id: 'u1',
      model: KIMI_MODEL,
      admitted_at: new Date(now.getTime() - 8 * 60 * 60 * 1000),
      session_units: 0.9,
    })
    for (let i = 0; i < 4; i++) {
      deps.admits.push({
        user_id: 'u1',
        model: KIMI_MODEL,
        admitted_at: new Date(now.getTime() - (i + 1) * 60 * 60 * 1000),
      })
    }

    const state = await requestSession({
      userId: 'u1',
      model: KIMI_MODEL,
      deps,
    })

    expect(state.status).toBe('queued')
    if (state.status !== 'queued') throw new Error('unreachable')
    expect(state.rateLimit?.recentCount).toBe(4.9)
  })

  test('rate_limited: takeover of an active premium row is allowed even when at cap', async () => {
    // Reclaim path: user has an active+unexpired premium session and restarts
    // the CLI. POST must rotate their instance id (takeover) and NOT reject
    // with rate_limited — otherwise they'd be stranded with a live session
    // they can't reconnect to. The 5th admission is already in the log, so
    // this also exercises "at the cap" rather than "over the cap".
    deps._tick(PREMIUM_OPEN_TIME)
    const now = deps._now()
    // Seed 5 prior admits (the cap), with the latest one matching the
    // active row we're about to install.
    const ages = [8, 4, 3, 2, 0]
    for (const hoursAgo of ages) {
      deps.admits.push({
        user_id: 'u1',
        model: PREMIUM_MODEL,
        admitted_at: new Date(now.getTime() - hoursAgo * 60 * 60 * 1000),
      })
    }
    // Install the active row directly (skipping the normal request path so
    // we don't have to unwind the rate-limit gate to set up the fixture).
    const admittedAt = new Date(now.getTime() - 30 * 60 * 1000)
    deps.rows.set('u1', {
      user_id: 'u1',
      status: 'active',
      active_instance_id: 'inst-pre',
      model: PREMIUM_MODEL,
      queued_at: admittedAt,
      admitted_at: admittedAt,
      expires_at: new Date(admittedAt.getTime() + SESSION_LEN),
      created_at: admittedAt,
      updated_at: admittedAt,
    })

    const state = await requestSession({
      userId: 'u1',
      model: PREMIUM_MODEL,
      deps,
    })
    expect(state.status).toBe('active')
    if (state.status !== 'active') throw new Error('unreachable')
    // Instance id rotated; quota snapshot still reflects today's usage.
    expect(state.instanceId).not.toBe('inst-pre')
    expect(state.rateLimit?.recentCount).toBe(PREMIUM_LIMIT)
  })

  test('rate_limited: reclaim of a queued premium row is allowed even when at cap', async () => {
    // Same reclaim exception for queued rows: if a user has already queued
    // (say they slipped in just before their 5th admit landed), a subsequent
    // POST from the same CLI must preserve their queue position instead of
    // flipping to rate_limited.
    deps._tick(PREMIUM_OPEN_TIME)
    const now = deps._now()
    for (let i = 0; i < PREMIUM_LIMIT; i++) {
      deps.admits.push({
        user_id: 'u1',
        model: PREMIUM_MODEL,
        admitted_at: new Date(now.getTime() - (i + 1) * 60 * 60 * 1000),
      })
    }
    const queuedAt = new Date(now.getTime() - 5 * 60 * 1000)
    deps.rows.set('u1', {
      user_id: 'u1',
      status: 'queued',
      active_instance_id: 'inst-pre',
      model: PREMIUM_MODEL,
      queued_at: queuedAt,
      admitted_at: null,
      expires_at: null,
      created_at: queuedAt,
      updated_at: queuedAt,
    })

    const state = await requestSession({
      userId: 'u1',
      model: PREMIUM_MODEL,
      deps,
    })
    expect(state.status).toBe('queued')
    if (state.status !== 'queued') throw new Error('unreachable')
    // Same position (1) since we preserved queued_at and nobody else is
    // ahead; the instance id rotated so any prior CLI is superseded.
    expect(state.instanceId).not.toBe('inst-pre')
    expect(state.rateLimit?.recentCount).toBe(PREMIUM_LIMIT)
  })

  test('rate_limited: expired premium row is not a reclaim — quota still applies', async () => {
    // The stored row's expires_at is in the past, so it doesn't represent
    // an in-flight session. This POST is effectively a fresh request and
    // must be blocked by the quota.
    deps._tick(PREMIUM_OPEN_TIME)
    const now = deps._now()
    const ages = [8, 4, 3, 2, 1]
    for (const hoursAgo of ages) {
      deps.admits.push({
        user_id: 'u1',
        model: PREMIUM_MODEL,
        admitted_at: new Date(now.getTime() - hoursAgo * 60 * 60 * 1000),
      })
    }
    const admittedAt = new Date(now.getTime() - 2 * SESSION_LEN)
    deps.rows.set('u1', {
      user_id: 'u1',
      status: 'active',
      active_instance_id: 'inst-pre',
      model: PREMIUM_MODEL,
      queued_at: admittedAt,
      admitted_at: admittedAt,
      expires_at: new Date(admittedAt.getTime() + SESSION_LEN),
      created_at: admittedAt,
      updated_at: admittedAt,
    })
    const state = await requestSession({
      userId: 'u1',
      model: PREMIUM_MODEL,
      deps,
    })
    expect(state.status).toBe('rate_limited')
  })

  test('instant-admit bumps the quota count for the freshly-written admit row', async () => {
    const admitDeps = makeDeps({ getInstantAdmitCapacity: () => 3 })
    admitDeps._tick(PREMIUM_OPEN_TIME)
    // 1 existing admit today; this new call should instant-admit and
    // write a second row, so the response's recentCount reflects 2.
    const now = admitDeps._now()
    admitDeps.admits.push({
      user_id: 'u1',
      model: PREMIUM_MODEL,
      admitted_at: new Date(now.getTime() - 30 * 60 * 1000),
    })
    const state = await requestSession({
      userId: 'u1',
      model: PREMIUM_MODEL,
      deps: admitDeps,
    })
    if (state.status !== 'active') throw new Error('unreachable')
    expect(state.rateLimit?.recentCount).toBe(2)
  })
})

describe('getSessionState', () => {
  let deps: ReturnType<typeof makeDeps>
  beforeEach(() => {
    deps = makeDeps()
  })

  test('banned user returns banned without hitting the DB', async () => {
    const state = await getSessionState({
      userId: 'u1',
      userBanned: true,
      deps,
    })
    expect(state).toEqual({ status: 'banned' })
  })

  test('no row returns none with empty queue-depth snapshot', async () => {
    const state = await getSessionState({ userId: 'u1', deps })
    expect(state).toEqual({
      status: 'none',
      accessTier: 'full',
      queueDepthByModel: {},
    })
  })

  test('no row surfaces used premium quota before joining', async () => {
    const now = deps._now()
    deps.admits.push({
      user_id: 'u1',
      model: FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
      admitted_at: new Date(now.getTime() - 60 * 60 * 1000),
    })

    const state = await getSessionState({ userId: 'u1', deps })
    expect(state.status).toBe('none')
    if (state.status !== 'none') throw new Error('unreachable')
    expect(
      state.rateLimitsByModel?.[FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID],
    ).toEqual(expectedRateLimit(FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID, 1))
  })

  test('limited access deletes an incompatible queued row before returning none', async () => {
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    expect(deps.rows.has('u1')).toBe(true)

    const state = await getSessionState({
      userId: 'u1',
      accessTier: 'limited',
      deps,
    })

    expect(state).toEqual({
      status: 'none',
      accessTier: 'limited',
      queueDepthByModel: {},
    })
    expect(deps.rows.has('u1')).toBe(false)
  })

  test('limited access deletes a queued full-tier Flash row before returning none', async () => {
    await requestSession({
      userId: 'u1',
      model: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
      deps,
    })
    expect(deps.rows.get('u1')?.access_tier).toBe('full')

    const state = await getSessionState({
      userId: 'u1',
      accessTier: 'limited',
      deps,
    })

    expect(state).toEqual({
      status: 'none',
      accessTier: 'limited',
      queueDepthByModel: {},
    })
    expect(deps.rows.has('u1')).toBe(false)
  })

  test('limited access deletes an incompatible active row before returning none', async () => {
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    const row = deps.rows.get('u1')!
    row.status = 'active'
    row.admitted_at = deps._now()
    row.expires_at = new Date(deps._now().getTime() + SESSION_LEN)

    const state = await getSessionState({
      userId: 'u1',
      accessTier: 'limited',
      claimedInstanceId: row.active_instance_id,
      deps,
    })

    expect(state).toEqual({
      status: 'none',
      accessTier: 'limited',
      queueDepthByModel: {},
    })
    expect(deps.rows.has('u1')).toBe(false)
  })

  test('active session with matching instance id returns active', async () => {
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    const row = deps.rows.get('u1')!
    row.status = 'active'
    row.admitted_at = deps._now()
    row.expires_at = new Date(deps._now().getTime() + SESSION_LEN)

    const state = await getSessionState({
      userId: 'u1',
      claimedInstanceId: row.active_instance_id,
      deps,
    })
    expect(state.status).toBe('active')
  })

  test('active session with mismatched instance id returns superseded', async () => {
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    const row = deps.rows.get('u1')!
    row.status = 'active'
    row.admitted_at = deps._now()
    row.expires_at = new Date(deps._now().getTime() + SESSION_LEN)

    const state = await getSessionState({
      userId: 'u1',
      claimedInstanceId: 'stale-token',
      deps,
    })
    expect(state).toEqual({ status: 'superseded' })
  })

  test('getSessionState surfaces rateLimit on queued/active polls', async () => {
    // Regression: the POST response attached rateLimit, but GET polls did
    // not — so the "Sessions N/M used" line flashed once then disappeared on
    // the next 5s poll. GET must attach the same quota snapshot. Rate
    // limits only apply to DeepSeek, so this test uses DeepSeek explicitly (inside
    // deployment hours) rather than the Minimax DEFAULT_MODEL.
    deps._tick(new Date('2026-04-17T16:00:00Z'))
    const now = deps._now()
    deps.admits.push({
      user_id: 'u1',
      model: 'deepseek/deepseek-v4-pro',
      admitted_at: new Date(now.getTime() - 60 * 60 * 1000),
    })
    await requestSession({
      userId: 'u1',
      model: 'deepseek/deepseek-v4-pro',
      deps,
    })
    const row = deps.rows.get('u1')!
    row.status = 'active'
    row.admitted_at = now
    row.expires_at = new Date(now.getTime() + SESSION_LEN)

    const state = await getSessionState({
      userId: 'u1',
      claimedInstanceId: row.active_instance_id,
      deps,
    })
    if (state.status !== 'active') throw new Error('unreachable')
    expect(state.rateLimit).toEqual(
      expectedRateLimit(FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID, 1),
    )
  })

  test('active session only fetches one shared premium quota snapshot', async () => {
    deps._tick(new Date('2026-04-17T16:00:00Z'))
    let listRecentAdmitsCalls = 0
    const originalListRecentAdmits = deps.listRecentPremiumAdmits
    deps.listRecentPremiumAdmits = async (params) => {
      listRecentAdmitsCalls++
      return originalListRecentAdmits(params)
    }

    await requestSession({
      userId: 'u1',
      model: 'deepseek/deepseek-v4-pro',
      deps,
    })
    const row = deps.rows.get('u1')!
    row.status = 'active'
    row.admitted_at = deps._now()
    row.expires_at = new Date(deps._now().getTime() + SESSION_LEN)
    listRecentAdmitsCalls = 0

    const state = await getSessionState({
      userId: 'u1',
      claimedInstanceId: row.active_instance_id,
      deps,
    })

    expect(state.status).toBe('active')
    expect(listRecentAdmitsCalls).toBe(1)
  })

  test('omitted claimedInstanceId on active session returns active (read-only)', async () => {
    // Polling without an id (e.g. very first GET before POST has resolved)
    // must not be classified as superseded — only an explicit mismatch is.
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    const row = deps.rows.get('u1')!
    row.status = 'active'
    row.admitted_at = deps._now()
    row.expires_at = new Date(deps._now().getTime() + SESSION_LEN)

    const state = await getSessionState({ userId: 'u1', deps })
    expect(state.status).toBe('active')
  })

  test('row inside grace window returns ended (with instanceId)', async () => {
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    const row = deps.rows.get('u1')!
    row.status = 'active'
    row.admitted_at = new Date(deps._now().getTime() - SESSION_LEN - 60_000)
    row.expires_at = new Date(deps._now().getTime() - 60_000)

    const state = await getSessionState({
      userId: 'u1',
      claimedInstanceId: row.active_instance_id,
      deps,
    })
    expect(state.status).toBe('ended')
    if (state.status !== 'ended') throw new Error('unreachable')
    expect(state.instanceId).toBe(row.active_instance_id)
    expect(state.gracePeriodRemainingMs).toBe(GRACE_MS - 60_000)
  })

  test('ended view carries the full premium-quota snapshot', async () => {
    // The post-session banner reads any entry from rateLimitsByModel since
    // all premium models share one daily pool. Unlike queued/active, the
    // ended view ships the full unfiltered map so a single banner read is
    // always safe.
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    const row = deps.rows.get('u1')!
    row.status = 'active'
    row.admitted_at = new Date(deps._now().getTime() - SESSION_LEN - 60_000)
    row.expires_at = new Date(deps._now().getTime() - 60_000)
    deps.admits.push({
      user_id: 'u1',
      model: FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
      admitted_at: new Date(deps._now().getTime() - 30 * 60_000),
    })

    const state = await getSessionState({
      userId: 'u1',
      claimedInstanceId: row.active_instance_id,
      deps,
    })
    if (state.status !== 'ended') throw new Error('unreachable')
    expect(
      state.rateLimitsByModel?.[FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID],
    ).toEqual(expectedRateLimit(FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID, 1))
    // Every premium model is present (sharing the same recentCount) so the
    // banner can read any entry without caring which model the user was on.
    expect(state.rateLimitsByModel?.[FREEBUFF_KIMI_MODEL_ID]).toEqual(
      expectedRateLimit(FREEBUFF_KIMI_MODEL_ID, 1),
    )
  })

  test('row past grace window returns none', async () => {
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    const row = deps.rows.get('u1')!
    row.status = 'active'
    row.admitted_at = new Date(deps._now().getTime() - 2 * SESSION_LEN)
    row.expires_at = new Date(deps._now().getTime() - GRACE_MS - 1)

    const state = await getSessionState({
      userId: 'u1',
      claimedInstanceId: row.active_instance_id,
      deps,
    })
    expect(state).toEqual({
      status: 'none',
      accessTier: 'full',
      queueDepthByModel: {},
    })
  })
})

describe('checkSessionAdmissible', () => {
  let deps: ReturnType<typeof makeDeps>
  beforeEach(() => {
    deps = makeDeps()
  })

  test('no session → waiting_room_required', async () => {
    const result = await checkSessionAdmissible({
      userId: 'u1',
      claimedInstanceId: 'x',
      deps,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('waiting_room_required')
  })

  test('active smart model session admits Gemini thinker requests', async () => {
    const now = deps._now()
    deps.rows.set('u1', {
      user_id: 'u1',
      status: 'active',
      active_instance_id: 'inst-1',
      model: FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
      queued_at: now,
      admitted_at: now,
      expires_at: new Date(now.getTime() + SESSION_LEN),
      created_at: now,
      updated_at: now,
    })

    const result = await checkSessionAdmissible({
      userId: 'u1',
      claimedInstanceId: 'inst-1',
      requestedModel: FREEBUFF_GEMINI_PRO_MODEL_ID,
      requireActiveSession: true,
      deps,
    })
    expect(result.ok).toBe(true)
  })

  test('queued session → waiting_room_queued', async () => {
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    const result = await checkSessionAdmissible({
      userId: 'u1',
      claimedInstanceId: 'inst-1',
      deps,
    })
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('waiting_room_queued')
  })

  test('active + matching instance id → ok', async () => {
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    const row = deps.rows.get('u1')!
    row.status = 'active'
    row.admitted_at = deps._now()
    row.expires_at = new Date(deps._now().getTime() + SESSION_LEN)

    const result = await checkSessionAdmissible({
      userId: 'u1',
      claimedInstanceId: row.active_instance_id,
      deps,
    })
    expect(result.ok).toBe(true)
    if (!result.ok || result.reason !== 'active') throw new Error('unreachable')
    expect(result.remainingMs).toBe(SESSION_LEN)
  })

  test('active removed GLM 5.1 session is not admissible', async () => {
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    const row = deps.rows.get('u1')!
    row.model = REMOVED_GLM_MODEL
    row.status = 'active'
    row.admitted_at = deps._now()
    row.expires_at = new Date(deps._now().getTime() + SESSION_LEN)

    const result = await checkSessionAdmissible({
      userId: 'u1',
      claimedInstanceId: row.active_instance_id,
      requestedModel: REMOVED_GLM_MODEL,
      deps,
    })
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('session_model_mismatch')
  })

  test('active Kimi session admits Gemini thinker requests', async () => {
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    const row = deps.rows.get('u1')!
    row.model = FREEBUFF_KIMI_MODEL_ID
    row.status = 'active'
    row.admitted_at = deps._now()
    row.expires_at = new Date(deps._now().getTime() + SESSION_LEN)

    const result = await checkSessionAdmissible({
      userId: 'u1',
      claimedInstanceId: row.active_instance_id,
      requestedModel: FREEBUFF_GEMINI_PRO_MODEL_ID,
      requireActiveSession: true,
      deps,
    })
    expect(result.ok).toBe(true)
  })

  test('active DeepSeek session admits Gemini thinker requests', async () => {
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    const row = deps.rows.get('u1')!
    row.model = FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID
    row.status = 'active'
    row.admitted_at = deps._now()
    row.expires_at = new Date(deps._now().getTime() + SESSION_LEN)

    const result = await checkSessionAdmissible({
      userId: 'u1',
      claimedInstanceId: row.active_instance_id,
      requestedModel: FREEBUFF_GEMINI_PRO_MODEL_ID,
      requireActiveSession: true,
      deps,
    })
    expect(result.ok).toBe(true)
  })

  test('active MiniMax session rejects Gemini thinker requests', async () => {
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    const row = deps.rows.get('u1')!
    row.status = 'active'
    row.admitted_at = deps._now()
    row.expires_at = new Date(deps._now().getTime() + SESSION_LEN)

    const result = await checkSessionAdmissible({
      userId: 'u1',
      claimedInstanceId: row.active_instance_id,
      requestedModel: FREEBUFF_GEMINI_PRO_MODEL_ID,
      requireActiveSession: true,
      deps,
    })
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('session_model_mismatch')
  })

  test('limited active Flash session admits Flash root requests', async () => {
    await requestSession({
      userId: 'u1',
      model: DEFAULT_MODEL,
      accessTier: 'limited',
      deps,
    })
    const row = deps.rows.get('u1')!
    row.status = 'active'
    row.admitted_at = deps._now()
    row.expires_at = new Date(deps._now().getTime() + SESSION_LEN)

    const result = await checkSessionAdmissible({
      userId: 'u1',
      accessTier: 'limited',
      claimedInstanceId: row.active_instance_id,
      requestedModel: 'deepseek/deepseek-v4-flash',
      deps,
    })
    expect(result.ok).toBe(true)
  })

  test('limited access rejects active full-tier non-Flash sessions', async () => {
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    const row = deps.rows.get('u1')!
    row.status = 'active'
    row.admitted_at = deps._now()
    row.expires_at = new Date(deps._now().getTime() + SESSION_LEN)

    const result = await checkSessionAdmissible({
      userId: 'u1',
      accessTier: 'limited',
      claimedInstanceId: row.active_instance_id,
      requestedModel: DEFAULT_MODEL,
      deps,
    })
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('session_model_mismatch')
  })

  test('active + wrong instance id → session_superseded', async () => {
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    const row = deps.rows.get('u1')!
    row.status = 'active'
    row.admitted_at = deps._now()
    row.expires_at = new Date(deps._now().getTime() + SESSION_LEN)

    const result = await checkSessionAdmissible({
      userId: 'u1',
      claimedInstanceId: 'stale-token',
      deps,
    })
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('session_superseded')
  })

  test('missing instance id → freebuff_update_required (pre-waiting-room CLI)', async () => {
    // Classified up front regardless of row state: old clients never send an
    // id, so we surface a distinct code that maps to 426 Upgrade Required.
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    const row = deps.rows.get('u1')!
    row.status = 'active'
    row.admitted_at = deps._now()
    row.expires_at = new Date(deps._now().getTime() + SESSION_LEN)

    const result = await checkSessionAdmissible({
      userId: 'u1',
      claimedInstanceId: undefined,
      deps,
    })
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('freebuff_update_required')
  })

  test('active inside grace window → ok with reason=draining', async () => {
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    const row = deps.rows.get('u1')!
    row.status = 'active'
    row.admitted_at = new Date(deps._now().getTime() - SESSION_LEN - 60_000)
    // 1 minute past expiry, well within the 30-minute grace window
    row.expires_at = new Date(deps._now().getTime() - 60_000)

    const result = await checkSessionAdmissible({
      userId: 'u1',
      claimedInstanceId: row.active_instance_id,
      deps,
    })
    expect(result.ok).toBe(true)
    if (!result.ok || result.reason !== 'draining')
      throw new Error('unreachable')
    expect(result.gracePeriodRemainingMs).toBe(GRACE_MS - 60_000)
  })

  test('active past the grace window → session_expired', async () => {
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    const row = deps.rows.get('u1')!
    row.status = 'active'
    row.admitted_at = new Date(deps._now().getTime() - 2 * SESSION_LEN)
    row.expires_at = new Date(deps._now().getTime() - GRACE_MS - 1)

    const result = await checkSessionAdmissible({
      userId: 'u1',
      claimedInstanceId: row.active_instance_id,
      deps,
    })
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('session_expired')
  })

  test('draining + wrong instance id still rejects with session_superseded', async () => {
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    const row = deps.rows.get('u1')!
    row.status = 'active'
    row.admitted_at = new Date(deps._now().getTime() - SESSION_LEN - 60_000)
    row.expires_at = new Date(deps._now().getTime() - 60_000)

    const result = await checkSessionAdmissible({
      userId: 'u1',
      claimedInstanceId: 'stale-token',
      deps,
    })
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('session_superseded')
  })
})

describe('endUserSession', () => {
  test('removes row', async () => {
    const deps = makeDeps()
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    expect(deps.rows.has('u1')).toBe(true)
    await endUserSession({ userId: 'u1', deps })
    expect(deps.rows.has('u1')).toBe(false)
  })

  test('rounds active premium session usage up to nearest tenth on early end', async () => {
    const deps = makeDeps({ getInstantAdmitCapacity: () => 3 })
    deps._tick(new Date('2026-04-17T16:00:00Z'))
    const state = await requestSession({
      userId: 'u1',
      model: FREEBUFF_KIMI_MODEL_ID,
      deps,
    })
    expect(state.status).toBe('active')
    deps._tick(new Date(deps._now().getTime() + 14 * 60 * 1000))

    await endUserSession({ userId: 'u1', deps })

    expect(deps.rows.has('u1')).toBe(false)
    expect(deps.admits[0]?.session_units).toBe(0.3)
  })

})
