import { beforeAll, describe, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import { TerminalCommandDisplay } from '../terminal-command-display'
import { initializeThemeStore } from '../../hooks/use-theme'

beforeAll(() => {
  initializeThemeStore()
})

describe('TerminalCommandDisplay', () => {
  test('renders short output without truncation or show more button', async () => {
    const setup = await createTestRenderer({ width: 80, height: 10 })
    const root = createRoot(setup.renderer)

    flushSync(() => {
      root.render(
        <TerminalCommandDisplay
          command="ls"
          output="file1.txt\nfile2.txt"
          expandable={true}
          maxVisibleLines={5}
        />,
      )
    })

    try {
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain('$ ls')
      expect(frame).toContain('file1.txt')
      expect(frame).toContain('file2.txt')
      expect(frame).not.toContain('Show')
    } finally {
      flushSync(() => root.unmount())
      setup.renderer.destroy()
    }
  })

  test('truncates output exceeding maxVisibleLines and displays show more button', async () => {
    const setup = await createTestRenderer({ width: 80, height: 15 })
    const root = createRoot(setup.renderer)

    const manyLines = Array.from(
      { length: 20 },
      (_, i) => `log line ${i + 1}`,
    ).join('\n')

    flushSync(() => {
      root.render(
        <TerminalCommandDisplay
          command="cat logs.txt"
          output={manyLines}
          expandable={true}
          maxVisibleLines={5}
        />,
      )
    })

    try {
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain('$ cat logs.txt')
      expect(frame).toContain('log line 1')
      expect(frame).toContain('log line 5')
      expect(frame).not.toContain('log line 10')
      expect(frame).toContain('Show 15 more lines')
    } finally {
      flushSync(() => root.unmount())
      setup.renderer.destroy()
    }
  })

  test('handles output where a single long line wraps', async () => {
    const setup = await createTestRenderer({ width: 40, height: 15 })
    const root = createRoot(setup.renderer)

    // A single line of 280 chars wraps into 7 visual lines on 40-col terminal
    const longLine = 'a'.repeat(280)

    flushSync(() => {
      root.render(
        <TerminalCommandDisplay
          command="echo long"
          output={longLine}
          expandable={true}
          maxVisibleLines={5}
          availableWidth={40}
        />,
      )
    })

    try {
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain('$ echo long')
      expect(frame).toContain('Show')
    } finally {
      flushSync(() => root.unmount())
      setup.renderer.destroy()
    }
  })

  test('preserves interstitial blank lines in preview and counts them toward maxVisibleLines', async () => {
    const setup = await createTestRenderer({ width: 80, height: 15 })
    const root = createRoot(setup.renderer)

    // 5 visual lines: 'header', '', 'middle', '', 'footer'
    // followed by 2 off-screen lines: 'extra1', 'extra2'
    const output = 'header\n\nmiddle\n\nfooter\nextra1\nextra2'

    flushSync(() => {
      root.render(
        <TerminalCommandDisplay
          command="test"
          output={output}
          expandable={true}
          maxVisibleLines={5}
        />,
      )
    })

    try {
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain('$ test')
      expect(frame).toContain('header')
      expect(frame).toContain('middle')
      expect(frame).toContain('footer')
      expect(frame).not.toContain('extra1')
      expect(frame).not.toContain('extra2')
      expect(frame).toContain('Show 2 more lines')
    } finally {
      flushSync(() => root.unmount())
      setup.renderer.destroy()
    }
  })

  test('counts off-screen blank lines in hiddenLinesCount accurately', async () => {
    const setup = await createTestRenderer({ width: 80, height: 15 })
    const root = createRoot(setup.renderer)

    // 3 visible lines, then 5 off-screen visual lines containing blank lines
    const output = 'line 1\nline 2\nline 3\n\n\nline 6\n\nline 8'

    flushSync(() => {
      root.render(
        <TerminalCommandDisplay
          command="git log"
          output={output}
          expandable={true}
          maxVisibleLines={3}
        />,
      )
    })

    try {
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain('$ git log')
      expect(frame).toContain('line 1')
      expect(frame).toContain('line 3')
      expect(frame).not.toContain('line 6')
      // Total visual lines: 8. Max visible: 3. Hidden: 5.
      expect(frame).toContain('Show 5 more lines')
    } finally {
      flushSync(() => root.unmount())
      setup.renderer.destroy()
    }
  })

  test('accurately counts remaining visual lines when a line wraps across the preview boundary', async () => {
    const setup = await createTestRenderer({ width: 20, height: 15 })
    const root = createRoot(setup.renderer)

    // line 1: 1 visual line
    // line 2: 100 chars on width 20 wraps to 5 visual lines (total visual lines = 6)
    // With maxVisibleLines = 3, line 1 takes 1 and line 2 takes 2. 3 remaining hidden lines.
    const output = 'start\n' + 'a'.repeat(100)

    flushSync(() => {
      root.render(
        <TerminalCommandDisplay
          command="wrap-test"
          output={output}
          expandable={true}
          maxVisibleLines={3}
          availableWidth={20}
        />,
      )
    })

    try {
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain('$ wrap-test')
      expect(frame).toContain('start')
      expect(frame).toContain('Show 3 more lines')
    } finally {
      flushSync(() => root.unmount())
      setup.renderer.destroy()
    }
  })
})
