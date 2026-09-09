/**
 * The CLI's R layer of the sponsored-proposal conformance matrix (COD-376).
 *
 * Rows come from the SHARED fixtures in `@codebuff/common`, not from literals
 * here: the whole claim being tested is that three surfaces render the same
 * bytes, and a fixture written in this file would be the CLI grading its own
 * homework.
 *
 * Three widths, because a terminal is the only surface whose layout can be
 * taken away from it: 60 is a comfortable pane, 48 a split, and 20 is the floor
 * where the "SPONSORED" marker and the advertiser name must both still survive
 * -- body copy goes first, the headline last.
 *
 * TWO CHECKS ARE WAIVED HERE AND THE WAIVERS ARE ASSERTED, not just declared:
 * R-15 (a link) becomes sanitized text, and R-16/R-17 (a logo) becomes the
 * advertiser's name with no request minted. A waiver nobody tests is a gap
 * nobody notices.
 */
import {
  FIXTURE_ADVERTISER_CTA_URL,
  FIXTURE_ADVERTISER_NAME,
  HOSTILE_PR_URLS,
  MALFORMED_LOGO_TOKENS,
  SPONSORED_FIXTURE_STATES,
  SPONSORED_ROW_FIXTURES,
  VALID_LOGO_TOKEN,
} from '@codebuff/common/ads/__fixtures__/sponsored-proposal-rows'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import React from 'react'

import {
  SponsoredProposalBlock,
  hintFor,
  hintMode,
} from '../blocks/sponsored-proposal-block'
import { initializeThemeStore } from '../../hooks/use-theme'
import { setSponsoredCliAvailability } from '../../utils/sponsored-availability'
import { useMessageBlockStore } from '../../state/message-block-store'

import type {
  SponsoredProposalContentBlock,
  ContentBlock,
} from '../../types/chat'
import type { SponsoredProposalRow } from '@codebuff/common/ads/sponsored-proposal-view'

beforeAll(() => {
  initializeThemeStore()
  // PINNED, so every frame below is the same bytes on a Mac, on CI's Linux and
  // on a Windows box. The card's Accept is gated on what the HOST can contain
  // (COD-336 item 3), so a snapshot taken from an unpinned probe records the
  // machine that ran it rather than the card.
  setSponsoredCliAvailability('available')
})

afterAll(() => setSponsoredCliAvailability(null))

const WIDTHS = [20, 48, 60] as const

const blockFor = (
  row: SponsoredProposalRow,
  over: Partial<SponsoredProposalContentBlock> = {},
): SponsoredProposalContentBlock => ({
  type: 'sponsored-proposal',
  target: 'acme/deploys',
  proposal: { ...row, _id: 'proposal-1', advertiser_id: 'adv_acme' },
  ...over,
})

const render = async (
  block: SponsoredProposalContentBlock,
  width: number,
): Promise<string> => {
  const setup = await createTestRenderer({ width, height: 24 })
  const root = createRoot(setup.renderer)
  flushSync(() => {
    root.render(<SponsoredProposalBlock block={block} availableWidth={width} />)
  })
  try {
    await setup.renderOnce()
    return setup.captureCharFrame()
  } finally {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }
}

