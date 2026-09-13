import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import {
  FreebuffNothingToContinueNotice,
  NOTHING_TO_CONTINUE_MESSAGE,
} from '../freebuff-landing-screen'
import { initializeThemeStore } from '../../hooks/use-theme'

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
