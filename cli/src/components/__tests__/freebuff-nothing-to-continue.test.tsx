import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import {
  FreebuffNothingToContinueNotice,
  NOTHING_TO_CONTINUE_MESSAGE,
  shouldShowContinueNotice,
} from '../freebuff-landing-screen'
import { initializeThemeStore } from '../../hooks/use-theme'

import type { FreebuffSessionResponse } from '../../types/freebuff-session'

const ACTIVE_SESSION = {
  status: 'active',
  accessTier: 'full',
  instanceId: 'i-1',
  model: 'model',
  admittedAt: '2026-01-01T00:00:00Z',
  expiresAt: '2026-01-01T01:00:00Z',
  remainingMs: 3_600_000,
} satisfies FreebuffSessionResponse

let cleanupRenderer: (() => void) | undefined

beforeAll(() => {
  initializeThemeStore()
})

afterEach(() => {
  cleanupRenderer?.()
  cleanupRenderer = undefined
})

const renderNotice = async () => {
  const setup = await createTestRenderer({ width: 100, height: 3 })
  const root = createRoot(setup.renderer)
  cleanupRenderer = () => {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }
  flushSync(() => root.render(<FreebuffNothingToContinueNotice />))
  await setup.renderOnce()
  return setup
}

describe('FreebuffNothingToContinueNotice', () => {
  test('tells the user there is nothing to continue', async () => {
    const setup = await renderNotice()
    const frame = setup.captureCharFrame().replace(/\s+/g, ' ')

    expect(frame).toContain('nothing to continue')
    expect(frame).toContain('no active session was found')
  })

  test('mentions starting a new session as the way forward', async () => {
    const setup = await renderNotice()

    expect(setup.captureCharFrame()).toContain('Pick a model below to start')
  })

  test('wraps the message on a narrow terminal rather than clipping it', async () => {
    const setup = await createTestRenderer({ width: 40, height: 4 })
    const root = createRoot(setup.renderer)
    cleanupRenderer = () => {
      flushSync(() => root.unmount())
      setup.renderer.destroy()
    }
    flushSync(() => root.render(<FreebuffNothingToContinueNotice />))
    await setup.renderOnce()

    const frame = setup.captureCharFrame().replace(/\s+/g, ' ')
    expect(frame).toContain(NOTHING_TO_CONTINUE_MESSAGE.replace(/\s+/g, ' '))
  })
})

describe('shouldShowContinueNotice', () => {
  test('only ever shows on a `status: none` session', () => {
    expect(shouldShowContinueNotice(true, { status: 'none' })).toBe(true)

    const resumed: FreebuffSessionResponse[] = [
      ACTIVE_SESSION,
      { status: 'takeover_prompt', model: 'model' },
      { status: 'ended', freebucksRefund: 4 },
      { status: 'superseded' },
      { status: 'consent_required', walletConsent: { price: 1, walletSpend: 1 }, freebucks: null },
    ]
    for (const session of resumed) {
      expect(shouldShowContinueNotice(true, session)).toBe(false)
    }
  })

  test('still probing (null session) never shows the notice', () => {
    expect(shouldShowContinueNotice(true, null)).toBe(false)
  })

  test('without the `-c` / `--continue` flag nothing renders', () => {
    expect(shouldShowContinueNotice(false, { status: 'none' })).toBe(false)
    expect(shouldShowContinueNotice(false, ACTIVE_SESSION)).toBe(false)
  })
})
