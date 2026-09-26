import { beforeAll, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import { HelpBanner } from '../help-banner'
import { initializeThemeStore } from '../../hooks/use-theme'

beforeAll(initializeThemeStore)

test.each([120, 42])('help lays out readable shortcut groups at %s columns', async (width) => {
  const setup = await createTestRenderer({ width, height: 60 })
  const root = createRoot(setup.renderer)
  try {
    flushSync(() => root.render(<HelpBanner />))
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    const headings = frame.split('\n').find((line) => line.includes('Compose'))!
    if (width === 120) {
      expect(headings).toContain('Chat')
      expect(headings).toContain('Conversation')
    }
    expect(frame).toContain('History (empty input)')
    expect(frame).toContain('Export chat')
  } finally {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }
})
