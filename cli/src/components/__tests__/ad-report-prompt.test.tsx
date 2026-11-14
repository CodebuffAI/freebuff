import { beforeAll, afterEach, describe, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'
import type { AdReport } from '@codebuff/common/ads/ad-report'

import { AdReportButton } from '../ad-report-button'
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

async function mount(
  send: (ad: AdReport) => Promise<void>,
  getAccount: () => string | null = () => null,
) {
  const registry = createAdReportRegistry(send, getAccount)
  let draft = 'My coding task'
  let chatSubmits = 0
  let rotate!: () => void
  const Host = () => {
    const [ad, setAd] = React.useState(AD)
    const prompt = useAdReportPrompt(registry)
    rotate = () =>
      setAd({ ...AD, title: 'Rotated advertiser', impUrl: 'rotated' })
    return (
      <box flexDirection="column">
        <AdReportButton ad={ad} registry={registry} />
        {prompt ? (
          <AdReportPrompt
            key={prompt.entry.id}
            prompt={prompt}
            registry={registry}
          />
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
    rotate: () => flushSync(() => rotate()),
    draft: () => draft,
    chatSubmits: () => chatSubmits,
    async key(action: (input: typeof setup.mockInput) => unknown) {
      await action(setup.mockInput)
      await settle()
    },
  }
}

describe('the CLI report explanation form', () => {
  test('an account boundary discards the private draft and refreshes mounted report controls', async () => {
    let account = 'first-account'
    const sent: AdReport[] = []
    const view = await mount(
      async (ad) => {
        sent.push(ad)
      },
      () => account,
    )
    await view.click('[Report 1]')
    await view.key((input) => input.pasteBracketedText(REASON))
    account = 'second-account'
    view.registry.syncAccount()
    await view.settle()
    expect(view.registry.getPrompt()).toBeNull()
    expect(view.frame()).not.toContain(REASON)
    expect(view.draft()).toBe('My coding task')
    expect(view.chatSubmits()).toBe(0)
    expect(sent).toEqual([])
    expect(await view.registry.command('1')).toContain('Ad not found')
    await view.click('[Report 2]')
    expect(view.frame()).toContain('0/2000 characters')
    await view.click('[Submit report]')
    expect(sent).toEqual([])
  })

  test('opening, invalid submission, and cancellation never send or edit the chat draft', async () => {
    const sent: AdReport[] = []
    const view = await mount(async (ad) => {
      sent.push(ad)
    })
    await view.click('[Report 1]')
    expect(view.frame()).toContain('Report ad 1: Original advertiser')
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

  test('numbered command selects the saved ad and keyboard submit sends trimmed explanation only', async () => {
    const sent: AdReport[] = []
    const view = await mount(async (ad) => {
      sent.push(ad)
    })
    view.rotate()
    await view.settle()
    expect(await view.registry.command('1')).toBeNull()
    await view.settle()
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

  test('failure preserves typed text and the original snapshot through retry, duplicate clicks, and rotation', async () => {
    const sent: AdReport[] = []
    let finish!: () => void
    const view = await mount(async (ad) => {
      sent.push(ad)
      if (sent.length === 1) throw new Error('offline')
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    })
    await view.click('[Report 1]')
    await view.key((input) => input.pasteBracketedText(REASON))
    await view.click('[Submit report]')
    expect(view.frame()).toContain('Could not send the report')
    expect(view.frame()).toContain(REASON)
    view.rotate()
    await view.settle()
    expect(view.frame()).toContain('Report ad 1: Original advertiser')
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
    expect(view.frame()).toContain('[Report 2]')
  })

  test('oversized explanations stay visible for correction; Escape cancels without sending', async () => {
    const sent: AdReport[] = []
    const view = await mount(async (ad) => {
      sent.push(ad)
    })
    await view.click('[Report 1]')
    await view.key((input) => input.pasteBracketedText('x'.repeat(2001)))
    await view.key((input) => input.pressKey('s', { ctrl: true }))
    expect(view.frame()).toContain('2001/2000 characters')
    expect(sent).toEqual([])
    await view.key((input) => input.pressEscape())
    expect(view.registry.getPrompt()).toBeNull()
  })
})
