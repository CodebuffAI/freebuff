import { beforeAll, describe, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import { Thinking } from '../thinking'
import { initializeThemeStore } from '../../hooks/use-theme'

beforeAll(() => {
  initializeThemeStore()
})

describe('Thinking component', () => {
  const content = 'Line 1 of reasoning.\nLine 2 of reasoning.\nLine 3 of reasoning.'

  test('renders in preview state with preview lines', async () => {
    const setup = await createTestRenderer({ width: 80, height: 10 })
    const root = createRoot(setup.renderer)
    flushSync(() => {
      root.render(
        <Thinking
          content={content}
          thinkingCollapseState="preview"
          isThinkingComplete={true}
          onToggle={() => {}}
          availableWidth={80}
        />,
      )
    })

    try {
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain('Thinking')
      expect(frame).toContain('Line')
    } finally {
      flushSync(() => root.unmount())
      setup.renderer.destroy()
    }
  })

  test('renders in hidden state without preview text', async () => {
    const setup = await createTestRenderer({ width: 80, height: 10 })
    const root = createRoot(setup.renderer)
    flushSync(() => {
      root.render(
        <Thinking
          content={content}
          thinkingCollapseState="hidden"
          isThinkingComplete={true}
          onToggle={() => {}}
          availableWidth={80}
        />,
      )
    })

    try {
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain('Thinking')
      expect(frame).toContain('▸')
      expect(frame).not.toContain('Line 1 of reasoning.')
    } finally {
      flushSync(() => root.unmount())
      setup.renderer.destroy()
    }
  })

  test('renders in expanded state with expanded text', async () => {
    const setup = await createTestRenderer({ width: 80, height: 10 })
    const root = createRoot(setup.renderer)
    flushSync(() => {
      root.render(
        <Thinking
          content={content}
          thinkingCollapseState="expanded"
          isThinkingComplete={true}
          onToggle={() => {}}
          availableWidth={80}
        />,
      )
    })

    try {
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain('Thinking')
      expect(frame).toContain('▾')
      expect(frame).toContain('Line 1 of reasoning.')
    } finally {
      flushSync(() => root.unmount())
      setup.renderer.destroy()
    }
  })
})
