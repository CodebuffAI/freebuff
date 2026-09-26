import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'
import {
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_GLM_V53_FLASH_MODEL_ID,
  FREEBUFF_MIMO_V25_MODEL_ID,
} from '@codebuff/common/constants/freebuff-models'
import * as auth from '../../utils/auth'
import { useFreebuffSessionStore } from '../../state/freebuff-session-store'
import { useFreebuffModelStore } from '../../state/freebuff-model-store'
import * as cli from '../use-freebuff-session'

// Prod, 2026-09-26 06:26-06:28Z: CLI 0.0.196 (legacy single-session protocol)
// admitted GLM 5.3 Flash, an old npm launcher SIGTERMed it for an update, the
// 0.0.196 binary kept its legacy hour for the relaunch (#4020), and the
// relaunched 0.0.200 binary probed with a fresh `cli:` claim, saw `none`,
// showed the picker and sold the same model again. These tests drive the real
// hook against a server that implements both protocols.
//
// IS_FREEBUFF is a build-time constant: run in an isolated Freebuff process.
if (process.env.CLI_LEGACY_RELAUNCH_TEST !== '1') {
  test('legacy-hour adoption after a cross-protocol update restart (isolated Freebuff build)', async () => {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: {
        ...process.env,
        FREEBUFF_MODE: 'true',
        CLI_LEGACY_RELAUNCH_TEST: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, output: code ? stdout + stderr : '' }).toEqual({
      code: 0,
      output: '',
    })
  }, 30_000)
} else {
  type Row = {
    status: 'active'
    instanceId: string
    model: string
    admittedAt: string
    expiresAt: string
    remainingMs: number
    accessTier: 'full'
  }
  type Request = {
    method: string
    multi: boolean
    instanceId: string | null
    token: string
  }

  const OWNER_FILE = 'freebuff-instance-owner.json'
  let close: (() => void) | undefined
  let fetchSpy: ReturnType<typeof spyOn>
  let authSpy: ReturnType<typeof spyOn>
  let configSpy: ReturnType<typeof spyOn>
  let configDir: string
  let unsubscribe: (() => void) | undefined
  /** The single per-account legacy row, keyed by bearer token. */
  const legacy = new Map<string, Row>()
  /** Multi-session rows, keyed by `cli:` instance. */
  const claims = new Map<string, Row>()
  const requests: Request[] = []
  const statuses: string[] = []
  let purchases = 0
  let failLegacyGet = false

  const deadPid = () => Bun.spawnSync(['true']).pid
  const ownerPath = () => join(configDir, OWNER_FILE)
  const writeOwner = (owner: Record<string, unknown>) =>
    writeFileSync(ownerPath(), JSON.stringify(owner))
  const tokenKey = (token: string) =>
    createHash('sha256').update(token).digest('hex')

  function row(instanceId: string, model: string, expiresAt?: string): Row {
    return {
      status: 'active',
      instanceId,
      model,
      accessTier: 'full',
      admittedAt: new Date().toISOString(),
      expiresAt: expiresAt ?? new Date(Date.now() + 3_000_000).toISOString(),
      remainingMs: 3_000_000,
    }
  }

  async function until(condition: () => boolean) {
    const deadline = performance.now() + 3_000
    while (!condition()) {
      if (performance.now() > deadline) throw new Error('CLI did not settle')
      await Bun.sleep(5)
    }
  }

  beforeEach(() => {
    legacy.clear()
    claims.clear()
    requests.length = 0
    statuses.length = 0
    purchases = 0
    failLegacyGet = false
    configDir = mkdtempSync(join(tmpdir(), 'cli-legacy-relaunch-'))
    configSpy = spyOn(auth, 'getConfigDir').mockReturnValue(configDir)
    authSpy = spyOn(auth, 'getAuthTokenDetails').mockReturnValue({
      token: 'fixture',
      source: 'environment',
    })
    // The user's saved preference differs from the model they paid for.
    useFreebuffModelStore
      .getState()
      .setSelectedModel(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)
    useFreebuffSessionStore.getState().setSession(null)
    unsubscribe = useFreebuffSessionStore.subscribe((state) => {
      if (state.session) statuses.push(state.session.status)
    })
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const headers = new Headers(init?.headers)
      const method = init?.method ?? 'GET'
      const token = headers.get('authorization')!.replace('Bearer ', '')
      const multi = headers.get('x-freebuff-multi-session') === '1'
      const instanceId = headers.get('x-freebuff-instance-id')
      requests.push({ method, multi, instanceId, token })
      const model = headers.get('x-freebuff-model')!
      if (!multi) {
        const held = legacy.get(token)
        if (method === 'GET') {
          if (failLegacyGet) throw new TypeError('network down')
          if (!held) return Response.json({ status: 'none' })
          if (instanceId && instanceId !== held.instanceId)
            return Response.json({ status: 'superseded' })
          return Response.json(held)
        }
        if (method === 'DELETE') {
          legacy.delete(token)
          return Response.json({ status: 'ended' })
        }
        // requestSession: an active same-model row is rotated on the same
        // expiry (a takeover, not an admission); anything else is a purchase.
        if (held && held.model === model) {
          const rotated = { ...held, instanceId: randomUUID() }
          legacy.set(token, rotated)
          return Response.json(rotated)
        }
        purchases++
        const fresh = row(randomUUID(), model)
        legacy.set(token, fresh)
        return Response.json(fresh)
      }
      const id = instanceId!
      if (method === 'GET')
        return Response.json(claims.get(id) ?? { status: 'none' })
      if (method === 'DELETE') {
        claims.delete(id)
        return Response.json({ status: 'ended', freebucksRefund: 0 })
      }
      if (!claims.has(id)) {
        purchases++
        claims.set(id, row(id, model))
      }
      return Response.json(claims.get(id))
    }) as typeof fetch)
  })

  afterEach(async () => {
    close?.()
    close = undefined
    await Bun.sleep(5)
    unsubscribe?.()
    fetchSpy.mockRestore()
    authSpy.mockRestore()
    configSpy.mockRestore()
    useFreebuffSessionStore.getState().setSession(null)
    useFreebuffSessionStore.getState().setFailure(null)
    rmSync(configDir, { recursive: true, force: true })
  })

  async function mount(expectedStatus: 'none' | 'active') {
    const setup = await createTestRenderer({ width: 30, height: 2 })
    const root = createRoot(setup.renderer)
    function Controller() {
      cli.useFreebuffSession()
      return null
    }
    close = () => {
      flushSync(() => root.unmount())
      setup.renderer.destroy()
    }
    flushSync(() => root.render(<Controller />))
    await until(
      () =>
        useFreebuffSessionStore.getState().session?.status === expectedStatus,
    )
    // Let any follow-up tick land before asserting on the request log.
    await Bun.sleep(30)
  }

  test('the relaunch resumes the legacy hour 0.0.196 kept: same session, no purchase, no picker', async () => {
    const expiresAt = new Date(Date.now() + 2_900_000).toISOString()
    legacy.set(
      'fixture',
      row('ea1559bb-legacy', FREEBUFF_GLM_V53_FLASH_MODEL_ID, expiresAt),
    )
    // Exactly what 0.0.196 writes: no token key.
    writeOwner({ instanceId: 'ea1559bb-legacy', pid: deadPid() })

    await mount('active')

    expect(purchases).toBe(0)
    // The picker (status none) was never shown.
    expect(statuses).not.toContain('none')
    const session = useFreebuffSessionStore.getState().session
    expect(session).toMatchObject({
      status: 'active',
      model: FREEBUFF_GLM_V53_FLASH_MODEL_ID,
      expiresAt,
    })
    // Same server session, rotated to this process.
    const rotated = legacy.get('fixture')!.instanceId
    expect(cli.getFreebuffInstanceId()).toBe(rotated)
    expect(rotated).not.toBe('ea1559bb-legacy')
    expect(requests.slice(0, 2)).toEqual([
      {
        method: 'GET',
        multi: false,
        instanceId: 'ea1559bb-legacy',
        token: 'fixture',
      },
      { method: 'POST', multi: false, instanceId: null, token: 'fixture' },
    ])
    expect(requests.every((r) => !r.multi)).toBe(true)
    expect(requests.some((r) => r.method === 'DELETE')).toBe(false)
    // A later launch after THIS process dies may resume the same hour again,
    // but never the retired instance.
    const owner = JSON.parse(readFileSync(ownerPath(), 'utf8'))
    expect(owner).toMatchObject({ instanceId: rotated, pid: process.pid })
    expect(owner.tokenKey).toBe(tokenKey('fixture'))

    // Ending it releases the legacy row; the next pick is an ordinary claim.
    await cli.returnToFreebuffLanding()
    expect(legacy.has('fixture')).toBe(false)
    expect(requests.find((r) => r.method === 'DELETE')?.multi).toBe(false)
    await cli.startFreebuffSession(FREEBUFF_MIMO_V25_MODEL_ID)
    expect(cli.getFreebuffInstanceId()).toStartWith('cli:')
    expect(requests.at(-1)).toMatchObject({ method: 'POST', multi: true })
    expect(purchases).toBe(1)
  })

  test('a model switch leaves the adopted hour and buys on a cli: claim', async () => {
    legacy.set('fixture', row('legacy-a', FREEBUFF_GLM_V53_FLASH_MODEL_ID))
    writeOwner({ instanceId: 'legacy-a', pid: deadPid() })
    await mount('active')
    await cli.startFreebuffSession(FREEBUFF_MIMO_V25_MODEL_ID)
    expect(legacy.has('fixture')).toBe(false)
    expect(cli.getFreebuffInstanceId()).toStartWith('cli:')
    expect(purchases).toBe(1)
  })

  test('re-syncing the adopted hour stays on it instead of buying a cli: claim', async () => {
    legacy.set('fixture', row('legacy-sync', FREEBUFF_GLM_V53_FLASH_MODEL_ID))
    writeOwner({ instanceId: 'legacy-sync', pid: deadPid() })
    await mount('active')
    // The chat gate's `waiting_room_queued` re-sync: no release, just rejoin.
    await cli.refreshFreebuffSession()
    expect(requests.at(-1)).toMatchObject({ method: 'POST', multi: false })
    expect(useFreebuffSessionStore.getState().session?.status).toBe('active')
    expect(requests.every((r) => !r.multi)).toBe(true)
    expect(purchases).toBe(0)
  })

  test('a live owner keeps its hour: nothing is probed or adopted', async () => {
    legacy.set('fixture', row('legacy-live', FREEBUFF_GLM_V53_FLASH_MODEL_ID))
    writeOwner({ instanceId: 'legacy-live', pid: process.ppid })
    await mount('none')
    expect(requests.every((r) => r.multi)).toBe(true)
    expect(legacy.get('fixture')?.instanceId).toBe('legacy-live')
    expect(purchases).toBe(0)
    expect(existsSync(ownerPath())).toBe(true)
  })

  test('an ended or expired legacy hour falls back to the picker and is forgotten', async () => {
    writeOwner({ instanceId: 'legacy-gone', pid: deadPid() })
    await mount('none')
    expect(requests[0]).toMatchObject({
      method: 'GET',
      multi: false,
      instanceId: 'legacy-gone',
    })
    expect(requests.slice(1).every((r) => r.multi)).toBe(true)
    expect(purchases).toBe(0)
    expect(existsSync(ownerPath())).toBe(false)
  })

  test("another account's record is never adopted", async () => {
    // A record this binary wrote for a different login: not even probed.
    legacy.set('fixture', row('legacy-mine', FREEBUFF_GLM_V53_FLASH_MODEL_ID))
    writeOwner({
      instanceId: 'legacy-mine',
      pid: deadPid(),
      tokenKey: tokenKey('someone-else'),
    })
    await mount('none')
    expect(requests.every((r) => r.multi)).toBe(true)
    expect(legacy.get('fixture')?.instanceId).toBe('legacy-mine')
    close!()
    close = undefined
    useFreebuffSessionStore.getState().setSession(null)

    // An unscoped 0.0.196 record: the authenticated GET says this account
    // holds a different instance, so the superseded verdict is swallowed and
    // the relaunch starts normally.
    requests.length = 0
    writeOwner({ instanceId: 'legacy-theirs', pid: deadPid() })
    await mount('none')
    expect(requests[0]).toMatchObject({
      multi: false,
      instanceId: 'legacy-theirs',
    })
    expect(requests.slice(1).every((r) => r.multi)).toBe(true)
    expect(legacy.get('fixture')?.instanceId).toBe('legacy-mine')
    expect(purchases).toBe(0)
  })

  test('an unanswered probe falls back to a fresh claim', async () => {
    legacy.set('fixture', row('legacy-net', FREEBUFF_GLM_V53_FLASH_MODEL_ID))
    writeOwner({ instanceId: 'legacy-net', pid: deadPid() })
    failLegacyGet = true
    await mount('none')
    expect(useFreebuffSessionStore.getState().failure).toBeNull()
    expect(requests.slice(1).every((r) => r.multi)).toBe(true)
    expect(purchases).toBe(0)
  })

  test('a model the multi-session picker would not offer is never adopted', async () => {
    // Limited-offer trials (and anything outside the CLI catalog) keep their
    // own legacy path; adoption only ever carries an ordinary catalog model.
    legacy.set('fixture', row('legacy-trial', 'vendor/not-in-the-cli-catalog'))
    writeOwner({ instanceId: 'legacy-trial', pid: deadPid() })
    await mount('none')
    expect(requests.slice(1).every((r) => r.multi)).toBe(true)
    expect(legacy.get('fixture')?.instanceId).toBe('legacy-trial')
    expect(purchases).toBe(0)
  })
}
