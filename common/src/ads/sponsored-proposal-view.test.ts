/**
 * The VM layer of the sponsored-proposal conformance matrix (COD-376).
 *
 * VM-1..VM-28 are these `test(...)` cases in file order, and the IDs are in
 * the names so a surface's report can cite them. These run ONCE, here: the
 * view model is shared, and a surface that re-implemented them would be
 * asserting against its own copy of the state machine rather than the one
 * every surface renders. `sponsoredProposalConformance.test.ts`, beside the
 * Web panel, fails if an ID in `./sponsored-proposal-conformance.ts` has no
 * case naming it.
 */
import { describe, expect, test } from 'bun:test'

import {
  FIXTURE_ADVERTISER_CTA_URL,
  FIXTURE_PR_URL,
  HOSTILE_PR_URLS,
  MALFORMED_LOGO_TOKENS,
  VALID_LOGO_TOKEN,
} from './__fixtures__/sponsored-proposal-rows'
import {
  SPONSORED_STATE_TITLE,
  SPONSORED_STEP_STATE_LABEL,
  sponsoredProposalAction,
  sponsoredProposalMenu,
  sponsoredProposalViewModel,
  type SponsoredProposalRow,
  type SponsoredProposalState,
} from './sponsored-proposal-view'

const ALL_STATES: SponsoredProposalState[] = [
  'offered',
  'accepted',
  'running',
  'committed',
  'landed',
  'failed',
  'merged',
]

const row = (
  overrides: Partial<SponsoredProposalRow>,
): SponsoredProposalRow => ({
  state: 'offered',
  advertiser_name: 'Acme Deploys',
  headline: 'Add one-click deploys to this project',
  body: 'A sponsored agent can wire Acme Deploys into your repo on its own branch.',
  ...overrides,
})

const view = (overrides: Partial<SponsoredProposalRow>) =>
  sponsoredProposalViewModel(row(overrides))

const kinds = (overrides: Partial<SponsoredProposalRow>) =>
  view(overrides).actions.map((action) => action.kind)

describe('state copy', () => {
  test('VM-1 every state names its own outcome', () => {
    for (const state of ALL_STATES) {
      expect(view({ state }).title).toBe(SPONSORED_STATE_TITLE[state])
      expect(view({ state }).title.length).toBeGreaterThan(0)
    }
  })

  // The state COD-279 exists for: the run finished and stopped, and nothing
  // here may read as though a pull request is pending.
  test('VM-2 committed names the outcome, not a next step', () => {
    expect(view({ state: 'committed' }).title).toBe(
      'Sponsored thread committed its work',
    )
    expect(view({ state: 'committed' }).title).not.toContain('running')
  })
})

describe('steps', () => {
  const STEPS = [
    { text: 'Install the SDK', state: 'done' as const },
    { text: 'Wire the deploy hook', state: 'active' as const },
    { text: 'Open a pull request', state: 'pending' as const },
  ]

  test('VM-3 counts the done steps for the progress counter', () => {
    const model = view({ state: 'running', steps: STEPS })
    expect(model.steps).toEqual(STEPS)
    expect(model.doneStepCount).toBe(1)
  })

  test('VM-4 absent steps are an empty list, not undefined', () => {
    expect(view({ state: 'running' }).steps).toEqual([])
    expect(view({ state: 'running' }).doneStepCount).toBe(0)
  })

  test('VM-5 reads in the todo-dock vocabulary', () => {
    expect(SPONSORED_STEP_STATE_LABEL).toEqual({
      pending: 'Pending',
      active: 'In progress',
      done: 'Done',
    })
  })
})

