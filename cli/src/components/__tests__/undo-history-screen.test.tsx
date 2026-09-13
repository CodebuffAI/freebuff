import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import type { UndoRecord } from '../../state/undo-store'

const record = (id: string, day: number): UndoRecord => ({
  id,
  chatId: 'picker-chat',
  hashBefore: `hash-${id}`,
  files: [`src/${id}.ts`, 'src/shared.ts'],
  message: `prompt ${id}`,
  createdAt: new Date(Date.UTC(2026, 0, day, 12)).toISOString(),
})

/** Oldest turn first, the way the journal lists them. */
const THREE = [record('one', 1), record('two', 2), record('three', 3)]

let undoStack: UndoRecord[] = THREE
let redoStack: UndoRecord[] = []

// The journal is not what this file is about: the picker gets a stack with a
// known shape and the assertions are about what it says over it.
mock.module('../../state/undo-store', () => ({
  listUndoEntries: () => undoStack,
  listRedoEntries: () => redoStack,
}))

import { UndoHistoryScreen } from '../undo-history-screen'
import { initializeThemeStore } from '../../hooks/use-theme'

let cleanupRenderer: (() => void) | undefined

beforeAll(() => {
  initializeThemeStore()
})

afterEach(() => {
  cleanupRenderer?.()
  cleanupRenderer = undefined
  undoStack = THREE
  redoStack = []
})

const mountPicker = async (mode: 'undo' | 'redo' = 'undo') => {
  const setup = await createTestRenderer({
    width: 100,
    height: 40,
    kittyKeyboard: true,
  })
  const root = createRoot(setup.renderer)
  cleanupRenderer = () => {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }

  const selections: string[] = []
  flushSync(() =>
    root.render(
      <UndoHistoryScreen
        mode={mode}
        onSelect={(recordId) => selections.push(recordId)}
        onCancel={() => {}}
      />,
    ),
  )
  await setup.renderOnce()

  /** Input is delivered on the render loop and committed by React's
   *  scheduler, so both have to drain before the next keypress. */
  const settle = async () => {
    await setup.renderOnce()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await setup.renderOnce()
  }

  return Object.assign(setup, {
    selections: () => selections,
    async press(act: () => void) {
      act()
      await settle()
    },
  })
}

describe('UndoHistoryScreen blast radius', () => {
  test('lists the files of every turn the undo takes with it', async () => {
    const picker = await mountPicker()

    // The newest entry takes nothing with it.
    expect(picker.captureCharFrame()).toContain('Files (2)')

    await picker.press(() => picker.mockInput.pressArrow('down'))
    await picker.press(() => picker.mockInput.pressArrow('down'))

    // The oldest one reverts all three turns, and shared.ts is listed once.
    const frame = picker.captureCharFrame()
    expect(frame).toContain('Files (4)')
    expect(frame).toContain('src/two.ts')
    expect(frame).toContain('src/shared.ts')
  })

  test('stays quiet on the newest turn, which takes nothing with it', async () => {
    const picker = await mountPicker()

    const frame = picker.captureCharFrame()
    expect(frame).toContain('Select a change to undo')
    expect(frame).not.toContain('Also reverts')
  })

  test('says how many newer turns an undo also reverts', async () => {
    const picker = await mountPicker()

    await picker.press(() => picker.mockInput.pressArrow('down'))
    expect(picker.captureCharFrame()).toContain('Also reverts 1 newer change')

    await picker.press(() => picker.mockInput.pressArrow('down'))
    expect(picker.captureCharFrame()).toContain('Also reverts 2 newer changes')
  })

  test('says nothing about changes when the stack has one entry', async () => {
    undoStack = [record('only', 1)]
    const picker = await mountPicker()

    expect(picker.captureCharFrame()).not.toContain('Also reverts')
  })

  test('warns that a redo discards the newer redo actions', async () => {
    redoStack = THREE
    const picker = await mountPicker('redo')

    await picker.press(() => picker.mockInput.pressArrow('down'))
    await picker.press(() => picker.mockInput.pressArrow('down'))

    expect(picker.captureCharFrame()).toContain('Also discards 2 newer redos')
  })
})
