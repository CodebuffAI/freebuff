import fs from 'fs'
import os from 'os'
import path from 'path'

import { freebucksFixture } from '@codebuff/common/testing/freebuff'
import {
  FREEBUFF_GLM_V53_FLASH_MODEL_ID,
  FALLBACK_FREEBUFF_MODEL_ID,
} from '@codebuff/common/constants/freebuff-models'
import { afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import * as auth from '../../utils/auth'
import { FreebucksIntroCard, useFreebucksIntro } from '../freebucks-intro-card'
import { FreebuffModelSelector } from '../freebuff-model-selector'
import { initializeThemeStore } from '../../hooks/use-theme'
import { useFreebuffModelStore } from '../../state/freebuff-model-store'
import { useFreebuffSessionStore } from '../../state/freebuff-session-store'

/** Outside DeepSeek's expensive window and inside deployment hours, so every
 *  catalog row is open regardless of the hour CI runs at. */
const FIXED_NOW_MS = Date.UTC(2026, 7, 20, 19, 0, 0)

let cleanupRenderer: (() => void) | undefined
let testConfigDir: string | undefined
let getConfigDirSpy: ReturnType<typeof spyOn> | undefined

beforeAll(() => {
  initializeThemeStore()
})

afterEach(() => {
  cleanupRenderer?.()
  cleanupRenderer = undefined
  getConfigDirSpy?.mockRestore()
  getConfigDirSpy = undefined
  if (testConfigDir) {
    fs.rmSync(testConfigDir, { recursive: true, force: true })
    testConfigDir = undefined
  }
  useFreebuffSessionStore.getState().setSession(null)
  useFreebuffModelStore.getState().setSelectedModel(FALLBACK_FREEBUFF_MODEL_ID)
})

/** The landing screen's arrangement, reduced to the two pieces that share the
 *  keyboard: the intro card above and the picker below. */
const Landing = ({
  startSession,
}: {
  startSession: (model: string) => Promise<void>
}) => {
  const intro = useFreebucksIntro(true)
  return (
    <box style={{ flexDirection: 'column' }}>
      {intro.visible && (
        <FreebucksIntroCard width={72} onDismiss={intro.dismiss} />
      )}
      <FreebuffModelSelector
        maxHeight={40}
        nowMs={FIXED_NOW_MS}
        keyboardSuspended={intro.visible}
        startSession={startSession}
      />
    </box>
  )
}

const renderLanding = async (startSession: (model: string) => Promise<void>) => {
  testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebucks-intro-'))
  getConfigDirSpy = spyOn(auth, 'getConfigDir').mockReturnValue(testConfigDir)
  useFreebuffSessionStore.getState().setSession({
    status: 'none',
    accessTier: 'full',
    freebucks: freebucksFixture(75),
  } as never)
  useFreebuffModelStore
    .getState()
    .setSelectedModel(FREEBUFF_GLM_V53_FLASH_MODEL_ID)

  const setup = await createTestRenderer({ width: 100, height: 40 })
  const root = createRoot(setup.renderer)
  cleanupRenderer = () => {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }
  flushSync(() => root.render(<Landing startSession={startSession} />))
  await setup.renderOnce()
  return setup
}

// The bug this file exists for: the card's "press any key to continue" and the
// picker's "Enter starts a session" were two independent keyboard
// subscriptions, so the dismissal press ALSO committed the focused row — the
// cheapest one, since a metered list is sorted by price. Users reported it as
// "it started a GLM 5.3 session I didn't want to start" (2026-09-08).
test('dismissing the Freebucks intro does not start a session', async () => {
  const requested: string[] = []
  const setup = await renderLanding(async (model) => {
    requested.push(model)
  })
  expect(setup.captureCharFrame()).toContain('Meet Freebucks')

  flushSync(() => setup.mockInput.pressEnter())
  await setup.renderOnce()

  expect(requested).toEqual([])
  expect(setup.captureCharFrame()).not.toContain('Meet Freebucks')

  // And the picker is live again the moment the card is gone: the next Enter
  // is the one the user meant for it.
  flushSync(() => setup.mockInput.pressEnter())
  await setup.renderOnce()
  expect(requested).toEqual([FREEBUFF_GLM_V53_FLASH_MODEL_ID])
})

test('space dismisses the intro without committing a row either', async () => {
  const requested: string[] = []
  const setup = await renderLanding(async (model) => {
    requested.push(model)
  })
  flushSync(() => setup.mockInput.pressKey(' '))
  await setup.renderOnce()
  expect(requested).toEqual([])
  expect(setup.captureCharFrame()).not.toContain('Meet Freebucks')
})
