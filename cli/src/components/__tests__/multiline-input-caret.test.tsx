import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import { initializeThemeStore } from '../../hooks/use-theme'
import { MultilineInput } from '../multiline-input'

let cleanupRenderer: (() => void) | undefined

beforeAll(() => {
  initializeThemeStore()
})

afterEach(() => {
  cleanupRenderer?.()
  cleanupRenderer = undefined
})

const input = (cursorPosition: number, value: string, focused: boolean) => (
  <MultilineInput
    value={value}
    cursorPosition={cursorPosition}
    onChange={() => {}}
    onSubmit={() => {}}
    onPaste={() => {}}
    focused={focused}
    shouldBlinkCursor={false}
  />
)

/**
 * Mounts the real input and reports where the *terminal's* cursor ended up:
 * that position, not anything drawn by the component, is what an IME anchors
 * its candidate window to (#1128).
 */
const mountInput = async ({
  value,
  cursorPosition,
  focused = true,
}: {
  value: string
  cursorPosition: number
  focused?: boolean
}) => {
  const setup = await createTestRenderer({ width: 60, height: 12 })
  const root = createRoot(setup.renderer)
  cleanupRenderer = () => {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }

  const paint = async (position: number) => {
    flushSync(() => {
      root.render(input(position, value, focused))
    })
    // The component publishes the caret from a frame callback, so the state for
    // this render lands on the frame *after* the commit — give it two.
    await setup.renderOnce()
    await setup.renderOnce()
    return setup.renderer.getCursorState()
  }

  return {
    caretAt: paint,
    cursor: () => setup.renderer.getCursorState(),
    frame: () => setup.captureCharFrame(),
    first: await paint(cursorPosition),
  }
}

describe('MultilineInput - the terminal cursor sits on the caret', () => {
  test('draws no caret of its own', async () => {
    const field = await mountInput({ value: 'hello', cursorPosition: 5 })

    // A drawn glyph would sit next to the real cursor and show two carets.
    expect(field.frame()).not.toContain('▍')
    expect(field.frame()).toContain('hello')
  })

  test('shows the terminal cursor while focused', async () => {
    const field = await mountInput({ value: 'hello', cursorPosition: 0 })

    expect(field.first.visible).toBe(true)
  })

  test('hides the terminal cursor when the input is not focused', async () => {
    const field = await mountInput({
      value: 'hello',
      cursorPosition: 3,
      focused: false,
    })

    expect(field.first.visible).toBe(false)
  })

  test('advances one column per character', async () => {
    const field = await mountInput({ value: 'hello', cursorPosition: 0 })

    const third = await field.caretAt(3)

    expect(third.x - field.first.x).toBe(3)
    expect(third.y).toBe(field.first.y)
  })

  test('counts a CJK glyph as two columns', async () => {
    const field = await mountInput({ value: '你好', cursorPosition: 0 })

    const afterFirst = await field.caretAt(1)
    const afterSecond = await field.caretAt(2)

    // 你 is two cells wide, so the caret must move two columns, not one.
    expect(afterFirst.x - field.first.x).toBe(2)
    expect(afterSecond.x - afterFirst.x).toBe(2)
  })

  test('expands a tab to four columns', async () => {
    const field = await mountInput({ value: '\tx', cursorPosition: 0 })

    const afterTab = await field.caretAt(1)

    expect(afterTab.x - field.first.x).toBe(4)
  })

  test('keeps the caret on the line it is on', async () => {
    const field = await mountInput({ value: 'one\ntwo', cursorPosition: 4 })

    const laterOnSameLine = await field.caretAt(6)

    expect(field.first.visible).toBe(true)
    expect(laterOnSameLine.y).toBe(field.first.y)
    expect(laterOnSameLine.x - field.first.x).toBe(2)
  })

  test('hides the caret when its line is scrolled out of view', async () => {
    // The first line sits above the visible box, so there is no cell to use.
    const field = await mountInput({ value: 'one\ntwo', cursorPosition: 0 })

    expect(field.first.visible).toBe(false)

    const visibleLine = await field.caretAt(4)

    expect(visibleLine.visible).toBe(true)
  })
})
