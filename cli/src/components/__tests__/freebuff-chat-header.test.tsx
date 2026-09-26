import { afterEach, beforeAll, expect, test, spyOn } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { freebucksFixture } from '@codebuff/common/testing/freebuff'
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
    expect(frame).toContain('25/25 Freebucks remaining')
    expect(frame).not.toContain('/history')
    expect(frame).not.toContain('/dashboard')
    expect(frame.split('\n')[0]!.trimStart()).toStartWith('███████')
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
