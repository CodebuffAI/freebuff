import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
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
  FREEBUFF_MIMO_V25_MODEL_ID,
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
} from '@codebuff/common/constants/freebuff-models'
import * as auth from '../../utils/auth'
import { useFreebuffSessionStore } from '../../state/freebuff-session-store'
import { useFreebuffModelStore } from '../../state/freebuff-model-store'
import { freebuffSessionMetadata } from '../../utils/freebuff-session-identity'
import { consumeFreebuffSessionRelaunch } from '../../utils/freebuff-session-relaunch'
import * as cli from '../use-freebuff-session'

// IS_FREEBUFF is a build-time constant. Run the controller in its own Freebuff
// process instead of mocking an already-imported constant in other CLI suites.
if (process.env.CLI_MULTI_SESSION_TEST !== '1') {
  test('multi-instance CLI lifecycle (isolated Freebuff build)', async () => {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: {
        ...process.env,
        FREEBUFF_MODE: 'true',
        CLI_MULTI_SESSION_TEST: '1',
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
  }, 20_000)
} else {
  let close: (() => void) | undefined
  let fetchSpy: ReturnType<typeof spyOn>
  let authSpy: ReturnType<typeof spyOn>
  let configSpy: ReturnType<typeof spyOn>
  let configDir: string
  type Active = {
    status: 'active'
    model: string
    instanceId: string
    admittedAt: string
    expiresAt: string
    remainingMs: number
    accessTier: 'full' | 'limited'
  }
  const rows = new Map<string, Active>()
  const requests: { method: string; headers: Headers; path: string }[] = []
  let purchases = 0
  let capacity = Infinity
  let losePostResponse = false
  let loseDeleteResponse = false
  let tier: 'full' | 'limited' = 'full'

  async function until(condition: () => boolean) {
    const deadline = performance.now() + 3_000
    while (!condition()) {
      if (performance.now() > deadline) throw new Error('CLI did not settle')
      await Bun.sleep(5)
    }
  }

  beforeEach(() => {
    rows.clear()
    requests.length = 0
    purchases = 0
    capacity = Infinity
    losePostResponse = false
    loseDeleteResponse = false
    tier = 'full'
    configDir = mkdtempSync(join(tmpdir(), 'cli-multi-session-'))
    configSpy = spyOn(auth, 'getConfigDir').mockReturnValue(configDir)
    authSpy = spyOn(auth, 'getAuthTokenDetails').mockReturnValue({
      token: 'fixture',
      source: 'environment',
    })
    useFreebuffModelStore
      .getState()
      .setSelectedModel(FREEBUFF_MIMO_V25_MODEL_ID)
    useFreebuffSessionStore.getState().setSession(null)
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const headers = new Headers(init?.headers)
      const method = init?.method ?? 'GET'
      const path = new URL(String(input)).pathname
      requests.push({ method, headers, path })
      // Exercise the real hook and transport against an independently keyed
      // session service. A global GET or DELETE would affect the sibling row.
      expect(headers.get('x-freebuff-multi-session')).toBe('1')
      const id = headers.get('x-freebuff-instance-id')!
      expect(id).toStartWith('cli:')
      if (method === 'GET')
        return Response.json(
          rows.get(id) ?? { status: 'none', accessTier: tier },
        )
      expect(headers.get('x-freebuff-desktop-attempt-id')).toBe(id.slice(4))
      if (method === 'DELETE') {
        expect(path).toEndWith('/session/attempt')
        rows.delete(id)
        if (loseDeleteResponse) {
          loseDeleteResponse = false
          throw new TypeError('response lost')
        }
        return Response.json({ status: 'ended', freebucksRefund: 0 })
      }
      const model = headers.get('x-freebuff-model')!
      const holder = [...rows.keys()].find((key) => key !== id)
      if (!rows.has(id) && rows.size >= capacity && holder) {
        if (headers.get('x-freebuff-takeover-instance-id') !== holder)
          return Response.json(
            {
              status: 'purchase_capacity',
              requestedModel: model,
              currentInstanceId: holder,
              accessTier: tier,
              slotLimit: capacity,
            },
            { status: 409 },
          )
        rows.delete(holder)
      }
      if (!rows.has(id)) {
        purchases++
        rows.set(id, active(id, model))
      }
      if (losePostResponse) {
        losePostResponse = false
        throw new TypeError('response lost')
      }
      return Response.json(rows.get(id))
    }) as typeof fetch)
  })

  afterEach(async () => {
    close?.()
    close = undefined
    // Let the effect's bounded best-effort release finish before restoring fetch.
    await Bun.sleep(5)
    fetchSpy.mockRestore()
    authSpy.mockRestore()
    configSpy.mockRestore()
    useFreebuffSessionStore.getState().setSession(null)
    useFreebuffSessionStore.getState().setFailure(null)
    rmSync(configDir, { recursive: true, force: true })
  })

  function active(
    instanceId: string,
    model: string = FREEBUFF_MIMO_V25_MODEL_ID,
  ): Active {
    return {
      status: 'active',
      instanceId,
      model,
      accessTier: tier,
      admittedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      remainingMs: 3_600_000,
    }
  }

  async function mount(expectedStatus: 'none' | 'active' = 'none') {
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
  }

  test('startup, admission, model switch and end never take a sibling session', async () => {
    rows.set('desktop-sibling', active('desktop-sibling'))
    await mount()
    expect(requests.every((r) => r.method === 'GET')).toBe(true)
    await cli.startFreebuffSession(FREEBUFF_MIMO_V25_MODEL_ID)
    const first = cli.getFreebuffInstanceId()!
    expect(rows.size).toBe(2)
    expect(freebuffSessionMetadata(first)).toEqual({
      freebuff_instance_id: first,
      freebuff_multi_session: '1',
      surface: 'cli',
    })
    await cli.startFreebuffSession(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)
    const second = cli.getFreebuffInstanceId()!
    expect(second).not.toBe(first)
    expect(rows.has(first)).toBe(false)
    expect(rows.get(second)?.model).toBe(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)
    await cli.returnToFreebuffLanding()
    expect([...rows.keys()]).toEqual(['desktop-sibling'])
    await cli.startFreebuffSession(FREEBUFF_MIMO_V25_MODEL_ID)
    expect(cli.getFreebuffInstanceId()).not.toBe(second)
    expect(purchases).toBe(3)
  })

  test('an update relaunch resumes only its own launcher-scoped purchase', async () => {
    const previousPid = process.env.CODEBUFF_LAUNCHER_PID
    process.env.CODEBUFF_LAUNCHER_PID = '12345'
    try {
      rows.set('desktop-sibling', active('desktop-sibling'))
      await mount()
      await cli.startFreebuffSession(FREEBUFF_MIMO_V25_MODEL_ID)
      const original = cli.getFreebuffInstanceId()!
      useFreebuffSessionStore.getState().keepSlotForRelaunch()
      await useFreebuffSessionStore.getState().releaseSlot()
      close!()
      close = undefined
      expect(rows.has(original)).toBe(true)
      expect(requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)

      process.env.CODEBUFF_LAUNCHER_PID = '54321'
      expect(consumeFreebuffSessionRelaunch('fixture')).toBeUndefined()
      process.env.CODEBUFF_LAUNCHER_PID = '12345'
      useFreebuffSessionStore.getState().setSession(null)
      useFreebuffSessionStore.setState({ slotKeptForRelaunch: false })
      await mount('active')
      expect(cli.getFreebuffInstanceId()).toBe(original)
      expect(purchases).toBe(1)
      expect(rows.has('desktop-sibling')).toBe(true)
      expect(consumeFreebuffSessionRelaunch('fixture')).toBeUndefined()
    } finally {
      useFreebuffSessionStore.setState({ slotKeptForRelaunch: false })
      if (previousPid === undefined) delete process.env.CODEBUFF_LAUNCHER_PID
      else process.env.CODEBUFF_LAUNCHER_PID = previousPid
    }
  })

  // Discord 2026-09-25: "the CLI crashed ... when manually opened again the
  // freebucks are deducted even though the session was only running for 2
  // minutes". A crash skips every release and every update handoff; the only
  // trace is the dead process's live record.
  test('a relaunch after a crash resumes the unexpired hour instead of buying another', async () => {
    rows.set('desktop-sibling', active('desktop-sibling'))
    await mount()
    await cli.startFreebuffSession(FREEBUFF_MIMO_V25_MODEL_ID)
    const original = cli.getFreebuffInstanceId()!
    const ownRecord = join(configDir, `freebuff-live-${process.pid}.json`)
    await until(() => existsSync(ownRecord))
    expect(JSON.parse(readFileSync(ownRecord, 'utf8')).instanceId).toBe(
      original,
    )

    // The crash: no DELETE, and the record now names a process that is gone.
    const deadPid = Bun.spawnSync(['true']).pid
    const record = JSON.parse(readFileSync(ownRecord, 'utf8'))
    writeFileSync(
      join(configDir, `freebuff-live-${deadPid}.json`),
      JSON.stringify({ ...record, ownerPid: deadPid }),
    )
    rmSync(ownRecord)
    useFreebuffSessionStore.setState({ slotKeptForRelaunch: true })
    close!()
    close = undefined
    expect(requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)

    try {
      useFreebuffSessionStore.getState().setSession(null)
      useFreebuffSessionStore.setState({ slotKeptForRelaunch: false })
      await mount('active')
      expect(cli.getFreebuffInstanceId()).toBe(original)
      expect(purchases).toBe(1)
      expect(rows.has('desktop-sibling')).toBe(true)
      // Resumed exactly once: the dead record is gone, this process holds it now.
      expect(existsSync(join(configDir, `freebuff-live-${deadPid}.json`))).toBe(
        false,
      )
      await until(() => existsSync(ownRecord))
    } finally {
      useFreebuffSessionStore.setState({ slotKeptForRelaunch: false })
    }
  })

  test('an explicit end leaves nothing for a later launch to resume', async () => {
    await mount()
    await cli.startFreebuffSession(FREEBUFF_MIMO_V25_MODEL_ID)
    const ownRecord = join(configDir, `freebuff-live-${process.pid}.json`)
    await until(() => existsSync(ownRecord))
    await cli.returnToFreebuffLanding()
    expect(existsSync(ownRecord)).toBe(false)
  })

  test('an ambiguous POST retries the same purchase identity', async () => {
    await mount()
    losePostResponse = true
    await cli.startFreebuffSession(FREEBUFF_MIMO_V25_MODEL_ID)
    expect(useFreebuffSessionStore.getState().failure?.outcomeUnknown).toBe(
      true,
    )
    const firstId = [...rows.keys()][0]
    await cli.startFreebuffSession(FREEBUFF_MIMO_V25_MODEL_ID)
    expect(cli.getFreebuffInstanceId()).toBe(firstId)
    expect(purchases).toBe(1)
  })

  test('changing models after a lost POST ends that exact attempt before purchasing', async () => {
    await mount()
    losePostResponse = true
    await cli.startFreebuffSession(FREEBUFF_MIMO_V25_MODEL_ID)
    const firstId = [...rows.keys()][0]!
    await cli.startFreebuffSession(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)
    expect(rows.has(firstId)).toBe(false)
    expect(rows.size).toBe(1)
    expect(cli.getFreebuffInstanceId()).not.toBe(firstId)
    expect(
      requests
        .filter((r) => r.method === 'DELETE')[0]
        ?.headers.get('x-freebuff-instance-id'),
    ).toBe(firstId)
  })

  test('capacity preserves the holder until the user explicitly confirms takeover', async () => {
    tier = 'limited'
    capacity = 1
    rows.set('desktop-sibling', active('desktop-sibling'))
    await mount()
    await cli.startFreebuffSession(FREEBUFF_MIMO_V25_MODEL_ID)
    expect(useFreebuffSessionStore.getState().session).toMatchObject({
      status: 'takeover_prompt',
      currentInstanceId: 'desktop-sibling',
    })
    expect(purchases).toBe(0)
    expect(rows.has('desktop-sibling')).toBe(true)
    await cli.takeOverFreebuffSession()
    expect(useFreebuffSessionStore.getState().session?.status).toBe('active')
    expect(rows.has('desktop-sibling')).toBe(false)
    expect(
      requests.at(-1)?.headers.get('x-freebuff-takeover-instance-id'),
    ).toBe('desktop-sibling')
  })

  test('failed end keeps its identity for retry and cannot close a new purchase', async () => {
    await mount()
    await cli.startFreebuffSession(FREEBUFF_MIMO_V25_MODEL_ID)
    const first = cli.getFreebuffInstanceId()!
    loseDeleteResponse = true
    await expect(cli.returnToFreebuffLanding()).rejects.toThrow('response lost')
    expect(cli.getFreebuffInstanceId()).toBe(first)
    await cli.returnToFreebuffLanding()
    await cli.startFreebuffSession(FREEBUFF_MIMO_V25_MODEL_ID)
    expect(cli.getFreebuffInstanceId()).not.toBe(first)
    expect(rows.size).toBe(1)
  })

  test('unmount cancels an unacknowledged purchase without touching a sibling', async () => {
    rows.set('desktop-sibling', active('desktop-sibling'))
    await mount()
    losePostResponse = true
    await cli.startFreebuffSession(FREEBUFF_MIMO_V25_MODEL_ID)
    close!()
    close = undefined
    await until(() => rows.size === 1)
    expect(rows.has('desktop-sibling')).toBe(true)
  })

  test('clean exit cancels an unacknowledged purchase before the hook unmounts', async () => {
    await mount()
    losePostResponse = true
    await cli.startFreebuffSession(FREEBUFF_MIMO_V25_MODEL_ID)
    expect(rows.size).toBe(1)
    await useFreebuffSessionStore.getState().releaseSlot()
    expect(rows.size).toBe(0)
    expect(useFreebuffSessionStore.getState().pendingAdmission).toBeNull()
  })

  test('a missing/expired session rejoins on a fresh claim after retiring the old attempt', async () => {
    await mount()
    await cli.startFreebuffSession(FREEBUFF_MIMO_V25_MODEL_ID)
    const first = cli.getFreebuffInstanceId()!
    rows.delete(first)
    cli.markFreebuffSessionEnded()
    await cli.refreshFreebuffSession()
    expect(cli.getFreebuffInstanceId()).not.toBe(first)
    expect(rows.size).toBe(1)
    expect(purchases).toBe(2)
  })
}