describe('actions', () => {
  test('VM-6 offered leads with accept', () => {
    const accept = sponsoredProposalAction(view({}), 'accept')
    expect(accept?.label).toBe('Start sponsored thread')
    expect(accept?.primary).toBe(true)
  })

  test('VM-7 accepted and failed offer no answer beyond the decline', () => {
    for (const state of ['accepted', 'failed'] as const) {
      expect(kinds({ state })).toEqual([
        'dismiss',
        'never-advertiser',
        'report',
        'opt-out',
      ])
    }
  })

  // Every state declines the same way, and this is the only decline.
  test('VM-8 dismiss is available in every state and is not destructive', () => {
    for (const state of ALL_STATES) {
      const dismiss = sponsoredProposalAction(view({ state }), 'dismiss')
      expect(dismiss?.label).toBe('Dismiss sponsored proposal')
      expect(dismiss?.destructive).toBeUndefined()
    }
  })

  // Turning a channel off for good is a different weight of answer from
  // declining one offer.
  test('VM-9 the standing channel controls are available in every state', () => {
    for (const state of ALL_STATES) {
      const model = view({ state })
      expect(
        sponsoredProposalAction(model, 'report')?.destructive,
      ).toBeUndefined()
      expect(sponsoredProposalAction(model, 'never-advertiser')).toEqual({
        kind: 'never-advertiser',
        label: 'Never show Acme Deploys',
        destructive: true,
      })
      expect(sponsoredProposalAction(model, 'opt-out')?.destructive).toBe(true)
    }
  })

  test('VM-10 running offers the live view only once a thread exists', () => {
    expect(
      sponsoredProposalAction(
        view({ state: 'running', thread_ref: 'thread-1' }),
        'view-run',
      )?.label,
    ).toBe('Watch this run')
    expect(kinds({ state: 'running' })).not.toContain('view-run')
  })

  // The PR is the user's decision, so `committed` offers to make one and
  // claims none exists.
  test('VM-11 committed offers the PR decision and the read-only view', () => {
    const model = view({
      state: 'committed',
      branch: 'sponsored/acme-deploys',
      thread_ref: 'thread-1',
    })
    expect(sponsoredProposalAction(model, 'create-pull-request')).toEqual({
      kind: 'create-pull-request',
      label: 'Create pull request',
      primary: true,
    })
    expect(sponsoredProposalAction(model, 'view-run')?.label).toBe(
      'View what it did',
    )
    expect(sponsoredProposalAction(model, 'open-pull-request')).toBeNull()
  })

  test('VM-12 committed still offers the PR decision with no thread to view', () => {
    expect(kinds({ state: 'committed' })).toContain('create-pull-request')
    expect(kinds({ state: 'committed' })).not.toContain('view-run')
  })

  // Opening the PR must not take the read-only view away.
  test('VM-13 the read-only view survives into landed', () => {
    const model = view({
      state: 'landed',
      thread_ref: 'thread-1',
      pr_url: 'https://github.com/x/y/pull/7',
    })
    expect(sponsoredProposalAction(model, 'view-run')?.label).toBe(
      'View what it did',
    )
    expect(sponsoredProposalAction(model, 'open-pull-request')?.label).toBe(
      'Review the pull request',
    )
  })

  // One kind, two labels: reviewing a PR the user has not seen and revisiting
  // one that already merged are different sentences.
  test('VM-14 merged links the merged PR under its own label', () => {
    const model = view({
      state: 'merged',
      pr_url: 'https://github.com/x/y/pull/7',
    })
    expect(sponsoredProposalAction(model, 'open-pull-request')).toEqual({
      kind: 'open-pull-request',
      label: 'view on GitHub',
      href: 'https://github.com/x/y/pull/7',
    })
    expect(kinds({ state: 'merged' })).not.toContain('view-run')
  })
})

/**
 * `pr_url` is the one field on this record that becomes a capability rather
 * than text. The row is written by the sponsored run, so a surface that reads
 * it raw would hand a hostile scheme to a link the user has every reason to
 * click — this channel's whole proposition is that the sponsored thread
 * touched their real repo.
 */
