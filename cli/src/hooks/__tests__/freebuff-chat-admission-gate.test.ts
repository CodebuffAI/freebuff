import {
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_MIMO_V25_MODEL_ID,
} from '@codebuff/common/constants/freebuff-models'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import { describe, expect, test } from 'bun:test'
import React from 'react'

import { useFreebuffChatStore } from '../../state/freebuff-chat-store'
import { useFreebuffModelStore } from '../../state/freebuff-model-store'
import { useFreebuffSessionStore } from '../../state/freebuff-session-store'
import {
  freebuffChatAdmissionMayStart,
  freebuffTurnRunning,
  useFreebuffChatAdmission,
} from '../use-freebuff-chat-admission'

describe('freebuffChatAdmissionMayStart', () => {
  const ready = { turnRunning: false, queuedCount: 1, queuePaused: false }

  test('admits for an idle queue that holds a message', () => {
    expect(freebuffChatAdmissionMayStart(ready)).toBe(true)
  })

  // A paused queue sends nothing, so the hour it bought went unused and was
  // refunded five minutes later.
  test('waits while the user has paused the queue', () => {
    expect(freebuffChatAdmissionMayStart({ ...ready, queuePaused: true })).toBe(
      false,
    )
  })

  test('waits for an empty queue or a running turn', () => {
    expect(freebuffChatAdmissionMayStart({ ...ready, queuedCount: 0 })).toBe(
      false,
    )
    expect(freebuffChatAdmissionMayStart({ ...ready, turnRunning: true })).toBe(
      false,
    )
  })

  test('a running chain or a live stream is a running turn', () => {
    const idle = { chainInProgress: false, streamStatus: 'idle' as const }
    expect(freebuffTurnRunning(idle)).toBe(false)
    expect(freebuffTurnRunning({ ...idle, chainInProgress: true })).toBe(true)
    expect(freebuffTurnRunning({ ...idle, streamStatus: 'streaming' })).toBe(
      true,
    )
  })
})

test('a send before the first session response runs the default it resolved', async () => {
  // The send captured the launch seed (MiMo); the response moved the selection
  // to Flash. `freebucks: null` stops admission at confirm, before the network.
  useFreebuffModelStore.setState({
    hasExplicitPick: false,
    selectedModel: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  })
  useFreebuffSessionStore.getState().setSession({
    status: 'none',
    accessTier: 'full',
    freebucks: null,
  } as never)
  useFreebuffChatStore.setState({
    admission: {
      phase: 'requested',
      model: FREEBUFF_MIMO_V25_MODEL_ID,
      metadataChecked: true,
    },
  })
  const setup = await createTestRenderer({ width: 20, height: 2 })
  const root = createRoot(setup.renderer)
  const Harness = () => {
    useFreebuffChatAdmission(true)
    return React.createElement('text', null, 'x')
  }
  flushSync(() => root.render(React.createElement(Harness)))
  await setup.renderOnce()
  expect(useFreebuffChatStore.getState().admission).toMatchObject({
    phase: 'confirm',
    model: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  })
  flushSync(() => root.unmount())
  setup.renderer.destroy()
})

// Full access is never asked (2026-10-16), not even to end the live session.
test.each([true, false])(
  'a model switch asks only an account the server asks (spendWithoutAsking=%s)',
  async (spendWithoutAsking) => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      Response.json({ status: 'none' })) as unknown as typeof fetch
    useFreebuffModelStore.setState({ hasExplicitPick: true })
    useFreebuffSessionStore.getState().setSession({
      status: 'active',
      accessTier: 'full',
      model: FREEBUFF_MIMO_V25_MODEL_ID,
      instanceId: 'cli',
      admittedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      freebucks: {
        balance: 100,
        daily: { limit: 150, spent: 50, remaining: 100, resetAt: '' },
        wallet: { balance: 0, monthlyBonus: 0 },
        planId: null,
        prices: {
          [FREEBUFF_MIMO_V25_MODEL_ID]: 10,
          [FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID]: 15,
        },
        ...(spendWithoutAsking ? { spendWithoutAsking: true } : {}),
      },
    } as never)
    useFreebuffChatStore.setState({
      admission: {
        phase: 'requested',
        model: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
        metadataChecked: true,
      },
    })
    const setup = await createTestRenderer({ width: 20, height: 2 })
    const root = createRoot(setup.renderer)
    const Harness = () => {
      useFreebuffChatAdmission(true)
      return React.createElement('text', null, 'x')
    }
    try {
      flushSync(() => root.render(React.createElement(Harness)))
      await setup.renderOnce()
      const phase = useFreebuffChatStore.getState().admission?.phase
      if (spendWithoutAsking) expect(phase).not.toBe('confirm')
      else expect(phase).toBe('confirm')
    } finally {
      useFreebuffChatStore.setState({ admission: undefined } as never)
      flushSync(() => root.unmount())
      setup.renderer.destroy()
      globalThis.fetch = realFetch
    }
  },
)