describe('every state, at every width', () => {
  for (const width of WIDTHS) {
    test(`R-1 / R-19 the disclosure and the advertiser survive at ${width} columns`, async () => {
      for (const state of SPONSORED_FIXTURE_STATES) {
        const frame = await render(
          blockFor(SPONSORED_ROW_FIXTURES[state]),
          width,
        )
        // The two things that may never be dropped: that this is an ad, and
        // whose. At 20 columns everything else is negotiable.
        expect(frame, `${state} at ${width}`).toContain('SPONSORED')
        expect(frame, `${state} at ${width}`).toContain('Acme')
      }
    })
  }

  test('R-3: the Accept exists only where a run can actually be contained', async () => {
    // Phase 2 un-waives R-3, and the property that replaces "there is no
    // Accept" is narrower and more useful: the control tracks the MACHINE.
    // `offered` is the only state with an answer to give, and a card is drawn
    // identically everywhere else.
    setSponsoredCliAvailability('available')
    const acceptable = await render(
      blockFor(SPONSORED_ROW_FIXTURES.offered, { menuOpen: true }),
      60,
    )
    expect(acceptable).toContain('Start sponsored thread')

    // COD-336 item 3, as rendered: on Windows the card SAYS why instead of
    // offering an Accept that cannot work. The reason is the shared copy, so a
    // terminal never writes its own account of the containment story.
    setSponsoredCliAvailability('unavailable:windows-no-containment')
    const refused = await render(
      blockFor(SPONSORED_ROW_FIXTURES.offered, { menuOpen: true }),
      60,
    )
    expect(refused).not.toContain('Start sponsored thread')
    expect(refused).toContain('Windows')

    // And no state but `offered` offers one, on either machine.
    for (const availability of [
      'available',
      'unavailable:windows-no-containment',
    ] as const) {
      setSponsoredCliAvailability(availability)
      for (const state of SPONSORED_FIXTURE_STATES) {
        if (state === 'offered') continue
        for (const width of WIDTHS) {
          const frame = await render(
            blockFor(SPONSORED_ROW_FIXTURES[state], { menuOpen: true }),
            width,
          )
          expect(frame, `${state} at ${width}`).not.toContain(
            'Start sponsored thread',
          )
        }
      }
    }
    setSponsoredCliAvailability('available')
  })

  test('a failed refresh is visible and exposes no stale controls', async () => {
    const frame = await render(
      blockFor(SPONSORED_ROW_FIXTURES.offered, {
        refreshUnavailable: true,
        menuOpen: true,
        consent: CONSENT,
      }),
      60,
    )
    expect(frame).toContain('Could not refresh this proposal')
    expect(frame).not.toContain('Start sponsored thread')
    expect(frame).not.toContain('/ads:accept-proposal')
    expect(frame).not.toContain('> No')
  })

  test('the run never starts from the Accept: it opens a consent that can refuse', async () => {
    // COD-336 item 4, adapted for a surface with no second process to draw a
    // dialog from. The property that has to hold is that the control which
    // says "Start sponsored thread" reaches a SCREEN, and only the screen can
    // approve — so a single keypress can never run an advertiser's procedure.
    setSponsoredCliAvailability('available')
    const calls: string[] = []
    useMessageBlockStore.getState().setCallbacks({
      onSponsoredProposalAccept: (target: string) =>
        calls.push(`accept:${target}`),
      onSponsoredProposalConsent: (target: string, approved: boolean) =>
        calls.push(`consent:${target}:${approved}`),
    } as never)
    const consented = await render(
      blockFor(SPONSORED_ROW_FIXTURES.offered, { consent: CONSENT }),
      60,
    )
    // One sentence and two choices (COD-410): who is asking, that it stays on
    // its own branch, and that nothing is pushed. The field list this used to
    // be -- folder, branch, a paragraph of assurances -- is gone on purpose.
    expect(consented).toContain('Acme Deploys wants to integrate itself into')
    expect(consented).toContain('Nothing is pushed until you')
    expect(consented).not.toContain(CONSENT.branch)
    expect(consented).not.toContain(CONSENT.folder)
    expect(consented).toContain('> No')
    expect(consented).toContain('  Yes')
  })

  test('a hostile advertiser name cannot restyle the sentence or move the choices', async () => {
    // The name is the only advertiser-authored text left on the consent, which makes it the whole
    // attack surface. It goes through the SAME clamp the desktop bridge applies -- bidi overrides
    // and controls escaped rather than dropped, length capped -- so it cannot flip the sentence
    // around it, and it cannot push the two choices off the card.
    const hostile = `\u202eEVIL\u200b${'x'.repeat(4_000)}`
    const out = await render(
      blockFor(SPONSORED_ROW_FIXTURES.offered, {
        consent: { ...CONSENT, advertiserName: hostile },
      }),
      60,
    )
    expect(out).not.toContain('\u202e')
    expect(out).toContain('\\u202e')
    expect(out).toContain('wants to integrate itself into')
    expect(out).toContain('> No')
    expect(out).toContain('  Yes')
  })

  test('a nameless consent states a refusal and offers only the refusal', async () => {
    // Blank is not a legal render: a sentence about nobody asks a human to consent to nothing.
    // Desktop disables Yes; a terminal has no disabled button, so the choice is simply not there.
    const out = await render(
      blockFor(SPONSORED_ROW_FIXTURES.offered, {
        consent: { ...CONSENT, advertiserName: '   ' },
      }),
      60,
    )
    // wrapped, so the assertion is on the words rather than on where the line breaks
    expect(out).toContain('could not say who is asking')
    expect(out).toContain('> No')
    expect(out).not.toContain('Yes')
  })

  test('R-2 every state offers the same one decline, and names it', async () => {
    // The decline is a COMMAND, not a key. The card used to say "esc dismiss",
    // and `useKeyboard` is a global listener -- so that Esc reached the card at
    // the same time as whatever the user was actually cancelling.
    for (const state of SPONSORED_FIXTURE_STATES) {
      expect(
        await render(blockFor(SPONSORED_ROW_FIXTURES[state]), 60),
      ).toContain('/ads:dismiss-proposal')
    }
  })
})