describe('pr_url is https-only before it becomes a destination', () => {
  // Shared with the other two surfaces' render suites, so none of them can
  // quietly test a shorter list than this one does.
  for (const state of ['landed', 'merged'] as const) {
    for (const pr_url of HOSTILE_PR_URLS) {
      test(`VM-15 ${state}: refuses ${JSON.stringify(pr_url)}`, () => {
        const model = view({ state, pr_url })
        expect(model.pullRequestHref).toBeNull()
        // Not just a null href: the action itself is off the menu, so a
        // surface cannot render a link with nowhere to go.
        expect(sponsoredProposalAction(model, 'open-pull-request')).toBeNull()
      })
    }

    // An unusable URL is the absent-field case, exactly like a missing
    // `branch` — the user still learns a sponsored thread reached their repo.
    test(`VM-16 ${state}: a refused link does not cost the rest of the card`, () => {
      const model = view({ state, pr_url: 'javascript:alert(1)' })
      expect(model.title).toBe(SPONSORED_STATE_TITLE[state])
      expect(model.actions.map((action) => action.kind)).toContain('dismiss')
    })

    test(`VM-17 ${state}: passes an https pull request through`, () => {
      expect(
        view({ state, pr_url: 'https://github.com/x/y/pull/7' })
          .pullRequestHref,
      ).toBe('https://github.com/x/y/pull/7')
    })
  }
})

/**
 * A logo token is minted per upload, so a re-upload kills the previous one.
 * Absent, stale and malformed are all ordinary, and none of them may become a
 * request or a path segment.
 */
describe('advertiser logo', () => {
  const TOKEN = VALID_LOGO_TOKEN

  test('VM-18 a well-formed token becomes the creative-image route', () => {
    const model = view({ advertiser_logo_token: TOKEN })
    expect(model.logoToken).toBe(TOKEN)
    expect(model.logoSrc).toBe(`/api/ads/first-party/creative-image/${TOKEN}`)
  })

  test('VM-19 no token is the ordinary no-logo case', () => {
    expect(view({}).logoToken).toBeNull()
    expect(view({}).logoSrc).toBeNull()
  })

  for (const token of MALFORMED_LOGO_TOKENS) {
    test(`VM-20 never mints a request for ${JSON.stringify(token)}`, () => {
      const model = view({ advertiser_logo_token: token })
      expect(model.logoToken).toBeNull()
      expect(model.logoSrc).toBeNull()
    })
  }
})

describe('copy fallbacks', () => {
  test('VM-21 why_this falls back to the channel promise', () => {
    expect(view({}).whyThis).toContain(
      'never read your code without your go-ahead',
    )
    expect(view({ why_this: 'You use Vercel.' }).whyThis).toBe(
      'You use Vercel.',
    )
  })

  test('VM-22 a failed run promises nothing changed even with no reason', () => {
    expect(view({ state: 'failed' }).failureReason).toContain(
      'Nothing was changed in your project',
    )
    expect(
      view({ state: 'failed', failure_reason: 'Budget exceeded' })
        .failureReason,
    ).toBe('Budget exceeded')
  })

  // A run old enough to predate the reconciler recording a branch still has to
  // render, and must not invent a branch name it cannot prove.
  test('VM-23 an absent branch is null rather than a guess', () => {
    expect(view({ state: 'committed' }).branch).toBeNull()
    expect(view({ state: 'committed', branch: '' }).branch).toBeNull()
    expect(view({ state: 'committed', branch: 'sponsored/acme' }).branch).toBe(
      'sponsored/acme',
    )
  })
})

describe('sponsoredProposalMenu', () => {
  test('VM-24 lists every channel control, in order', () => {
    expect(sponsoredProposalMenu('Acme Deploys')).toEqual([
      { key: 'why', label: 'Why this?' },
      { key: 'never-advertiser', label: 'Never show Acme Deploys' },
      { key: 'report', label: 'Report this proposal' },
      {
        key: 'opt-out',
        label: 'Turn off sponsored proposals',
        separatorBefore: true,
      },
    ])
  })
})

/**
 * The Accept in the overflow menu (COD-339).
 *
 * A surface with no room for a primary needs somewhere to put the answer to the
 * offer, and the only honest place is the top of the list of answers. It is
 * passed in rather than derived from the row, so a surface that cannot RUN a
 * sponsored task (Windows, per COD-336 item 3) simply does not offer it instead
 * of drawing a control that refuses.
 */
