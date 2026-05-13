import { describe, expect, test } from 'bun:test'

import {
  deleteFreebuffSession,
  FREEBUFF_INSTANCE_HEADER,
  FREEBUFF_MODEL_HEADER,
  getFreebuffSession,
  postFreebuffSession,
} from '../_handlers'
import { FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID } from '@codebuff/common/constants/freebuff-models'

import type { FreebuffSessionDeps } from '../_handlers'
import type { FreeModeCountryAccess } from '@/server/free-mode-country'
import type { SessionDeps } from '@/server/free-session/public-api'
import type { InternalSessionRow } from '@/server/free-session/types'
import type { NextRequest } from 'next/server'

const DEFAULT_MODEL = 'minimax/minimax-m2.7'

function testCountryAccess(req: NextRequest): FreeModeCountryAccess {
  const cfCountry = req.headers.get('cf-ipcountry')?.toUpperCase() ?? null
  const hasClientIp = Boolean(
    req.headers.get('x-forwarded-for') ??
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-real-ip'),
  )
  if (cfCountry === 'T1' || cfCountry === 'XX') {
    return {
      allowed: false,
      countryCode: null,
      blockReason: 'anonymized_or_unknown_country',
      cfCountry,
      geoipCountry: null,
      ipPrivacy: null,
      hasClientIp,
      clientIpHash: hasClientIp ? 'test-ip-hash' : null,
    }
  }
  if (!cfCountry || !hasClientIp) {
    return {
      allowed: false,
      countryCode: null,
      blockReason: 'missing_client_ip',
      cfCountry,
      geoipCountry: null,
      ipPrivacy: null,
      hasClientIp,
      clientIpHash: hasClientIp ? 'test-ip-hash' : null,
    }
  }
  if (cfCountry !== 'US') {
    return {
      allowed: false,
      countryCode: cfCountry,
      blockReason: 'country_not_allowed',
      cfCountry,
      geoipCountry: null,
      ipPrivacy: null,
      hasClientIp,
      clientIpHash: 'test-ip-hash',
    }
  }
  return {
    allowed: true,
    countryCode: cfCountry,
    blockReason: null,
    cfCountry,
    geoipCountry: null,
    ipPrivacy: { signals: [] },
    hasClientIp,
    clientIpHash: 'test-ip-hash',
  }
}

function makeReq(
  apiKey: string | null,
  opts: {
    instanceId?: string
    cfCountry?: string | null
    model?: string
  } = {},
): NextRequest {
  const headers = new Headers()
  if (apiKey) headers.set('Authorization', `Bearer ${apiKey}`)
  if (opts.instanceId) headers.set(FREEBUFF_INSTANCE_HEADER, opts.instanceId)
  const cfCountry = opts.cfCountry === null ? null : (opts.cfCountry ?? 'US')
  if (cfCountry) {
    headers.set('cf-ipcountry', cfCountry)
    headers.set('cf-connecting-ip', '203.0.113.10')
  }
  if (opts.model) headers.set(FREEBUFF_MODEL_HEADER, opts.model)
  return {
    headers,
  } as unknown as NextRequest
}

function makeSessionDeps(overrides: Partial<SessionDeps> = {}): SessionDeps & {
  rows: Map<string, InternalSessionRow>
} {
  const rows = new Map<string, InternalSessionRow>()
  const now = new Date('2026-04-17T12:00:00Z')
  let instanceCounter = 0
  return {
    rows,
    graceMs: 30 * 60 * 1000,
    sessionLengthMs: 60 * 60 * 1000,
    // Keep instant-admit disabled in handler tests — they verify queue/state
    // transitions, not admission policy. With capacity 0 the deps below
    // aren't reached, so they're trivial stubs.
    getInstantAdmitCapacity: () => 0,
    activeCountForModel: async () => 0,
    promoteQueuedUser: async () => null,
    // No admits in handler tests — the rate-limit check reads empty and
    // every request falls through to the queue.
    listRecentPremiumAdmits: async () => [],
    now: () => now,
    getSessionRow: async (userId) => rows.get(userId) ?? null,
    queueDepthsByModel: async () => {
      const out: Record<string, number> = {}
      for (const r of rows.values()) {
        if (r.status !== 'queued') continue
        out[r.model] = (out[r.model] ?? 0) + 1
      }
      return out
    },
    queuePositionFor: async () => 1,
    endSession: async ({ userId }) => {
      rows.delete(userId)
    },
    joinOrTakeOver: async ({
      userId,
      model,
      accessTier,
      now,
      countryAccess,
    }) => {
      const r: InternalSessionRow = {
        user_id: userId,
        status: 'queued',
        active_instance_id: `inst-${++instanceCounter}`,
        model,
        access_tier: accessTier,
        country_code: countryAccess?.countryCode ?? null,
        cf_country: countryAccess?.cfCountry ?? null,
        geoip_country: countryAccess?.geoipCountry ?? null,
        country_block_reason: countryAccess?.blockReason ?? null,
        ip_privacy_signals: countryAccess?.ipPrivacySignals ?? null,
        client_ip_hash: countryAccess?.clientIpHash ?? null,
        country_checked_at: countryAccess?.checkedAt ?? null,
        queued_at: now,
        admitted_at: null,
        expires_at: null,
        created_at: now,
        updated_at: now,
      }
      rows.set(userId, r)
      return r
    },
    ...overrides,
  }
}

const LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
}

function makeDeps(
  sessionDeps: SessionDeps,
  userId: string | null,
  opts: {
    banned?: boolean
    getCountryAccess?: FreebuffSessionDeps['getCountryAccess']
  } = {},
): FreebuffSessionDeps {
  return {
    logger: LOGGER as unknown as FreebuffSessionDeps['logger'],
    getCountryAccess:
      opts.getCountryAccess ?? (async (req) => testCountryAccess(req)),
    getUserInfoFromApiKey: (async () =>
      userId
        ? { id: userId, banned: opts.banned ?? false }
        : undefined) as unknown as FreebuffSessionDeps['getUserInfoFromApiKey'],
    sessionDeps,
  }
}

describe('POST /api/v1/freebuff/session', () => {
  test('401 when Authorization header is missing', async () => {
    const sessionDeps = makeSessionDeps()
    const resp = await postFreebuffSession(
      makeReq(null),
      makeDeps(sessionDeps, null),
    )
    expect(resp.status).toBe(401)
  })

  test('401 when API key is invalid', async () => {
    const sessionDeps = makeSessionDeps()
    const resp = await postFreebuffSession(
      makeReq('bad'),
      makeDeps(sessionDeps, null),
    )
    expect(resp.status).toBe(401)
  })

  test('creates a queued session for authed user', async () => {
    const sessionDeps = makeSessionDeps()
    const resp = await postFreebuffSession(
      makeReq('ok'),
      makeDeps(sessionDeps, 'u1'),
    )
    expect(resp.status).toBe(200)
    const body = await resp.json()
    expect(body.status).toBe('queued')
    expect(body.instanceId).toBe('inst-1')
    expect(sessionDeps.rows.get('u1')).toMatchObject({
      country_code: 'US',
      cf_country: 'US',
      ip_privacy_signals: [],
      client_ip_hash: 'test-ip-hash',
    })
  })

  test('creates a limited DeepSeek Flash session for disallowed country', async () => {
    const sessionDeps = makeSessionDeps()
    const resp = await postFreebuffSession(
      makeReq('ok', { cfCountry: 'JP', model: DEFAULT_MODEL }),
      makeDeps(sessionDeps, 'u1'),
    )
    expect(resp.status).toBe(200)
    const body = await resp.json()
    expect(body.status).toBe('queued')
    expect(body.accessTier).toBe('limited')
    expect(body.model).toBe(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)
    expect(sessionDeps.rows.get('u1')).toMatchObject({
      access_tier: 'limited',
      country_code: 'JP',
      country_block_reason: 'country_not_allowed',
    })
  })

  test('creates a limited DeepSeek Flash session when country is unknown', async () => {
    const sessionDeps = makeSessionDeps()
    const resp = await postFreebuffSession(
      makeReq('ok', { cfCountry: null }),
      makeDeps(sessionDeps, 'u1'),
    )
    expect(resp.status).toBe(200)
    const body = await resp.json()
    expect(body.status).toBe('queued')
    expect(body.accessTier).toBe('limited')
    expect(body.model).toBe(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)
  })

  test('creates a limited DeepSeek Flash session for anonymized Cloudflare country', async () => {
    const sessionDeps = makeSessionDeps()
    const resp = await postFreebuffSession(
      makeReq('ok', { cfCountry: 'T1' }),
      makeDeps(sessionDeps, 'u1'),
    )
    expect(resp.status).toBe(200)
    const body = await resp.json()
    expect(body.status).toBe('queued')
    expect(body.accessTier).toBe('limited')
    expect(body.model).toBe(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)
  })

  test('allows queue entry for allowed country', async () => {
    const sessionDeps = makeSessionDeps()
    const resp = await postFreebuffSession(
      makeReq('ok', { cfCountry: 'US' }),
      makeDeps(sessionDeps, 'u1'),
    )
    const body = await resp.json()
    expect(body.status).toBe('queued')
  })

  test('returns model_unavailable for legacy GLM 5.1 outside deployment hours', async () => {
    const sessionDeps = makeSessionDeps()
    const resp = await postFreebuffSession(
      makeReq('ok', { model: 'z-ai/glm-5.1' }),
      makeDeps(sessionDeps, 'u1'),
    )
    expect(resp.status).toBe(409)
    const body = await resp.json()
    expect(body.status).toBe('model_unavailable')
    expect(body.availableHours).toBe('9am ET-5pm PT every day')
    expect(sessionDeps.rows.size).toBe(0)
  })

  // Banned bots with valid API keys were POSTing every few seconds and
  // inflating queueDepth between the 15s admission-tick sweeps. Rejecting at
  // the HTTP layer with 403 (terminal, like country_blocked) keeps them out
  // entirely. Also verifies no queue row is created as a side effect.
  test('returns banned 403 without joining the queue for banned user', async () => {
    const sessionDeps = makeSessionDeps()
    const resp = await postFreebuffSession(
      makeReq('ok'),
      makeDeps(sessionDeps, 'u1', { banned: true }),
    )
    expect(resp.status).toBe(403)
    const body = await resp.json()
    expect(body.status).toBe('banned')
    expect(sessionDeps.rows.size).toBe(0)
  })
})

