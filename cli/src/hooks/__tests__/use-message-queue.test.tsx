import { describe, expect, spyOn, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import { logger } from '../../utils/logger'
import { useMessageQueue } from '../use-message-queue'

import type { QueuedMessage } from '../use-message-queue'

describe('useMessageQueue ownership', () => {
  test('a stale send cannot release a newer queue processing lock', async () => {
    const sends: Array<{
      message: QueuedMessage
      resolve: () => void
    }> = []
    const isChainInProgressRef = { current: false }
    const activeAgentStreamsRef = { current: 0 }
    let queue: ReturnType<typeof useMessageQueue> | undefined

    const Harness = () => {
      queue = useMessageQueue(
        (message) =>
          new Promise<void>((resolve) => {
            sends.push({ message, resolve })
          }),
        isChainInProgressRef,
        activeAgentStreamsRef,
      )
      return <text>{queue.isProcessingQueueRef.current ? 'busy' : 'idle'}</text>
    }

    const setup = await createTestRenderer({ width: 20, height: 2 })
    const root = createRoot(setup.renderer)
    flushSync(() => root.render(<Harness />))
    await setup.renderOnce()

    try {
      flushSync(() => queue!.addToQueue('run A'))
      await setup.renderOnce()
      expect(sends.map((send) => send.message.content)).toEqual(['run A'])
      expect(queue!.isProcessingQueueRef.current).toBe(true)

      // Match the active-run abort handler: it releases the public boolean so
      // another queued run can start before run A's promise settles.
      flushSync(() => {
        queue!.isProcessingQueueRef.current = false
        queue!.setCanProcessQueue(true)
        queue!.addToQueue('run B')
      })
      await setup.renderOnce()
      expect(sends.map((send) => send.message.content)).toEqual([
        'run A',
        'run B',
      ])
      expect(queue!.isProcessingQueueRef.current).toBe(true)

      sends[0]!.resolve()
      await Promise.resolve()
      await setup.renderOnce()
      expect(queue!.isProcessingQueueRef.current).toBe(true)

      sends[1]!.resolve()
      await Promise.resolve()
      await setup.renderOnce()
      expect(queue!.isProcessingQueueRef.current).toBe(false)
    } finally {
      flushSync(() => root.unmount())
      setup.renderer.destroy()
    }
  })
})

describe('useMessageQueue watchdog', () => {
  const WATCHDOG_MS = 20

  async function mountQueue(claimsChain: boolean) {
    const sends: Array<() => void> = []
    const isChainInProgressRef = { current: false }
    const activeAgentStreamsRef = { current: 0 }
    let queue: ReturnType<typeof useMessageQueue> | undefined
    const Harness = () => {
      queue = useMessageQueue(
        () =>
          new Promise<void>((resolve) => {
            // A real send claims the chain synchronously and holds it for the
            // whole run -- including an ask_user wait.
            if (claimsChain) isChainInProgressRef.current = true
            sends.push(() => {
              isChainInProgressRef.current = false
              resolve()
            })
          }),
        isChainInProgressRef,
        activeAgentStreamsRef,
        { watchdogTimeoutMs: WATCHDOG_MS },
      )
      return <text>{queue.isProcessingQueueRef.current ? 'busy' : 'idle'}</text>
    }
    const setup = await createTestRenderer({ width: 20, height: 2 })
    const root = createRoot(setup.renderer)
    flushSync(() => root.render(<Harness />))
    await setup.renderOnce()
    return {
      queue: () => queue!,
      sends,
      setup,
      close: () => {
        flushSync(() => root.unmount())
        setup.renderer.destroy()
      },
    }
  }

  test('a queued run that outlives the timeout is not reported or reset as stuck', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    const harness = await mountQueue(true)
    try {
      flushSync(() => harness.queue().addToQueue('first prompt'))
      await harness.setup.renderOnce()
      expect(harness.sends).toHaveLength(1)

      await Bun.sleep(WATCHDOG_MS * 4)
      expect(harness.queue().isProcessingQueueRef.current).toBe(true)
      expect(
        warn.mock.calls.some((call) =>
          String(call[1]).includes('[message-queue] Watchdog'),
        ),
      ).toBe(false)

      harness.sends[0]!()
      await Bun.sleep(0)
      expect(harness.queue().isProcessingQueueRef.current).toBe(false)
    } finally {
      harness.close()
      warn.mockRestore()
    }
  })

  test('a lock held with no run in progress is still reset', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    const harness = await mountQueue(false)
    try {
      flushSync(() => harness.queue().addToQueue('lost dispatch'))
      await harness.setup.renderOnce()
      expect(harness.queue().isProcessingQueueRef.current).toBe(true)

      await Bun.sleep(WATCHDOG_MS * 3)
      expect(harness.queue().isProcessingQueueRef.current).toBe(false)
      expect(
        warn.mock.calls.some((call) =>
          String(call[1]).includes('[message-queue] Watchdog'),
        ),
      ).toBe(true)
    } finally {
      harness.close()
      warn.mockRestore()
    }
  })
})
