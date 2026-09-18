import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID } from '@codebuff/common/constants/freebuff-model-ids'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import { StatusBar } from '../status-bar'
import { initializeThemeStore } from '../../hooks/use-theme'
import { useChatStore } from '../../state/chat-store'
import { useByokSelectionStore } from '../../utils/byok'
import { IS_FREEBUFF } from '../../utils/constants'
import { getStatusIndicatorState } from '../../utils/status-indicator-state'

import type { FreebuffSessionResponse } from '../../types/freebuff-session'
import type { RunState } from '@codebuff/sdk'

beforeAll(() => {
  initializeThemeStore()
})

describe('StatusBar', () => {
  // The selection store is seeded once from the developer's real settings file,
  // and the config dir carries an environment suffix (`manicode-<env>`), so a
  // saved BYOK connection would win the idle branch and the session readout
  // under test would never render. Reset it so the file is hermetic.
  beforeEach(() => {
    useByokSelectionStore.setState({ selected: undefined })
  })

  test('renders working for the streaming phase', async () => {
    const statusIndicatorState = getStatusIndicatorState({
      statusMessage: null,
      streamStatus: 'streaming',
      nextCtrlCWillExit: false,
      isConnected: true,
    })
    const setup = await createTestRenderer({ width: 80, height: 3 })
    const root = createRoot(setup.renderer)
    flushSync(() => {
      root.render(
        <StatusBar
          timerStartTime={null}
          isAtBottom
          scrollToLatest={() => {}}
          statusIndicatorState={statusIndicatorState}
          freebuffSession={null}
        />,
      )
    })

    try {
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('working...')
    } finally {
      flushSync(() => root.unmount())
      setup.renderer.destroy()
    }
  })

  // The idle session line (and therefore the context readout) only renders in
  // freebuff builds — useFreebuffSessionProgress returns null otherwise.
  test.skipIf(!IS_FREEBUFF)(
    'renders context usage next to the unlimited label',
    async () => {
      const now = Date.now()
      const session = {
        status: 'active',
        accessTier: 'full',
        instanceId: 'test-instance',
        model: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
        admittedAt: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now + 3_600_000).toISOString(),
        remainingMs: 3_600_000,
      } as FreebuffSessionResponse
      useChatStore.getState().setRunState({
        sessionState: {
          mainAgentState: { contextTokenCount: 142_310 },
        },
      } as RunState)

      const statusIndicatorState = getStatusIndicatorState({
        statusMessage: null,
        streamStatus: 'idle',
        nextCtrlCWillExit: false,
        isConnected: true,
      })
      // Wide frame: the right-hand flex column takes half the row, and the
      // left label truncates rather than wraps.
      const setup = await createTestRenderer({ width: 140, height: 3 })
      const root = createRoot(setup.renderer)
      flushSync(() => {
        root.render(
          <StatusBar
            timerStartTime={null}
            isAtBottom
            scrollToLatest={() => {}}
            statusIndicatorState={statusIndicatorState}
            freebuffSession={session}
          />,
        )
      })

      try {
        await setup.renderOnce()
        const frame = setup.captureCharFrame()
        // 142,310 of DeepSeek V4 Flash's 1,048,576-token window → 14%.
        expect(frame).toContain('unlimited · 142.3K (14%)')
      } finally {
        flushSync(() => root.unmount())
        setup.renderer.destroy()
        useChatStore.getState().setRunState(null)
      }
    },
  )

  /** A live session, so the idle branch has a readout to draw. */
  const session = {
    status: 'active',
    accessTier: 'full',
    instanceId: 'test-instance',
    model: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
    admittedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    remainingMs: 3_600_000,
  } as FreebuffSessionResponse

  /** 142,310 of DeepSeek V4 Flash's 1,048,576-token window → 14%. */
  const SESSION_READOUT = 'unlimited · 142.3K (14%)'

  type IndicatorState = ReturnType<typeof getStatusIndicatorState>

  async function renderSessionBar(statusIndicatorState: IndicatorState) {
    useChatStore.getState().setRunState({
      sessionState: { mainAgentState: { contextTokenCount: 142_310 } },
    } as RunState)
    const setup = await createTestRenderer({ width: 140, height: 3 })
    const root = createRoot(setup.renderer)
    flushSync(() => {
      root.render(
        <StatusBar
          timerStartTime={null}
          isAtBottom
          scrollToLatest={() => {}}
          statusIndicatorState={statusIndicatorState}
          freebuffSession={session}
        />,
      )
    })
    await setup.renderOnce()
    return {
      frame: setup.captureCharFrame(),
      cleanup: () => {
        flushSync(() => root.unmount())
        setup.renderer.destroy()
        useChatStore.getState().setRunState(null)
      },
    }
  }

  // The session readout is persistent state, not a status message: a transient
  // indicator sharing the row must not take it away. Each case also asserts the
  // transient is still drawn — the fix separates the two, it does not drop one.
  test.skipIf(!IS_FREEBUFF)(
    'keeps the session readout while a clipboard message is showing',
    async () => {
      const { frame, cleanup } = await renderSessionBar(
        getStatusIndicatorState({
          statusMessage: 'Copied: "hola"',
          streamStatus: 'idle',
          nextCtrlCWillExit: false,
          isConnected: true,
        }),
      )
      try {
        expect(frame).toContain('Copied: "hola"')
        expect(frame).toContain(SESSION_READOUT)
      } finally {
        cleanup()
      }
    },
  )

  test.skipIf(!IS_FREEBUFF)(
    'keeps the session readout while the connection reads connecting',
    async () => {
      const { frame, cleanup } = await renderSessionBar(
        getStatusIndicatorState({
          statusMessage: null,
          streamStatus: 'idle',
          nextCtrlCWillExit: false,
          isConnected: false,
        }),
      )
      try {
        expect(frame).toContain('connecting...')
        expect(frame).toContain(SESSION_READOUT)
      } finally {
        cleanup()
      }
    },
  )

  // ask_user draws the indicator as nothing at all, which used to blank the row
  // outright. The readout needs its own lane to survive that.
  test.skipIf(!IS_FREEBUFF)(
    'keeps the session readout while ask_user pauses the indicator',
    async () => {
      const { frame, cleanup } = await renderSessionBar(
        getStatusIndicatorState({
          statusMessage: null,
          streamStatus: 'idle',
          nextCtrlCWillExit: false,
          isConnected: true,
          isAskUserActive: true,
        }),
      )
      try {
        expect(frame).toContain(SESSION_READOUT)
      } finally {
        cleanup()
      }
    },
  )
})
