import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import { MultilineInput } from '../multiline-input'
import { initializeThemeStore } from '../../hooks/use-theme'
import { resetReturnKeySeenForTests } from '../../utils/terminal-enter-detection'

/**
 * A terminal without bracketed paste (a phone keyboard's clipboard, some web
 * terminals) types a paste out as keys, its line breaks as Return, and
 * OpenTUI hands every key of one stdin read to the composer before React
 * re-renders. Submitting on each of those Returns sent the same draft once
 * per pasted line: 2026-11-11, one person's paste became ~400 queued copies
 * of one prompt, each refused as `scripted`.
 */

beforeAll(() => initializeThemeStore())

let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
  resetReturnKeySeenForTests()
})

async function mountComposer(initial = '') {
  const submitted: string[] = []
  // The draft as a store holds it: written synchronously on every change, so
  // a submit reads what the composer holds now, as chat.tsx's handleSubmit
  // reads useChatStore.
  let live = initial
  const Host = () => {
    const [draft, setDraft] = React.useState({
      text: initial,
      cursor: initial.length,
    })
    return (
      <MultilineInput
        value={draft.text}
        cursorPosition={draft.cursor}
        onChange={({ text, cursorPosition }) => {
          live = text
          setDraft({ text, cursor: cursorPosition })
        }}
        onSubmit={() => {
          submitted.push(live)
          live = ''
          setDraft({ text: '', cursor: 0 })
        }}
        onPaste={() => {}}
        focused
      />
    )
  }
  // No kitty keyboard: a legacy terminal sends Return as a bare "\r".
  const setup = await createTestRenderer({ width: 60, height: 8 })
  const root = createRoot(setup.renderer)
  flushSync(() => root.render(<Host />))
  cleanup = () => {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }
  const settle = async () => {
    await setup.renderOnce()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await setup.renderOnce()
  }
  await settle()
  return {
    submitted,
    draft: () => live,
    /** One stdin read: every key in `raw` arrives before a render. */
    async read(raw: string) {
      setup.renderer.stdin.emit('data', Buffer.from(raw))
      await settle()
    },
    async typeThenEnter(text: string) {
      await setup.mockInput.typeText(text)
      await settle()
      setup.mockInput.pressEnter()
      await settle()
    },
  }
}

describe('MultilineInput: Returns that arrive together', () => {
  test('a typed-out multi-line paste is one draft with its line breaks, not a submit per line', async () => {
    const composer = await mountComposer('please check this log:')
    await composer.read('\rerror one\rerror two\rerror three')
    expect(composer.submitted).toEqual([])
    expect(composer.draft()).toBe(
      'please check this log:\nerror one\nerror two\nerror three',
    )
  })

  test('a typed-out paste that ends in Return is submitted once, whole', async () => {
    const composer = await mountComposer('please check this log:')
    await composer.read('\rerror one\rerror two\r')
    expect(composer.submitted).toEqual([
      'please check this log:\nerror one\nerror two',
    ])
    expect(composer.draft()).toBe('')
  })

  test('a burst of Returns in one read submits the draft once', async () => {
    const composer = await mountComposer('Bitte prüfe die Datei')
    await composer.read('\r'.repeat(30))
    expect(composer.submitted).toHaveLength(1)
    expect(composer.submitted[0]!.trim()).toBe('Bitte prüfe die Datei')
    // The next read's Returns find the draft already sent and cleared.
    await composer.read('\r'.repeat(5))
    expect(
      composer.submitted.filter((text) => text.trim().length > 0),
    ).toHaveLength(1)
  })

  test('Return in a read of its own submits, once per press', async () => {
    const composer = await mountComposer()
    await composer.typeThenEnter('first')
    await composer.typeThenEnter('second')
    expect(composer.submitted).toEqual(['first', 'second'])
  })

  test.each([
    { name: 'a terminal that sends \\r for Enter', returnSeen: true },
    { name: 'a terminal that sends \\n for Enter', returnSeen: false },
  ])(
    'line feeds of a typed-out paste are kept ($name)',
    async ({ returnSeen }) => {
      resetReturnKeySeenForTests(returnSeen)
      const composer = await mountComposer()
      await composer.read('line one\nline two\nline three')
      expect(composer.submitted).toEqual([])
      expect(composer.draft()).toBe('line one\nline two\nline three')
    },
  )
})