describe('states that carry more than a headline', () => {
  test('R-5 running renders the todo-dock vocabulary and the count', async () => {
    const frame = await render(blockFor(SPONSORED_ROW_FIXTURES.running), 60)
    expect(frame).toContain('1/3')
    expect(frame).toContain('In progress')
    expect(frame).toContain('Wire the deploy hook')
  })

  test('R-7 / R-8 / R-10 committed names the branch and claims no PR', async () => {
    const frame = await render(blockFor(SPONSORED_ROW_FIXTURES.committed), 60)
    expect(frame).toContain('sponsored/acme-deploys')
    expect(frame).toContain('Nothing was pushed')
    expect(frame).not.toContain('http')
  })

  test('R-8 an absent branch drops the clause rather than guessing one', async () => {
    const frame = await render(
      blockFor({ ...SPONSORED_ROW_FIXTURES.committed, branch: undefined }),
      60,
    )
    expect(frame).toContain('its own branch')
    expect(frame).not.toContain('sponsored/acme-deploys')
  })

  test('R-12 failed shows the reason', async () => {
    expect(await render(blockFor(SPONSORED_ROW_FIXTURES.failed), 60)).toContain(
      'Budget exceeded',
    )
  })
})

describe('the advertiser CTA (COD-512)', () => {
  test('a settled CTA is printed as sanitized text under the neutral label', async () => {
    const frame = await render(
      blockFor({
        ...SPONSORED_ROW_FIXTURES.committed,
        advertiser_cta_url: FIXTURE_ADVERTISER_CTA_URL,
      }),
      120,
    )
    expect(frame).toContain(
      `Create your ${FIXTURE_ADVERTISER_NAME} project: ${FIXTURE_ADVERTISER_CTA_URL}`,
    )
  })

  test('an unsettled row prints no CTA and no placeholder', async () => {
    const frame = await render(blockFor(SPONSORED_ROW_FIXTURES.committed), 120)
    expect(frame).not.toContain('Create your')
  })

  test('no hostile CTA URL is ever printed, and the card survives', async () => {
    for (const advertiser_cta_url of HOSTILE_PR_URLS) {
      const frame = await render(
        blockFor({ ...SPONSORED_ROW_FIXTURES.committed, advertiser_cta_url }),
        60,
      )
      expect(frame, advertiser_cta_url).not.toContain('Create your')
      if (advertiser_cta_url.length > 0) {
        expect(frame, advertiser_cta_url).not.toContain(
          advertiser_cta_url.slice(0, 12),
        )
      }
      expect(frame, advertiser_cta_url).toContain('SPONSORED')
    }
  })
})