describe('sponsoredProposalMenu and the optional Accept', () => {
  test('VM-25 is unchanged when no accept label is given', () => {
    const menu = sponsoredProposalMenu('Acme')
    expect(menu.map((item) => item.key)).toEqual([
      'why',
      'never-advertiser',
      'report',
      'opt-out',
    ])
  })

  test('VM-26 puts the Accept first, and changes nothing else', () => {
    const menu = sponsoredProposalMenu('Acme', {
      acceptLabel: 'Start sponsored thread',
    })
    expect(menu[0]).toMatchObject({
      key: 'accept',
      label: 'Start sponsored thread',
    })
    expect(menu.slice(1)).toEqual(sponsoredProposalMenu('Acme'))
  })

  test('VM-27 an empty label is not an Accept', () => {
    // The label comes from the view model's action, which is absent in every
    // state but `offered`. An empty string reaching here must not draw a
    // nameless control.
    expect(
      sponsoredProposalMenu('Acme', { acceptLabel: '' }).map((i) => i.key),
    ).not.toContain('accept')
  })

  test('VM-28 the standing controls are still the last three, in order', () => {
    // Report, never-this-advertiser and the channel opt-out are the only
    // controls the user has over this channel. Adding an Accept above them must
    // not thin them out.
    const menu = sponsoredProposalMenu('Acme', { acceptLabel: 'Start' })
    expect(menu.slice(-3).map((item) => item.key)).toEqual([
      'never-advertiser',
      'report',
      'opt-out',
    ])
  })
})

describe('the advertiser CTA (COD-512)', () => {
  const CTA = FIXTURE_ADVERTISER_CTA_URL

  test('VM-29 committed, landed and merged offer the CTA under a neutral label carrying the advertiser name', () => {
    for (const state of ['committed', 'landed', 'merged'] as const) {
      const v = view({ state, advertiser_cta_url: CTA })
      expect(v.advertiserCtaHref).toBe(CTA)
      const action = sponsoredProposalAction(v, 'open-advertiser')
      expect(action).toEqual({
        kind: 'open-advertiser',
        label: 'Create your Acme Deploys project',
        href: CTA,
      })
      // Never the lead answer: the PR decision and the PR link keep primacy.
      expect(action!.primary).toBeUndefined()
    }
  })

  test('VM-30 no state before a diff exists offers it, and failed never does', () => {
    for (const state of ['offered', 'accepted', 'running', 'failed'] as const) {
      const v = view({ state, advertiser_cta_url: CTA })
      expect(v.advertiserCtaHref).toBeNull()
      expect(kinds({ state, advertiser_cta_url: CTA })).not.toContain(
        'open-advertiser',
      )
    }
  })

  test('VM-31 an absent CTA is absent: no action, no placeholder, and the card is otherwise unchanged', () => {
    for (const state of ['committed', 'landed', 'merged'] as const) {
      const without = view({ state, pr_url: FIXTURE_PR_URL })
      const withCta = view({
        state,
        pr_url: FIXTURE_PR_URL,
        advertiser_cta_url: CTA,
      })
      expect(without.advertiserCtaHref).toBeNull()
      expect(kinds({ state })).not.toContain('open-advertiser')
      expect(
        withCta.actions.filter((a) => a.kind !== 'open-advertiser'),
      ).toEqual(without.actions)
    }
  })

  for (const advertiser_cta_url of HOSTILE_PR_URLS) {
    test(`VM-32 refuses ${JSON.stringify(advertiser_cta_url)} before it becomes a destination`, () => {
      const v = view({ state: 'committed', advertiser_cta_url })
      expect(v.advertiserCtaHref).toBeNull()
      expect(sponsoredProposalAction(v, 'open-advertiser')).toBeNull()
      // A refused link does not cost the rest of the card.
      expect(v.title).toBe(SPONSORED_STATE_TITLE.committed)
      expect(kinds({ state: 'committed', advertiser_cta_url })).toContain(
        'create-pull-request',
      )
    })
  }
})