describe('GET /api/v1/freebuff/session', () => {
  test('returns { status: none } when user has no session', async () => {
    const sessionDeps = makeSessionDeps()
    const resp = await getFreebuffSession(
      makeReq('ok'),
      makeDeps(sessionDeps, 'u1'),
    )
    expect(resp.status).toBe(200)
    const body = await resp.json()
    expect(body.status).toBe('none')
  })

  test('returns limited access for disallowed country on GET', async () => {
    const sessionDeps = makeSessionDeps()
    const resp = await getFreebuffSession(
      makeReq('ok', { cfCountry: 'JP' }),
      makeDeps(sessionDeps, 'u1'),
    )
    expect(resp.status).toBe(200)
    const body = await resp.json()
    expect(body.status).toBe('none')
    expect(body.accessTier).toBe('limited')
  })

  test('rechecks country on GET so access tier changes are visible immediately', async () => {
    const sessionDeps = makeSessionDeps()
    sessionDeps.rows.set('u1', {
      user_id: 'u1',
      status: 'queued',
      active_instance_id: 'inst-1',
      model: DEFAULT_MODEL,
      access_tier: 'full',
      country_code: 'US',
      cf_country: 'US',
      geoip_country: null,
      country_block_reason: null,
      ip_privacy_signals: [],
      client_ip_hash: 'test-ip-hash',
      country_checked_at: new Date('2026-04-17T11:45:00Z'),
      queued_at: new Date('2026-04-17T11:45:00Z'),
      admitted_at: null,
      expires_at: null,
      created_at: new Date('2026-04-17T11:45:00Z'),
      updated_at: new Date('2026-04-17T11:45:00Z'),
    })
    let countryChecks = 0
    const resp = await getFreebuffSession(
      makeReq('ok', { cfCountry: 'JP' }),
      makeDeps(sessionDeps, 'u1', {
        getCountryAccess: async (req) => {
          countryChecks++
          return testCountryAccess(req)
        },
      }),
    )
    const body = await resp.json()
    expect(resp.status).toBe(200)
    expect(body.status).toBe('none')
    expect(body.accessTier).toBe('limited')
    expect(countryChecks).toBe(1)
  })

  test('returns banned 403 on GET for banned user', async () => {
    const sessionDeps = makeSessionDeps()
    const resp = await getFreebuffSession(
      makeReq('ok'),
      makeDeps(sessionDeps, 'u1', { banned: true }),
    )
    expect(resp.status).toBe(403)
    const body = await resp.json()
    expect(body.status).toBe('banned')
  })

  test('returns superseded when active row exists with mismatched instance id', async () => {
    const sessionDeps = makeSessionDeps()
    sessionDeps.rows.set('u1', {
      user_id: 'u1',
      status: 'active',
      active_instance_id: 'real-id',
      model: DEFAULT_MODEL,
      queued_at: new Date(),
      admitted_at: new Date(),
      expires_at: new Date(Date.now() + 60_000),
      created_at: new Date(),
      updated_at: new Date(),
    })
    const resp = await getFreebuffSession(
      makeReq('ok', { instanceId: 'stale-id' }),
      makeDeps(sessionDeps, 'u1'),
    )
    const body = await resp.json()
    expect(body.status).toBe('superseded')
  })
})

describe('DELETE /api/v1/freebuff/session', () => {
  test('ends the session', async () => {
    const sessionDeps = makeSessionDeps()
    // Pre-seed a row
    sessionDeps.rows.set('u1', {
      user_id: 'u1',
      status: 'active',
      active_instance_id: 'x',
      model: DEFAULT_MODEL,
      queued_at: new Date(),
      admitted_at: new Date(),
      expires_at: new Date(Date.now() + 60_000),
      created_at: new Date(),
      updated_at: new Date(),
    })
    const resp = await deleteFreebuffSession(
      makeReq('ok'),
      makeDeps(sessionDeps, 'u1'),
    )
    expect(resp.status).toBe(200)
    expect(sessionDeps.rows.has('u1')).toBe(false)
  })
})