describe('the two waivers, asserted', () => {
  test('R-15 is waived: an https PR is sanitized TEXT, never a link', async () => {
    const frame = await render(blockFor(SPONSORED_ROW_FIXTURES.landed), 60)
    // A terminal cannot make a link; it can print a destination the user may
    // copy. What must still hold is that only a gated URL is ever printed.
    expect(frame).toContain('https://github.com/x/y/pull/7')
  })

  test('R-14 no hostile URL is ever printed, and the card survives', async () => {
    for (const state of ['landed', 'merged'] as const) {
      for (const pr_url of HOSTILE_PR_URLS) {
        const frame = await render(
          blockFor({ ...SPONSORED_ROW_FIXTURES[state], pr_url }),
          60,
        )
        if (pr_url.length > 0) {
          expect(frame, `${state}: ${pr_url}`).not.toContain(
            pr_url.slice(0, 12),
          )
        }
        // Losing the link costs a click; losing the card would withhold the
        // news that a sponsored thread reached the user's repository.
        expect(frame, `${state}: ${pr_url}`).toContain('SPONSORED')
      }
    }
  })

  test('R-16 / R-17 are waived: no logo is fetched, and the token never appears', async () => {
    // The strongest form this surface can state it in: a valid token, three
    // malformed ones and no token at all all render the same frame.
    const noToken = await render(blockFor(SPONSORED_ROW_FIXTURES.offered), 60)
    for (const token of [VALID_LOGO_TOKEN, ...MALFORMED_LOGO_TOKENS]) {
      const frame = await render(
        blockFor({
          ...SPONSORED_ROW_FIXTURES.offered,
          advertiser_logo_token: token,
        }),
        60,
      )
      expect(frame, JSON.stringify(token)).toBe(noToken)
      expect(frame).not.toContain('creative-image')
    }
  })
})

/**
 * The frames themselves, checked in.
 *
 * The assertions above say what must be present; this says what it LOOKS like,
 * which is the half a terminal card actually gets wrong -- a clipped headline,
 * a wrapped disclosure, a step column that eats the step text. Reviewing a diff
 * of these is the only way that shows up before a user sees it.
 *
 * Regenerate deliberately: `UPDATE_PROPOSAL_FRAMES=1 bun test
 * sponsored-proposal-block`. A frame that changed without anyone intending it
 * fails here, which is the point.
 */
describe('checked-in frames', () => {
  const SNAPSHOT = join(
    import.meta.dir,
    '__snapshots__',
    'sponsored-proposal-frames.txt',
  )

  test('every state at 20, 48 and 60 columns', async () => {
    const sections: string[] = []
    for (const state of SPONSORED_FIXTURE_STATES) {
      for (const width of WIDTHS) {
        const frame = await render(
          blockFor(SPONSORED_ROW_FIXTURES[state]),
          width,
        )
        sections.push(
          `=== ${state} @ ${width} ===\n${frame.replace(/[ \t]+$/gm, '')}`,
        )
      }
    }
    // PHASE 2's two new renders, at the same three widths (COD-339). The
    // consent is the screen a run cannot start without, and the Windows card is
    // the refusal COD-336 item 3 requires -- both are things a diff should show
    // before a user does.
    sections.push(...(await extraSections()))
    const rendered = `${sections.join('\n')}\n`
    if (process.env.UPDATE_PROPOSAL_FRAMES === '1') {
      mkdirSync(dirname(SNAPSHOT), { recursive: true })
      writeFileSync(SNAPSHOT, rendered)
    }
    expect(
      readFileSync(SNAPSHOT, 'utf8'),
      'frames changed -- review the diff, then UPDATE_PROPOSAL_FRAMES=1 to accept',
    ).toBe(rendered)
  })
})

/**
 * The consent screen and the machine that cannot run one.
 *
 * Separated from the state loop above because neither is a STATE of the row: a
 * consent is a screen over an `offered` card, and the Windows refusal is the
 * same `offered` card on a different machine.
 */
