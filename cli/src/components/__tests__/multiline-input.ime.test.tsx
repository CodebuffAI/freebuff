import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import { MultilineInput } from '../multiline-input'
import { initializeThemeStore } from '../../hooks/use-theme'

import type { InputValue } from '../../types/store'

let cleanupRenderer: (() => void) | undefined

beforeAll(() => {
  initializeThemeStore()
})

afterEach(() => {
  cleanupRenderer?.()
  cleanupRenderer = undefined
})

/**
 * Mounts MultilineInput with controlled state and returns helpers to
 * drive real key events through the component's actual handlers.
 */
async function mountInput(initialValue = '', initialCursor = 0) {
  const changes: InputValue[] = []

  const Harness = () => {
    const [value, setValue] = React.useState(initialValue)
    const [cursorPosition, setCursorPosition] = React.useState(initialCursor)

    const handleChange = React.useCallback((v: InputValue) => {
      changes.push(v)
      setValue(v.text)
      setCursorPosition(v.cursorPosition)
    }, [])

    return (
      <MultilineInput
        value={value}
        cursorPosition={cursorPosition}
        onChange={handleChange}
        onSubmit={() => {}}
        onPaste={() => {}}
        focused
        maxHeight={5}
      />
    )
  }

  const setup = await createTestRenderer({ width: 80, height: 6 })
  const root = createRoot(setup.renderer)
  cleanupRenderer = () => {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }

  flushSync(() => root.render(<Harness />))
  await setup.renderOnce()

  const settle = async () => {
    await setup.renderOnce()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await setup.renderOnce()
  }
  await settle()

  const currentValue = () => {
    const last = changes[changes.length - 1]
    return last ? last.text : initialValue
  }

  return {
    setup,
    changes,
    currentValue,
    async press(act: () => void) {
      act()
      await settle()
    },
    async typeText(text: string) {
      await setup.mockInput.typeText(text)
      await settle()
    },
    async pressBackspace() {
      setup.mockInput.pressBackspace()
      await settle()
    },
    /** Emit multiple key inputs with no delay between them, then settle once. */
    async pressRapid(keys: () => void) {
      keys()
      await settle()
    },
  }
}

describe('MultilineInput IME integration', () => {
  test('typing plain text produces correct onChange output', async () => {
    const input = await mountInput()

    await input.typeText('chao')

    expect(input.currentValue()).toBe('chao')
    expect(input.changes.length).toBeGreaterThan(0)
  })

  test('backspace deletes the last character', async () => {
    const input = await mountInput('chao', 4)

    await input.pressBackspace()

    expect(input.currentValue()).toBe('cha')
  })

  test('typing accented char after backspace produces correct text', async () => {
    const input = await mountInput('cha', 3)

    // IME compose-and-replace: backspace deletes base char, then accented char
    input.setup.mockInput.pressBackspace()
    input.setup.mockInput.typeText('à')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await input.setup.renderOnce()

    expect(input.currentValue()).toBe('chà')
  })

  test('rapid backspace + accented char in one batch produces correct text', async () => {
    const input = await mountInput('cha', 3)

    // Emit backspace and accented char with no delay, settle once.
    // Simulates a single stdin chunk from the IME.
    input.setup.mockInput.pressKeys(['\x7f', 'à'], 0)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await input.setup.renderOnce()

    expect(input.currentValue()).toBe('chà')
  })

  test('full Vietnamese phrase: xin chào', async () => {
    const input = await mountInput()

    await input.typeText('xin cha')

    // IME replaces 'a' with 'à'
    input.setup.mockInput.pressKeys(['\x7f', 'à'], 0)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await input.setup.renderOnce()

    expect(input.currentValue()).toBe('xin chà')

    await input.typeText('o')

    expect(input.currentValue()).toBe('xin chào')
  })
})
