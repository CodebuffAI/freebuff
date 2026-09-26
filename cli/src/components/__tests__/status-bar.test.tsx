import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID } from '@codebuff/common/constants/freebuff-model-ids'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import { StatusBar } from '../status-bar'
import { initializeThemeStore } from '../../hooks/use-theme'
import { useChatStore } from '../../state/chat-store'
import { IS_FREEBUFF } from '../../utils/constants'
import { useByokSelectionStore } from '../../utils/byok'
import { getStatusIndicatorState } from '../../utils/status-indicator-state'

import type { FreebuffSessionResponse } from '../../types/freebuff-session'
import type { RunState } from '@codebuff/sdk'

beforeAll(() => {
  initializeThemeStore()
})

let previousByok: ReturnType<typeof useByokSelectionStore.getState>['selected']
beforeEach(() => {
  previousByok = useByokSelectionStore.getState().selected
  useByokSelectionStore.setState({ selected: undefined })
})
afterEach(() => useByokSelectionStore.setState({ selected: previousByok }))

describe('StatusBar', () => {
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
            freebuffSession={null}
            onEndSession={() => {}}
          />,
        )
      })
      await setup.renderOnce()
      flushSync(() => {
        root.render(
          <StatusBar
            timerStartTime={null}
            isAtBottom
            scrollToLatest={() => {}}
            statusIndicatorState={statusIndicatorState}
            freebuffSession={session}
            onEndSession={() => {}}
          />,
        )
      })

      try {
        await setup.renderOnce()
        // Exercise repainting after the progress background is mounted.
        await setup.renderOnce()
        const frame = setup.captureCharFrame()
        // 142,310 of DeepSeek V4 Flash's 1,048,576-token window → 14%.
        expect(frame).toContain('unlimited · 142.3K (14%)')
        expect(frame).not.toContain('DeepSeek')
        expect(frame).not.toContain(' • ')
        expect(frame).toContain('✕ End session')
      } finally {
        flushSync(() => root.unmount())
        setup.renderer.destroy()
        useChatStore.getState().setRunState(null)
      }
    },
  )
})