async function extraSections(): Promise<string[]> {
  const out: string[] = []
  for (const width of WIDTHS) {
    const frame = await render(
      blockFor(SPONSORED_ROW_FIXTURES.offered, { consent: CONSENT }),
      width,
    )
    out.push(`=== consent @ ${width} ===\n${frame.replace(/[ \t]+$/gm, '')}`)
  }
  setSponsoredCliAvailability('unavailable:windows-no-containment')
  try {
    for (const width of WIDTHS) {
      const frame = await render(
        blockFor(SPONSORED_ROW_FIXTURES.offered),
        width,
      )
      out.push(
        `=== offered-windows @ ${width} ===\n${frame.replace(/[ \t]+$/gm, '')}`,
      )
    }
  } finally {
    setSponsoredCliAvailability('available')
  }
  return out
}

describe('the block itself', () => {
  test('is a plain serializable block, not html', () => {
    // `HtmlContentBlock` cannot survive being written to history and read back,
    // and this card has to: a proposal outlives the turn it arrived on.
    const block: ContentBlock = blockFor(SPONSORED_ROW_FIXTURES.offered)
    expect(JSON.parse(JSON.stringify(block))).toEqual(block)
  })

  test('the hint names commands while nothing is open, and keys while it is', () => {
    // A hint with nothing open may not name a bare key, because the card binds
    // none -- and a hint naming a key that does nothing is worse than no hint.
    const closed = hintFor('closed')
    expect(closed).toContain('/ads:proposal')
    expect(closed).toContain('/ads:dismiss-proposal')
    // Two columns of padding the card's own `inner` does not account for, so
    // the widest line it may emit is narrower than `inner` suggests.
    expect(closed.length).toBeLessThanOrEqual(44)
    for (const key of ['esc dismiss', 'm options', 'enter open PR']) {
      expect(closed).not.toContain(key)
    }
    // ACCEPT IS NAMED ONLY WHERE THERE IS ONE. `closed` is what a machine that
    // cannot contain a run renders (Windows, COD-336 item 3), and naming a
    // control that is not there is how a card starts looking like it can run
    // something it cannot.
    expect(closed.toLowerCase()).not.toContain('accept')
    expect(hintFor('acceptable')).toContain('/ads:accept-proposal')

    // The two spans where the card owns the keyboard, and chat's is disabled
    // for exactly them.
    expect(hintFor('menu')).toContain('esc close')
    expect(hintFor('consent')).toContain('esc cancel')
    for (const mode of ['menu', 'consent'] as const) {
      expect(hintFor(mode).length, mode).toBeLessThanOrEqual(44)
    }
  })

  test('a narrow hint never clips a command mid-token', () => {
    // A truncated `/ads:dismiss-propos` teaches a command that does not exist,
    // and `/ads:accept-proposa` is the same failure on the new command.
    const REAL = [
      '/ads:proposal',
      '/ads:dismiss-proposal',
      '/ads:accept-proposal',
      '/ads:pull-request',
      '/ads:remove-worktree',
    ]
    for (const mode of ['closed', 'acceptable'] as const) {
      for (const width of [0, 1, 5, 13, 17, 20, 30, 36, 37, 40, 44]) {
        const hint = hintFor(mode, width)
        expect(hint.length, `${mode} @ ${width}`).toBeLessThanOrEqual(width)
        if (hint.length > 0) {
          for (const token of hint.split(' · ')) {
            expect(REAL, `${mode} @ ${width}`).toContain(token)
          }
        }
      }
    }
  })

  test('the consent screen is the only way a run can start', () => {
    // `hintMode` is the card's own account of what is reachable, and the
    // property being pinned is that ACCEPT and CONSENT are never the same
    // state: accept opens the screen, and only the screen can approve.
    const offered = blockFor(SPONSORED_ROW_FIXTURES.offered)
    expect(hintMode(offered, true)).toBe('acceptable')
    expect(hintMode(offered, false)).toBe('closed')
    expect(hintMode({ ...offered, consent: CONSENT }, true)).toBe('consent')
    // An open consent outranks an open menu: opening it closes the menu, so
    // the two are never both live and one Enter never has two handlers.
    expect(
      hintMode({ ...offered, consent: CONSENT, menuOpen: true }, true),
    ).toBe('consent')
  })
})

