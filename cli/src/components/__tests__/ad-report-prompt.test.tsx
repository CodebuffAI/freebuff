import { beforeAll, afterEach, describe, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'
import type { AdReport } from '@codebuff/common/ads/ad-report'

import { AdReportPrompt, useAdReportPrompt } from '../ad-report-prompt'
import { MultilineInput } from '../multiline-input'
import { createAdReportRegistry } from '../../ads/ad-reports'
import { initializeThemeStore } from '../../hooks/use-theme'

beforeAll(() => initializeThemeStore())
let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
})

const AD = {
  title: 'Original advertiser',
  url: 'https://example.com',
  impUrl: 'original-impression',
  surface: 'cli',
}
const REASON = 'This ad makes a misleading claim.'

async function mount(send: (ad: AdReport) => Promise<void>) {
  const registry = createAdReportRegistry()
  let draft = 'My coding task'
  let chatSubmits = 0
  const Host = () => {
    const prompt = useAdReportPrompt(registry)
    return (
      <box flexDirection="column">
        {prompt ? (
          <AdReportPrompt prompt={prompt} registry={registry} />
        ) : (
          <MultilineInput
            value={draft}
            cursorPosition={draft.length}
            onChange={({ text }) => {
              draft = text
            }}
            onSubmit={() => {
              chatSubmits++
            }}
            onPaste={(text) => {
              draft += text ?? ''
            }}
            focused
          />
        )}
      </box>
    )
  }
  const setup = await createTestRenderer({
    width: 90,
    height: 22,
    kittyKeyboard: true,
  })
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
  const click = async (label: string) => {
    const lines = setup.captureCharFrame().split('\n')
    const y = lines.findIndex((line) => line.includes(label))
    expect(y).toBeGreaterThanOrEqual(0)
    await setup.mockMouse.click(lines[y]!.indexOf(label) + 2, y)
    await settle()
  }
  await settle()
  return {
    registry,
    click,
    settle,
    frame: () => setup.captureCharFrame(),
    async open() {
      registry.open(AD, send)
      await settle()
    },
    draft: () => draft,
    chatSubmits: () => chatSubmits,
    async key(action: (input: typeof setup.mockInput) => unknown) {
      await action(setup.mockInput)
      await settle()
    },
  }
}

describe('the CLI report explanation form', () => {
  test('an account change discards the private draft', async () => {
    const sent: AdReport[] = []
    const view = await mount(async (ad) => {
      sent.push(ad)
    })
    await view.open()
    await view.key((input) => input.pasteBracketedText(REASON))
    view.registry.reset()
    await view.settle()
    expect(view.registry.getPrompt()).toBeNull()
    expect(view.frame()).not.toContain(REASON)
    expect(view.draft()).toBe('My coding task')
    expect(view.chatSubmits()).toBe(0)
    expect(sent).toEqual([])
    await view.open()
    expect(view.frame()).toContain('0/2000 characters')
    await view.click('[Submit report]')
    expect(sent).toEqual([])
  })

  test('opening, invalid submission, and cancellation never send or edit the chat draft', async () => {
    const sent: AdReport[] = []
    const view = await mount(async (ad) => {
      sent.push(ad)
    })
    await view.open()
    expect(view.frame()).toContain('Report ad: Original advertiser')
    await view.click('[Submit report]')
    await view.key((input) => input.pasteBracketedText('   short   '))
    await view.key((input) => input.pressKey('s', { ctrl: true }))
    expect(sent).toEqual([])
    expect(view.frame()).toContain('5/2000 characters')
    await view.click('[Cancel]')
    expect(view.registry.getPrompt()).toBeNull()
    expect(view.draft()).toBe('My coding task')
    expect(view.chatSubmits()).toBe(0)
  })

  test('keyboard submit sends the trimmed explanation only', async () => {
    const sent: AdReport[] = []
    const view = await mount(async (ad) => {
      sent.push(ad)
    })
    await view.open()
    await view.key((input) => input.pasteBracketedText(`  ${REASON}  `))
    await view.key((input) => input.pressEnter())
    expect(sent).toEqual([])
    await view.key((input) => input.pressTab())
    await view.key((input) => input.pressEnter())
    expect(sent).toEqual([{ ...AD, reason: REASON }])
    expect(view.registry.getPrompt()).toBeNull()
    expect(view.draft()).toBe('My coding task')
    expect(view.chatSubmits()).toBe(0)
  })

  test('failure preserves typed text through retry and duplicate clicks', async () => {
    const sent: AdReport[] = []
    let finish!: () => void
    const view = await mount(async (ad) => {
      sent.push(ad)
      if (sent.length === 1) throw new Error('offline')
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    })
    await view.open()
    await view.key((input) => input.pasteBracketedText(REASON))
    await view.click('[Submit report]')
    expect(view.frame()).toContain('Could not send the report')
    expect(view.frame()).toContain(REASON)
    await view.click('[Submit report]')
    await view.click('[Sending…]')
    await view.click('[Cancel]')
    expect(view.registry.getPrompt()).not.toBeNull()
    expect(sent).toEqual([
      { ...AD, reason: REASON },
      { ...AD, reason: REASON },
    ])
    finish()
    await view.settle()
    expect(view.registry.getPrompt()).toBeNull()
  })

  test('oversized explanations stay visible for correction; Escape cancels without sending', async () => {
    const sent: AdReport[] = []
    const view = await mount(async (ad) => {
      sent.push(ad)
    })
    await view.open()
    await view.key((input) => input.pasteBracketedText('x'.repeat(2001)))
    await view.key((input) => input.pressKey('s', { ctrl: true }))
    expect(view.frame()).toContain('2001/2000 characters')
    expect(sent).toEqual([])
    await view.key((input) => input.pressEscape())
    expect(view.registry.getPrompt()).toBeNull()
  })
})
