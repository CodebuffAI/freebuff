import { afterEach, beforeAll, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'

import { initializeThemeStore } from '../../hooks/use-theme'
import { useChatStore } from '../../state/chat-store'
import { TopBanner } from '../top-banner'

beforeAll(initializeThemeStore)
afterEach(() => useChatStore.getState().setActiveTopBanner(null))

test.each([100, 48])(
  'the post-login Discord banner shows the invite and its link at %s columns',
  async (width) => {
    useChatStore.getState().setActiveTopBanner('discord')
    const setup = await createTestRenderer({ width, height: 12 })
    const root = createRoot(setup.renderer)
    try {
      flushSync(() => root.render(<TopBanner />))
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      // word-wrapped at the narrow width, so compare with the borders, the close
      // button's lone "x" and the wrapping whitespace taken out
      const text = frame
        .replace(/[│─╭╮╰╯┌┐└┘]/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/ x /g, ' ')
      expect(text).toContain(
        'Talk directly with our team and 7,000+ community members on Discord:',
      )
      expect(text).toContain('discord.gg/yXG3w7wxfs')
    } finally {
      flushSync(() => root.unmount())
      setup.renderer.destroy()
    }
  },
)