const CONSENT = {
  advertiserName: 'Acme Deploys',
  headline: 'Add one-click deploys',
  body: 'A sponsored agent can wire Acme Deploys into your repo.',
  folder: '/home/dev/app',
  branch: 'freebuff/sponsored-acme-deploys-run-1',
  runId: 'run-1',
}

/**
 * WHAT THE CARD DOES WITH A KEYPRESS, which is the finding this section exists
 * for.
 *
 * `useKeyboard` registers a GLOBAL listener; it is not scoped to a focused
 * element. Chat's composer has a global handler of its own and does not stop
 * firing because a transcript block exists, so every bare key this card used to
 * claim reached BOTH: typing `m` into a prompt opened an ad's menu, and an Esc
 * aimed at something else was recorded as a decline the user never made.
 *
 * So while the menu is closed the card must claim NOTHING. While it is open,
 * `chat.tsx` disables the chat keyboard for exactly that span -- the same
 * `disabled` prop askUser uses -- which is what makes the arrows, Enter and Esc
 * below safe to own.
 */
describe('the card claims no bare keys while its menu is closed', () => {
  type Call = [string, ...unknown[]]

  let cleanupKeys: (() => void) | undefined
  afterEach(() => {
    cleanupKeys?.()
    cleanupKeys = undefined
  })

  const mount = async (block: SponsoredProposalContentBlock) => {
    const calls: Call[] = []
    useMessageBlockStore.getState().setCallbacks({
      ...useMessageBlockStore.getState().callbacks,
      onSponsoredProposalMenu: (target, open) =>
        calls.push(['menu', target, open]),
      onSponsoredProposalDisclose: (target, open) =>
        calls.push(['disclose', target, open]),
      onSponsoredProposalAccept: (target) => calls.push(['accept', target]),
      onSponsoredProposalConsent: (target, approved) =>
        calls.push(['consent', target, approved]),
      onSponsoredProposalControl: (target, control) =>
        calls.push(['control', target, control]),
    })
    const setup = await createTestRenderer({
      width: 60,
      height: 24,
      // Unambiguous encoding: a bare Escape is otherwise indistinguishable
      // from the start of the next key's sequence, which is exactly the key
      // whose behaviour this section is about.
      kittyKeyboard: true,
    })
    const root = createRoot(setup.renderer)
    cleanupKeys = () => {
      flushSync(() => root.unmount())
      setup.renderer.destroy()
      useMessageBlockStore.getState().reset()
    }
    flushSync(() => {
      root.render(<SponsoredProposalBlock block={block} availableWidth={60} />)
    })
    await setup.renderOnce()

    /** Input lands on the render loop and the state it sets is committed by
     *  React's scheduler, so both drain before the next keypress. */
    const settle = async () => {
      await setup.renderOnce()
      await new Promise((resolve) => setTimeout(resolve, 20))
      await setup.renderOnce()
    }
    await settle()
    return {
      calls,
      input: setup.mockInput,
      async press(act: () => void) {
        act()
        await settle()
      },
    }
  }

  test('m, esc, enter and the arrows all do nothing on a closed card', async () => {
    const card = await mount(blockFor(SPONSORED_ROW_FIXTURES.offered))
    await card.press(() => card.input.pressKey('m'))
    await card.press(() => card.input.pressEscape())
    await card.press(() => card.input.pressEnter())
    await card.press(() => card.input.pressArrow('down'))
    expect(card.calls).toEqual([])
  })

  test('enter does not open a pull request either, even when the row has one', async () => {
    // The one bare binding that looked harmless. It is not: Enter is the
    // composer's submit, so a landed proposal sitting in the transcript meant
    // every message the user sent also tried to launch a browser.
    const card = await mount(blockFor(SPONSORED_ROW_FIXTURES.landed))
    await card.press(() => card.input.pressEnter())
    expect(card.calls).toEqual([])
  })

  test('an OPEN menu takes the arrows and Enter', async () => {
    const card = await mount(
      blockFor(SPONSORED_ROW_FIXTURES.offered, { menuOpen: true }),
    )
    await card.press(() => card.input.pressArrow('down'))
    await card.press(() => card.input.pressEnter())
    // The menu opens on ACCEPT (COD-339: the Accept is the first item, because
    // this surface has no room for a primary), so one Down lands on `why`.
    expect(card.calls).toEqual([
      ['menu', 'acme/deploys', false],
      ['disclose', 'acme/deploys', true],
    ])
  })

  test('the menu Accept OPENS the consent and starts nothing', async () => {
    // The whole of COD-336 item 4 on this surface, as a keypress test: the
    // first item of the menu reaches `onSponsoredProposalAccept`, which draws
    // a screen. It does NOT reach a control, and nothing anywhere is written.
    const card = await mount(
      blockFor(SPONSORED_ROW_FIXTURES.offered, { menuOpen: true }),
    )
    await card.press(() => card.input.pressEnter())
    expect(card.calls).toEqual([
      ['menu', 'acme/deploys', false],
      ['accept', 'acme/deploys'],
    ])
  })

  test('the consent starts on Not now, and Esc refuses without writing anything', async () => {
    // A caret that started on "run it" is a screen an impatient Enter answers
    // yes, so index 0 is the refusal -- and Esc is a refusal too, reported as
    // `false` rather than as nothing, so the caller closes the screen.
    const card = await mount(
      blockFor(SPONSORED_ROW_FIXTURES.offered, { consent: CONSENT }),
    )
    await card.press(() => card.input.pressEnter())
    expect(card.calls).toEqual([['consent', 'acme/deploys', false]])
    await card.press(() => card.input.pressEscape())
    expect(card.calls).toEqual([
      ['consent', 'acme/deploys', false],
      ['consent', 'acme/deploys', false],
    ])
  })

  test('the consent approves only after the caret is moved onto the run', async () => {
    const card = await mount(
      blockFor(SPONSORED_ROW_FIXTURES.offered, { consent: CONSENT }),
    )
    await card.press(() => card.input.pressArrow('down'))
    await card.press(() => card.input.pressEnter())
    expect(card.calls).toEqual([['consent', 'acme/deploys', true]])
  })

  test('an open consent takes the keys, and the menu behind it takes none', async () => {
    // Opening the consent closes the menu, so the two are never both live --
    // but the block is a plain record and nothing stops both flags being set.
    // The card resolves it in one direction, always, so one Enter has one
    // handler.
    const card = await mount(
      blockFor(SPONSORED_ROW_FIXTURES.offered, {
        consent: CONSENT,
        menuOpen: true,
      }),
    )
    await card.press(() => card.input.pressArrow('down'))
    await card.press(() => card.input.pressEnter())
    expect(card.calls).toEqual([['consent', 'acme/deploys', true]])
  })

  test('Esc closes the MENU and never answers the proposal', async () => {
    // The old binding dismissed. "I opened this by accident" is the single
    // most likely reason a user presses Esc here, and recording it as a
    // decline is an answer they did not give.
    const card = await mount(
      blockFor(SPONSORED_ROW_FIXTURES.offered, { menuOpen: true }),
    )
    await card.press(() => card.input.pressEscape())
    expect(card.calls).toEqual([['menu', 'acme/deploys', false]])
  })

  test('an answered card activates nothing, but can still close its menu', async () => {
    const card = await mount(
      blockFor(SPONSORED_ROW_FIXTURES.offered, {
        menuOpen: true,
        answered: true,
      }),
    )
    await card.press(() => card.input.pressEnter())
    expect(card.calls).toEqual([])
    await card.press(() => card.input.pressEscape())
    expect(card.calls).toEqual([['menu', 'acme/deploys', false]])
  })
})
