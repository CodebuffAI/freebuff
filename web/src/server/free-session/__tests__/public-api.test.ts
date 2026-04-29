import { beforeEach, describe, expect, test } from 'bun:test'

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

interface AdmitRecord {
  user_id: string
  model: string
  admitted_at: Date
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
    isWaitingRoomEnabled: () => true,
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
    listRecentAdmits: async ({ userId, model, since, limit }) => {
      return admits
        .filter(
          (a) =>
            a.user_id === userId &&
            a.model === model &&
            a.admitted_at.getTime() >= since.getTime(),
        )
        .sort((a, b) => a.admitted_at.getTime() - b.admitted_at.getTime())
        .slice(0, limit)
        .map((a) => a.admitted_at)
    },
    promoteQueuedUser: async ({ userId, model, sessionLengthMs, now }) => {
      const row = rows.get(userId)
      if (!row || row.status !== 'queued' || row.model !== model) return null
      row.status = 'active'
      row.admitted_at = now
      row.expires_at = new Date(now.getTime() + sessionLengthMs)
      row.updated_at = now
      admits.push({ user_id: userId, model, admitted_at: now })
      return row
    },
    now: () => currentNow,
    getSessionRow: async (userId) => rows.get(userId) ?? null,
    endSession: async (userId) => {
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
    joinOrTakeOver: async ({ userId, model, now }) => {
      const existing = rows.get(userId)
      const nextInstance = newInstanceId()
      if (!existing) {
        const r: InternalSessionRow = {
          user_id: userId,
          status: 'queued',
          active_instance_id: nextInstance,
          model,
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
        existing.updated_at = now
        return existing
      }
      existing.status = 'queued'
      existing.active_instance_id = nextInstance
      existing.model = model
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

  test('disabled flag returns { status: disabled } and does not touch DB', async () => {
    const offDeps = makeDeps({ isWaitingRoomEnabled: () => false })
    const state = await requestSession({
      userId: 'u1',
      model: DEFAULT_MODEL,
      deps: offDeps,
    })
    expect(state).toEqual({ status: 'disabled' })
    expect(offDeps.rows.size).toBe(0)
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
    const state = await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    expect(state.status).toBe('queued')
    if (state.status !== 'queued') throw new Error('unreachable')
    expect(state.position).toBe(1)
    expect(state.queueDepth).toBe(1)
    expect(state.instanceId).toBe('inst-1')
  })

  test('queued response includes a per-model depth snapshot for the selector', async () => {
    deps._tick(new Date('2026-04-17T16:00:00Z'))
    // Seed 2 users in MiniMax + 1 in Kimi so the returned map captures both.
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    deps._tick(new Date(deps._now().getTime() + 1000))
    await requestSession({ userId: 'u2', model: DEFAULT_MODEL, deps })
    deps._tick(new Date(deps._now().getTime() + 1000))
    await requestSession({ userId: 'u3', model: 'moonshotai/kimi-k2.6', deps })

    const state = await getSessionState({ userId: 'u1', deps })
    if (state.status !== 'queued') throw new Error('unreachable')
    expect(state.queueDepthByModel).toEqual({
      [DEFAULT_MODEL]: 2,
      'moonshotai/kimi-k2.6': 1,
    })
  })

  test('second call from same user rotates instance id, keeps queue position', async () => {
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
    const second = await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
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
    if (s1.status !== 'queued' || s2.status !== 'queued') throw new Error('unreachable')
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

    const second = await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps })
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
    // MiniMax saturated at 1 active, Kimi still has room.
    const admitDeps = makeDeps({
      getInstantAdmitCapacity: (model) =>
        model === DEFAULT_MODEL ? 1 : 10,
    })
    admitDeps._tick(new Date('2026-04-17T16:00:00Z'))
    await requestSession({ userId: 'u1', model: DEFAULT_MODEL, deps: admitDeps })
    const s2 = await requestSession({
      userId: 'u2',
      model: DEFAULT_MODEL,
      deps: admitDeps,
    })
    const s3 = await requestSession({
      userId: 'u3',
      model: 'moonshotai/kimi-k2.6',
      deps: admitDeps,
    })
    expect(s2.status).toBe('queued')
    expect(s3.status).toBe('active')
  })

  // Per-user rate limit (5 Kimi admissions per 12h) — the wire limit is
  // hard-coded in public-api.ts, so tests seed the fake admit log directly
  // rather than configuring it.
  const KIMI_MODEL = 'moonshotai/kimi-k2.6'
  const KIMI_LIMIT = 5
  const KIMI_WINDOW_HOURS = 12
  const KIMI_OPEN_TIME = new Date('2026-04-17T16:00:00Z')

  test('rate_limited: 5th Kimi admit in window blocks the 6th attempt', async () => {
    deps._tick(KIMI_OPEN_TIME)
    // Seed 5 admits inside the 12h window, spaced so we can verify retryAfter
    // points at the oldest one sliding off.
    const now = deps._now()
    // Oldest: 11h ago (still in window). Next 4: 1h, 2h, 3h, 4h ago.
    const ages = [11, 4, 3, 2, 1]
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
    expect(state.limit).toBe(KIMI_LIMIT)
    expect(state.windowHours).toBe(KIMI_WINDOW_HOURS)
    expect(state.recentCount).toBe(KIMI_LIMIT)
    // Oldest admit is 11h ago; slot opens when it hits 12h, i.e. in 1h.
    expect(state.retryAfterMs).toBe(60 * 60 * 1000)
    // Blocked before any row is written — the user doesn't take a queue slot.
    expect(deps.rows.has('u1')).toBe(false)
  })

  test('rate_limited: admits outside the 12h window do not count', async () => {
    deps._tick(KIMI_OPEN_TIME)
    // 5 admits, each just over 12h old → all fall off the window.
    const now = deps._now()
    for (let i = 0; i < 5; i++) {
      deps.admits.push({
        user_id: 'u1',
        model: KIMI_MODEL,
        admitted_at: new Date(
          now.getTime() - (KIMI_WINDOW_HOURS * 60 * 60 * 1000 + 60_000 + i),
        ),
      })
    }
    const state = await requestSession({
      userId: 'u1',
      model: KIMI_MODEL,
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

  test('queued Kimi response carries the current admit count', async () => {
    deps._tick(KIMI_OPEN_TIME)
    const now = deps._now()
    // 2 admits in the window — under the limit so the user still queues.
    deps.admits.push({
      user_id: 'u1',
      model: KIMI_MODEL,
      admitted_at: new Date(now.getTime() - 60 * 60 * 1000),
    })
    deps.admits.push({
      user_id: 'u1',
      model: KIMI_MODEL,
      admitted_at: new Date(now.getTime() - 30 * 60 * 1000),
    })
    const state = await requestSession({
      userId: 'u1',
      model: KIMI_MODEL,
      deps,
    })
    if (state.status !== 'queued') throw new Error('unreachable')
    expect(state.rateLimit).toEqual({
      model: KIMI_MODEL,
      limit: KIMI_LIMIT,
      windowHours: KIMI_WINDOW_HOURS,
      recentCount: 2,
    })
  })

  test('rate_limited: takeover of an active Kimi row is allowed even when at cap', async () => {
    // Reclaim path: user has an active+unexpired Kimi session and restarts
    // the CLI. POST must rotate their instance id (takeover) and NOT reject
    // with rate_limited — otherwise they'd be stranded with a live session
    // they can't reconnect to. The 5th admission is already in the log, so
    // this also exercises "at the cap" rather than "over the cap".
    deps._tick(KIMI_OPEN_TIME)
    const now = deps._now()
    // Seed 5 prior admits (the cap), with the latest one matching the
    // active row we're about to install.
    const ages = [11, 4, 3, 2, 0]
    for (const hoursAgo of ages) {
      deps.admits.push({
        user_id: 'u1',
        model: KIMI_MODEL,
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
      model: KIMI_MODEL,
      queued_at: admittedAt,
      admitted_at: admittedAt,
      expires_at: new Date(admittedAt.getTime() + SESSION_LEN),
      created_at: admittedAt,
      updated_at: admittedAt,
    })

    const state = await requestSession({
      userId: 'u1',
      model: KIMI_MODEL,
      deps,
    })
    expect(state.status).toBe('active')
    if (state.status !== 'active') throw new Error('unreachable')
    // Instance id rotated; quota snapshot still reflects the full window.
    expect(state.instanceId).not.toBe('inst-pre')
    expect(state.rateLimit?.recentCount).toBe(KIMI_LIMIT)
  })

  test('rate_limited: reclaim of a queued Kimi row is allowed even when at cap', async () => {
    // Same reclaim exception for queued rows: if a user has already queued
    // (say they slipped in just before their 5th admit landed), a subsequent
    // POST from the same CLI must preserve their queue position instead of
    // flipping to rate_limited.
    deps._tick(KIMI_OPEN_TIME)
    const now = deps._now()
    for (let i = 0; i < KIMI_LIMIT; i++) {
      deps.admits.push({
        user_id: 'u1',
        model: KIMI_MODEL,
        admitted_at: new Date(now.getTime() - (i + 1) * 60 * 60 * 1000),
      })
    }
    const queuedAt = new Date(now.getTime() - 5 * 60 * 1000)
    deps.rows.set('u1', {
      user_id: 'u1',
      status: 'queued',
      active_instance_id: 'inst-pre',
      model: KIMI_MODEL,
      queued_at: queuedAt,
      admitted_at: null,
      expires_at: null,
      created_at: queuedAt,
      updated_at: queuedAt,
    })

    const state = await requestSession({
      userId: 'u1',
      model: KIMI_MODEL,
      deps,
    })
    expect(state.status).toBe('queued')
    if (state.status !== 'queued') throw new Error('unreachable')
    // Same position (1) since we preserved queued_at and nobody else is
    // ahead; the instance id rotated so any prior CLI is superseded.
    expect(state.instanceId).not.toBe('inst-pre')
    expect(state.rateLimit?.recentCount).toBe(KIMI_LIMIT)
  })

  test('rate_limited: expired Kimi row is not a reclaim — quota still applies', async () => {
    // The stored row's expires_at is in the past, so it doesn't represent
    // an in-flight session. This POST is effectively a fresh request and
    // must be blocked by the quota.
    deps._tick(KIMI_OPEN_TIME)
    const now = deps._now()
    const ages = [11, 4, 3, 2, 1]
    for (const hoursAgo of ages) {
      deps.admits.push({
        user_id: 'u1',
        model: KIMI_MODEL,
        admitted_at: new Date(now.getTime() - hoursAgo * 60 * 60 * 1000),
      })
    }
    const admittedAt = new Date(now.getTime() - 2 * SESSION_LEN)
    deps.rows.set('u1', {
      user_id: 'u1',
      status: 'active',
      active_instance_id: 'inst-pre',
      model: KIMI_MODEL,
      queued_at: admittedAt,
      admitted_at: admittedAt,
      expires_at: new Date(admittedAt.getTime() + SESSION_LEN),
      created_at: admittedAt,
      updated_at: admittedAt,
    })
    const state = await requestSession({
      userId: 'u1',
      model: KIMI_MODEL,
      deps,
    })
    expect(state.status).toBe('rate_limited')
  })

  test('instant-admit bumps the quota count for the freshly-written admit row', async () => {
    const admitDeps = makeDeps({ getInstantAdmitCapacity: () => 3 })
    admitDeps._tick(KIMI_OPEN_TIME)
    // 1 existing admit in the window; this new call should instant-admit and
    // write a second row, so the response's recentCount reflects 2.
    const now = admitDeps._now()
    admitDeps.admits.push({
      user_id: 'u1',
      model: KIMI_MODEL,
      admitted_at: new Date(now.getTime() - 30 * 60 * 1000),
    })
    const state = await requestSession({
      userId: 'u1',
      model: KIMI_MODEL,
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

  test('disabled flag returns disabled', async () => {
    const offDeps = makeDeps({ isWaitingRoomEnabled: () => false })
    const state = await getSessionState({ userId: 'u1', deps: offDeps })
    expect(state).toEqual({ status: 'disabled' })
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
    expect(state).toEqual({ status: 'none', queueDepthByModel: {} })
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
    // limits only apply to Kimi, so this test uses Kimi explicitly rather
    // than the Minimax DEFAULT_MODEL.
    deps._tick(new Date('2026-04-17T16:00:00Z'))
    const now = deps._now()
    deps.admits.push({
      user_id: 'u1',
      model: 'moonshotai/kimi-k2.6',
      admitted_at: new Date(now.getTime() - 60 * 60 * 1000),
    })
    await requestSession({ userId: 'u1', model: 'moonshotai/kimi-k2.6', deps })
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
    expect(state.rateLimit).toEqual({
      model: 'moonshotai/kimi-k2.6',
      limit: 5,
      windowHours: 12,
      recentCount: 1,
    })
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
    expect(state).toEqual({ status: 'none', queueDepthByModel: {} })
  })
})

describe('checkSessionAdmissible', () => {
  let deps: ReturnType<typeof makeDeps>
  beforeEach(() => {
    deps = makeDeps()
  })

  test('disabled flag → ok with reason=disabled', async () => {
    const offDeps = makeDeps({ isWaitingRoomEnabled: () => false })
    const result = await checkSessionAdmissible({
      userId: 'u1',
      claimedInstanceId: undefined,
      deps: offDeps,
    })
    expect(result.ok).toBe(true)
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

  test('bypassed email (team@codebuff.com) → ok with reason=disabled, no DB read', async () => {
    const result = await checkSessionAdmissible({
      userId: 'u1',
      userEmail: 'team@codebuff.com',
      claimedInstanceId: undefined,
      deps,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('disabled')
    expect(deps.rows.size).toBe(0)
  })

  test('bypassed email is case-insensitive', async () => {
    const result = await checkSessionAdmissible({
      userId: 'u1',
      userEmail: 'Team@Codebuff.COM',
      claimedInstanceId: undefined,
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
    if (!result.ok || result.reason !== 'draining') throw new Error('unreachable')
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

  test('is no-op when disabled', async () => {
    const deps = makeDeps({ isWaitingRoomEnabled: () => false })
    deps.rows.set('u1', {
      user_id: 'u1',
      status: 'active',
      active_instance_id: 'x',
      model: DEFAULT_MODEL,
      queued_at: new Date(),
      admitted_at: null,
      expires_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    })
    await endUserSession({ userId: 'u1', deps })
    expect(deps.rows.has('u1')).toBe(true)
  })
})
