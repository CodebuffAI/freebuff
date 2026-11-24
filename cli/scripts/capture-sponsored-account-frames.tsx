/**
 * Captures the CLI's sponsored account prompt (`sponsored-account-prompt.tsx`)
 * as text frames, for the agentic flow lab
 * (`landing-lab/src/ads-onboarding/agentic/`), which shows terminal UI as the
 * frames it draws. The offer card's frames are the checked-in snapshot
 * `sponsored-proposal-frames.txt`; this prompt has none, so this writes them.
 *
 *   cd cli && bun scripts/capture-sponsored-account-frames.tsx
 *
 * Fixtures only: no network, no keys. A typed key is drawn as dots.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import { SponsoredAccountPrompt } from '../src/components/sponsored-account-prompt'
import { initializeThemeStore } from '../src/hooks/use-theme'

import type { SponsoredAccountAsk } from '../src/utils/sponsored-account-step'

const OUT = join(
  import.meta.dir,
  '../../landing-lab/src/ads-onboarding/agentic/cli-account-frames.txt',
)

const SIGN_IN: SponsoredAccountAsk = {
  kind: 'signin',
  offerName: 'PostHog',
  url: 'https://posthog.example/signup?bfcid=bfc_1.p.s',
  opened: true,
}
const KEYS: SponsoredAccountAsk = {
  kind: 'credentials',
  offerName: 'PostHog',
  credentials: [
    {
      env: 'POSTHOG_API_KEY',
      label: 'PostHog API key',
      getUrl: 'https://posthog.example/settings/keys',
    },
  ],
  error: null,
}

const CASES: { name: string; ask: SponsoredAccountAsk; typed?: string }[] = [
  { name: 'sign-in question', ask: SIGN_IN },
  {
    name: 'sign-in question, no browser opened',
    ask: { ...SIGN_IN, opened: false },
  },
  { name: 'API key form', ask: KEYS },
  { name: 'API key form, key typed', ask: KEYS, typed: 'phc_0123456789abcdef' },
  {
    name: 'API key form, key refused',
    ask: { ...KEYS, error: 'That key was refused. Check it and try again.' },
  },
]

async function frame(ask: SponsoredAccountAsk, width: number, typed?: string) {
  const setup = await createTestRenderer({ width, height: 16, kittyKeyboard: true })
  const root = createRoot(setup.renderer)
  flushSync(() => {
    root.render(
      <SponsoredAccountPrompt
        ask={ask}
        onAnswer={() => null}
        onInterrupt={() => {}}
        openUrl={() => {}}
      />,
    )
  })
  const settle = async () => {
    await setup.renderOnce()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await setup.renderOnce()
  }
  await settle()
  if (typed) {
    setup.mockInput.pasteBracketedText(typed)
    await settle()
  }
  const text = setup.captureCharFrame().replace(/[ \t]+$/gm, '').trimEnd()
  flushSync(() => root.unmount())
  setup.renderer.destroy()
  return text
}

initializeThemeStore()
const sections: string[] = []
for (const { name, ask, typed } of CASES)
  for (const width of [48, 70])
    sections.push(`=== ${name} @ ${width} ===\n${await frame(ask, width, typed)}`)
writeFileSync(OUT, `${sections.join('\n\n')}\n`)
console.log(`wrote ${sections.length} frames to ${OUT}`)
process.exit(0)
