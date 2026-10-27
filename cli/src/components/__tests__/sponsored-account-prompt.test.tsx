/**
 * The account step's prompt (`sponsored-account-prompt.tsx`): the sign-in
 * question and the masked key form, driven by real key presses and a real
 * bracketed paste. The key must never be drawn.
 */
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import React from 'react'

import { SponsoredAccountPrompt } from '../sponsored-account-prompt'
import { initializeThemeStore } from '../../hooks/use-theme'

import { trackedSponsoredCredentials } from '../../utils/sponsored-account-step'

import type {
  SponsoredAccountAnswer,
  SponsoredAccountAsk,
} from '../../utils/sponsored-account-step'

beforeAll(() => initializeThemeStore())

const KEY = 'acme_live_0123456789abcdef'
let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
})

async function mount(
  ask: SponsoredAccountAsk,
  reply: (answer: SponsoredAccountAnswer) => string | null = () => null,
) {
  const answers: SponsoredAccountAnswer[] = []
  const opened: string[] = []
  const interrupts: number[] = []
  const setup = await createTestRenderer({
    width: 70,
    height: 20,
    kittyKeyboard: true,
  })
  const root = createRoot(setup.renderer)
  cleanup = () => {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }
  flushSync(() => {
    root.render(
      <SponsoredAccountPrompt
        ask={ask}
        onAnswer={(answer) => {
          answers.push(answer)
          return reply(answer)
        }}
        onInterrupt={() => interrupts.push(1)}
        openUrl={(url) => opened.push(url)}
      />,
    )
  })
  const settle = async () => {
    await setup.renderOnce()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await setup.renderOnce()
  }
  await settle()
  return {
    answers,
    interrupts,
    opened,
    input: setup.mockInput,
    mouse: setup.mockMouse,
    frame: () => setup.captureCharFrame(),
    async act(fn: () => unknown) {
      await fn()
      await settle()
    },
  }
}

describe('the sign-in question', () => {
  const ask: SponsoredAccountAsk = {
    kind: 'signin',
    offerName: 'Acme',
    url: 'https://acme.example/signup?bfcid=bfc_1.p.s',
    opened: true,
  }

  test('shows the link and the two answers; Enter confirms the first', async () => {
    const prompt = await mount(ask)
    const frame = prompt.frame()
    expect(frame).toContain('acme.example/signup')
    expect(frame).toContain('Yes, I’m signed in')
    expect(frame).toContain('No, I don’t want to sign up')
    await prompt.act(() => prompt.input.pressEnter())
    expect(prompt.answers).toEqual([{ kind: 'signin', confirmed: true }])
  })

  test('down then Enter, and Esc, both say no', async () => {
    const prompt = await mount(ask)
    await prompt.act(() => prompt.input.pressArrow('down'))
    await prompt.act(() => prompt.input.pressEnter())
    await prompt.act(() => prompt.input.pressEscape())
    expect(prompt.answers).toEqual([
      { kind: 'signin', confirmed: false },
      { kind: 'skip' },
    ])
  })
})

describe('the key form', () => {
  const ask: SponsoredAccountAsk = {
    kind: 'credentials',
    offerName: 'Acme',
    credentials: [
      {
        env: 'ACME_API_KEY',
        label: 'Acme API key',
        getUrl: 'https://acme.example/keys',
      },
    ],
    error: null,
  }

  test('a pasted key is submitted but drawn only as dots', async () => {
    const prompt = await mount(ask)
    expect(prompt.frame()).toContain('Acme API key (ACME_API_KEY)')
    await prompt.act(() => prompt.input.pasteBracketedText(KEY))
    expect(prompt.frame()).not.toContain(KEY)
    expect(prompt.frame()).toContain('••••')
    await prompt.act(() => prompt.input.pressEnter())
    expect(prompt.answers).toEqual([
      { kind: 'credentials', values: { ACME_API_KEY: KEY } },
    ])
  })

  test('a typed key, corrected with backspace', async () => {
    const prompt = await mount(ask)
    await prompt.act(() => prompt.input.typeText('abcdefghX'))
    await prompt.act(() => prompt.input.pressBackspace())
    expect(prompt.frame()).not.toContain('abcdefgh')
    await prompt.act(() => prompt.input.pressEnter())
    expect(prompt.answers).toEqual([
      { kind: 'credentials', values: { ACME_API_KEY: 'abcdefgh' } },
    ])
  })

  test('Esc skips the step; Ctrl-C also stops the run', async () => {
    const prompt = await mount(ask)
    await prompt.act(() => prompt.input.pressEscape())
    expect(prompt.answers).toEqual([{ kind: 'skip' }])
    expect(prompt.interrupts).toEqual([])
    await prompt.act(() => prompt.input.pressCtrlC())
    expect(prompt.interrupts).toEqual([1])
  })

  test('a refusal is shown', async () => {
    const prompt = await mount({
      ...ask,
      error: 'That Acme API key looks too short.',
    })
    expect(prompt.frame()).toContain('That Acme API key looks too short.')
  })
})

describe('a key page link with a {bfcid} slot (COD-965)', () => {
  const TOKEN = 'bfc_1.p.s'
  const declared = [
    {
      env: 'ACME_API_KEY',
      label: 'Acme API key',
      getUrl: 'https://acme.example/k?bfcid={bfcid}',
    },
  ]
  const askFor = (advertiserLink: string | null): SponsoredAccountAsk => ({
    kind: 'credentials',
    offerName: 'Acme',
    credentials: trackedSponsoredCredentials(declared, { advertiserLink }),
    error: null,
  })

  test('is shown and opened with the signed click id', async () => {
    const prompt = await mount(askFor(`https://acme.example/?bfcid=${TOKEN}`))
    const lines = prompt.frame().split('\n')
    const y = lines.findIndex((line) => line.includes('acme.example/k'))
    expect(y).toBeGreaterThanOrEqual(0)
    expect(lines[y]).toContain(`bfcid=${TOKEN}`)
    expect(prompt.frame()).not.toContain('{bfcid}')
    await prompt.act(() =>
      prompt.mouse.click(lines[y]!.indexOf('acme.example') + 2, y),
    )
    expect(prompt.opened).toEqual([`https://acme.example/k?bfcid=${TOKEN}`])
  })

  test('without a signed click id, no link and no literal {bfcid}', async () => {
    const prompt = await mount(askFor(null))
    expect(prompt.frame()).toContain('Acme API key (ACME_API_KEY)')
    expect(prompt.frame()).not.toContain('{bfcid}')
    expect(prompt.frame()).not.toContain('acme.example/k')
  })
})
