import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import { useChatStore } from '../../state/chat-store'
import { useFreebuffModelStore } from '../../state/freebuff-model-store'
import { useFreebuffSessionStore } from '../../state/freebuff-session-store'
import * as auth from '../../utils/auth'
import { IS_FREEBUFF } from '../../utils/constants'
import { startFreebuffSession, useFreebuffSession } from '../use-freebuff-session'

const GLM = 'z-ai/glm-5.3-flash'
const DEEPSEEK = 'deepseek/deepseek-v4-flash'

/**
 * The deliberate-switch path: a user on one model picks another, the server
 * answers `model_locked`, and the CLI ends the held session before re-claiming.
 *
 * The DELETE it issues MUST carry the held session's instance id. Ending is
 * instance-keyed since the 90%-refund settlement (2026-09-07) — the handler
 * answers 400 `instance_required` without it — and for two days before that
 * release the switch path sent a bare DELETE, so every pick of a second model
 * died with "ending it failed" and reverted to the model already running.
 *
 * The id has to come off the GET rather than from this process's own state:
 * the locked row is frequently a stale one from a CLI that crashed, whose
 * instance this process never saw.
 *
 * Run with: FREEBUFF_MODE=true bun test src/hooks/__tests__/freebuff-model-switch.test.tsx
 */
describe.skipIf(!IS_FREEBUFF)('freebuff model switch', () => {
  let authSpy: ReturnType<typeof spyOn>
  let fetchSpy: ReturnType<typeof spyOn>

  const heldSession = {
    status: 'active' as const,
    accessTier: 'full' as const,
    instanceId: 'held-by-a-crashed-cli',
    model: GLM,
    admittedAt: '2099-09-07T12:00:00Z',
    expiresAt: '2099-09-07T13:00:00Z',
    remainingMs: 300_000,
  }

  beforeEach(() => {
    authSpy = spyOn(auth, 'getAuthTokenDetails').mockReturnValue({
      token: 'test-token',
      source: 'environment',
    })
    useChatStore.getState().reset()
    useFreebuffModelStore.getState().setSelectedModel(GLM)
  })

  afterEach(() => {
    authSpy.mockRestore()
    fetchSpy?.mockRestore()
    useFreebuffSessionStore.getState().setSession(null)
    useFreebuffSessionStore.getState().setFailure(null)
    useChatStore.getState().reset()
  })

  test('ends the held session with its instance id, then switches', async () => {
    const calls: Array<{ method: string; instanceId: string | null }> = []
    let switched: () => void
    const switchedToDeepseek = new Promise<void>((resolve) => {
      switched = resolve
    })

    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      (async (_url: string, init: RequestInit = {}) => {
        const method = (init.method ?? 'GET').toUpperCase()
        const instanceId = new Headers(init.headers).get(
          'x-freebuff-instance-id',
        )
        calls.push({ method, instanceId })

        if (method === 'DELETE') {
          // The whole point of the test: a bare DELETE is what production
          // rejects, so reproduce that rejection rather than accepting it.
          if (!instanceId) {
            return new Response(
              JSON.stringify({ error: 'instance_required' }),
              { status: 400 },
            )
          }
          return Response.json({ status: 'ended', freebucksRefund: 3 })
        }
        if (method === 'GET') {
          return Response.json(heldSession)
        }
        // POST: locked until the held row is gone, then admitted on the pick.
        const ended = calls.some(
          (call) => call.method === 'DELETE' && call.instanceId,
        )
        if (!ended) {
          return new Response(
            JSON.stringify({
              status: 'model_locked',
              currentModel: GLM,
              requestedModel: DEEPSEEK,
              accessTier: 'full',
            }),
            { status: 409 },
          )
        }
        switched()
        return Response.json({ ...heldSession, instanceId: 'new', model: DEEPSEEK })
      }) as unknown as typeof fetch,
    )

    const Harness = () => {
      useFreebuffSession()
      return <text>freebuff</text>
    }
    const setup = await createTestRenderer({ width: 20, height: 2 })
    const root = createRoot(setup.renderer)
    flushSync(() => root.render(<Harness />))
    await setup.renderOnce()

    try {
      await startFreebuffSession(DEEPSEEK)
      // Bounded: a switch that never lands is the regression, and it should
      // report as a failed assertion on the DELETE below rather than as a
      // test-runner timeout with nothing to read.
      await Promise.race([
        switchedToDeepseek,
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ])
    } finally {
      root.unmount()
    }

    const deletes = calls.filter((call) => call.method === 'DELETE')
    expect(deletes).toHaveLength(1)
    expect(deletes[0]!.instanceId).toBe(heldSession.instanceId)

    const chat = JSON.stringify(useChatStore.getState().messages)
    expect(chat).toContain('switched to')
    expect(chat).not.toContain('ending it failed')
  })
})
