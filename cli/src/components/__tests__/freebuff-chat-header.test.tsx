import { afterEach, beforeAll, expect, test, spyOn } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { freebucksFixture } from '@codebuff/common/testing/freebuff'
import { FREEBUCKS_SHARED_DEVICE_NOTE } from '@codebuff/common/util/freebuff-hours'
import { FreebuffChatHeader } from '../freebuff-chat-header'
import { initializeThemeStore } from '../../hooks/use-theme'
import {
  clearReferralCache,
  rememberReferral,
} from '../../utils/freebuff-referral-cache'
import * as auth from '../../utils/auth'

let cleanup: (() => void) | undefined
beforeAll(initializeThemeStore)
afterEach(() => {
  clearReferralCache()
  cleanup?.()
  cleanup = undefined
})

test.each([130, 42])(
  'the launch panel keeps referral controls visible at %s columns',
  async (width) => {
    const token = spyOn(auth, 'getAuthToken').mockReturnValue(undefined)
    const setup = await createTestRenderer({ width, height: 32 })
    const root = createRoot(setup.renderer)
    const queries = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    cleanup = () => {
      flushSync(() => root.unmount())
      queries.clear()
      setup.renderer.destroy()
      token.mockRestore()
    }
    flushSync(() =>
      root.render(
        <QueryClientProvider client={queries}>
          <FreebuffChatHeader
            projectRoot="/tmp/project"
            session={{
              status: 'none',
              accessTier: 'full',
              freebucks: freebucksFixture(25),
              referral: {
                code: 'test-referral',
                referrerName: null,
                qualifiedCount: 1,
                resetAt: '2099-01-01T00:00:00Z',
                githubLinked: true,
              },
            }}
          />
        </QueryClientProvider>,
      ),
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain('Copy invite link')
    expect(frame).toContain('Learn More')
    expect(frame).toContain('5/5 hours remaining')
    expect(frame).not.toContain('/history')
    expect(frame).not.toContain('/dashboard')
    expect(frame.split('\n')[0]!.trim()).toStartWith(
      width === 130 ? '███████' : 'Freebuff',
    )
    expect(frame).not.toContain('─ Freebuff ')
    rememberReferral({
      status: 'none',
      accessTier: 'full',
      referral: {
        code: 'test-referral',
        referrerName: null,
        qualifiedCount: 1,
        resetAt: '2099-01-01T00:00:00Z',
        githubLinked: true,
      },
    })
    flushSync(() =>
      root.render(
        <QueryClientProvider client={queries}>
          <FreebuffChatHeader
            projectRoot="/tmp/project"
            session={{
              status: 'active',
              accessTier: 'full',
              model: 'z-ai/glm-5.3-flash',
              instanceId: 'test',
              admittedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
              remainingMs: 3600000,
              freebucks: freebucksFixture(25),
            }}
          />
        </QueryClientProvider>,
      ),
    )
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain('Copy invite link')
    expect(setup.captureCharFrame()).not.toContain('Learn More')
    clearReferralCache()
    flushSync(() =>
      root.render(
        <QueryClientProvider client={queries}>
          <FreebuffChatHeader projectRoot="/tmp/project" session={null} />
        </QueryClientProvider>,
      ),
    )
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain('Learn More')

    expect(
      frame
        .split('\n')
        .find((line) => line.includes('┌'))
        ?.indexOf('┌'),
    ).toBeLessThan(2)
  },
)

test("the panel reports the ended hour's refund, zero included", async () => {
  // `useFreebuffSession` has published this receipt since #3635 removed the
  // landing screen's refund lines; no surface rendered it, so a user who
  // ended early saw their balance change with nothing to explain it.
  const token = spyOn(auth, 'getAuthToken').mockReturnValue(undefined)
  const setup = await createTestRenderer({ width: 130, height: 32 })
  const root = createRoot(setup.renderer)
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  cleanup = () => {
    flushSync(() => root.unmount())
    queries.clear()
    setup.renderer.destroy()
    token.mockRestore()
  }
  const landing = {
    status: 'none' as const,
    accessTier: 'full' as const,
    freebucks: freebucksFixture(25),
  }
  const show = async (
    receipt: { lastRefund?: number | null; refundPending?: boolean } = {},
  ) => {
    flushSync(() =>
      root.render(
        <QueryClientProvider client={queries}>
          <FreebuffChatHeader
            projectRoot="/tmp/project"
            session={landing}
            {...receipt}
          />
        </QueryClientProvider>,
      ),
    )
    await setup.renderOnce()
    return setup.captureCharFrame()
  }

  // Nothing has ended yet: the panel makes no claim either way.
  expect(await show()).not.toContain('returned')

  // The reported case — an hour that spent its whole price. Silence here is
  // what users read as "the refund was removed".
  expect(await show({ lastRefund: 0 })).toContain('No hours returned')
  expect(await show({ lastRefund: 10 })).toContain('2 hours of balance returned')
  expect(await show({ refundPending: true })).toContain('Refund settling')
  expect(await show({ lastRefund: null })).not.toContain('returned')
})

test("the panel says why the daily pool is smaller than the account's own", async () => {
  // A new account on a device whose other accounts had spent the shared
  // allowance saw only "0/0 hours remaining" and reported it as broken.
  const token = spyOn(auth, 'getAuthToken').mockReturnValue(undefined)
  const setup = await createTestRenderer({ width: 130, height: 32 })
  const root = createRoot(setup.renderer)
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  cleanup = () => {
    flushSync(() => root.unmount())
    queries.clear()
    setup.renderer.destroy()
    token.mockRestore()
  }
  const show = async (note?: string) => {
    const freebucks = freebucksFixture(0)
    freebucks.daily = { ...freebucks.daily, limit: 0, spent: 0, note }
    flushSync(() =>
      root.render(
        <QueryClientProvider client={queries}>
          <FreebuffChatHeader
            projectRoot="/tmp/project"
            session={{ status: 'none', accessTier: 'limited', freebucks }}
          />
        </QueryClientProvider>,
      ),
    )
    await setup.renderOnce()
    return setup.captureCharFrame()
  }

  const shared = await show(FREEBUCKS_SHARED_DEVICE_NOTE)
  expect(shared).toContain('0/0 hours remaining')
  expect(shared).toContain(FREEBUCKS_SHARED_DEVICE_NOTE)
  const lines = shared.split('\n')
  expect(
    lines.findIndex((line) => line.includes(FREEBUCKS_SHARED_DEVICE_NOTE)),
  ).toBe(lines.findIndex((line) => line.includes('hours remaining')) + 1)

  expect(await show()).not.toContain('share one daily allowance')
})
