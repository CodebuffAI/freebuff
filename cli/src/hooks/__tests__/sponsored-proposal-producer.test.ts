/**
 * The producer's two decisions, tested as pure functions (COD-339).
 *
 * The hook itself is a timer and a fetch and is not worth mounting; what is
 * worth pinning is what it DECIDES — how often to ask, and what to do with the
 * answer. Both are exported for exactly that reason.
 *
 * Before this ticket nothing in `cli/src` called `fetchSponsoredProposal` at
 * all, which is why the conformance matrix waived E-1, E-2 and E-6 for "no
 * producer" rather than for anything about execution.
 */
import { describe, expect, test } from 'bun:test'

import { ensureCliTestEnv } from '../../__tests__/test-utils'
import { patchSponsoredProposalBlock } from '../../utils/sponsored-proposal-state'

ensureCliTestEnv()

const {
  PROPOSAL_POLL_INTERVAL_MS,
  PROPOSAL_RUN_POLL_INTERVAL_MS,
  applyPolledProposal,
  findProposalBlock,
  proposalPollIntervalMs,
} = await import('../use-sponsored-proposal')

import type { SponsoredProposal } from '../../utils/sponsored-proposal-api'
import type {
  ChatMessage,
  SponsoredProposalContentBlock,
} from '../../types/chat'

const TARGET = 'acme/deploys'

const proposal = (
  over: Partial<SponsoredProposal> = {},
): SponsoredProposal => ({
  _id: 'proposal-1',
  advertiser_id: 'adv_acme',
  state: 'offered',
  advertiser_name: 'Acme Deploys',
  headline: 'Add one-click deploys',
  body: 'A sponsored agent can wire Acme Deploys into your repo.',
  ...over,
})

const present = (row = proposal()) => ({
  status: 'present' as const,
  proposal: row,
})
const absent = { status: 'absent' as const }
const unavailable = { status: 'unavailable' as const }

const withBlock = (
  over: Partial<SponsoredProposalContentBlock> = {},
): ChatMessage[] => [
  {
    id: 'sys-1',
    variant: 'ai',
    content: '',
    timestamp: '',
    blocks: [
      {
        type: 'sponsored-proposal',
        target: TARGET,
        proposal: proposal(),
        ...over,
      } as SponsoredProposalContentBlock,
    ],
  } as ChatMessage,
]

describe('reports remain attached to their original proposal', () => {
  for (const alreadySending of [false, true]) {
    test(`a replacement is not marked busy or answered when the old report ${alreadySending ? 'finishes' : 'starts'}`, () => {
      let messages = withBlock()
      if (alreadySending) {
        messages = patchSponsoredProposalBlock(
          messages,
          TARGET,
          { busy: true },
          'proposal-1',
        )
      }
      messages = applyPolledProposal(
        messages,
        TARGET,
        present(proposal({ _id: 'proposal-2' })),
      )
      messages = patchSponsoredProposalBlock(
        messages,
        TARGET,
        { busy: true },
        'proposal-1',
      )
      messages = patchSponsoredProposalBlock(
        messages,
        TARGET,
        { busy: false, answered: true },
        'proposal-1',
      )
      const replacement = findProposalBlock(messages)!
      expect(replacement.proposal._id).toBe('proposal-2')
      expect(replacement.busy).toBeUndefined()
      expect(replacement.answered).toBeUndefined()
    })
  }

  test('refreshing the same proposal preserves its pending state and accepts its completion', () => {
    let messages = patchSponsoredProposalBlock(
      withBlock(),
      TARGET,
      { busy: true },
      'proposal-1',
    )
    messages = applyPolledProposal(
      messages,
      TARGET,
      present(proposal({ headline: 'Updated offer headline' })),
    )
    expect(findProposalBlock(messages)?.busy).toBe(true)
    messages = patchSponsoredProposalBlock(
      messages,
      TARGET,
      { busy: false, answered: true },
      'proposal-1',
    )
    expect(findProposalBlock(messages)?.answered).toBe(true)
    expect(findProposalBlock(messages)?.busy).toBe(false)
  })
})

describe('the cadence', () => {
  test('an offer is polled once a minute; a run several times', () => {
    // An offer changes only when the server rotates it. A row with a run behind
    // it is a process mutating the user's own repository, and the card is the
    // only place they can watch it.
    expect(proposalPollIntervalMs(null)).toBe(PROPOSAL_POLL_INTERVAL_MS)
    const offered = findProposalBlock(withBlock())!
    expect(proposalPollIntervalMs(offered)).toBe(PROPOSAL_POLL_INTERVAL_MS)

    const running = findProposalBlock(
      withBlock({ proposal: proposal({ state: 'running' }) }),
    )!
    expect(proposalPollIntervalMs(running)).toBe(PROPOSAL_RUN_POLL_INTERVAL_MS)
  })

  test('an accept speeds the poll up before the ROW admits a run exists', () => {
    // Accept leaves the row readable as `offered` until the first poll, so
    // keying on the state alone would drop back to the offer cadence at exactly
    // the moment watching starts to matter. `runStarted` is what closes it, and
    // the decision itself is the shared `sponsoredProposalAwaitsVerdict`.
    const justAccepted = findProposalBlock(withBlock({ runStarted: true }))!
    expect(proposalPollIntervalMs(justAccepted)).toBe(
      PROPOSAL_RUN_POLL_INTERVAL_MS,
    )
  })

  test('a terminal row stops being watched', () => {
    for (const state of ['committed', 'failed', 'landed', 'merged'] as const) {
      const block = findProposalBlock(
        withBlock({ proposal: proposal({ state }), runStarted: true }),
      )!
      expect(proposalPollIntervalMs(block), state).toBe(
        PROPOSAL_POLL_INTERVAL_MS,
      )
    }
  })
})

describe('folding a polled row into the transcript', () => {
  test('a first offer becomes a card', () => {
    const next = applyPolledProposal([], TARGET, present())
    expect(findProposalBlock(next)?.target).toBe(TARGET)
  })

  test('a repository gets ONE card, not one per poll', () => {
    const first = applyPolledProposal([], TARGET, present())
    const second = applyPolledProposal(first, TARGET, present())
    expect(second).toBe(first)
    expect(
      second
        .flatMap((m) => m.blocks ?? [])
        .filter((b) => b.type === 'sponsored-proposal'),
    ).toHaveLength(1)
  })

  test('a state change folds into the card the user is already looking at', () => {
    // `committed` and `failed` must land on the existing card rather than
    // below it: a second card would leave the transcript claiming two offers.
    const first = applyPolledProposal([], TARGET, present())
    const next = applyPolledProposal(
      first,
      TARGET,
      present(proposal({ state: 'committed', branch: 'freebuff/x' })),
    )
    expect(next).not.toBe(first)
    expect(findProposalBlock(next)?.proposal.state).toBe('committed')
    expect(
      next
        .flatMap((m) => m.blocks ?? [])
        .filter((b) => b.type === 'sponsored-proposal'),
    ).toHaveLength(1)
  })

  test('a card the user ANSWERED is never revived', () => {
    // `answered` stands the controls down permanently and the row upstream is
    // dismissed, so a poll that still sees something is seeing a rotation the
    // user has not been offered yet.
    const answered = withBlock({ answered: true })
    expect(applyPolledProposal(answered, TARGET, present())).toBe(answered)
  })

  test('authoritative absence removes a stale actionable card', () => {
    const before = withBlock()
    expect(applyPolledProposal(before, TARGET, absent)).toEqual([])
    expect(applyPolledProposal([], TARGET, absent)).toEqual([])
  })

  test('authoritative absence preserves answered history', () => {
    const answered = withBlock({ answered: true })
    expect(applyPolledProposal(answered, TARGET, absent)).toBe(answered)
  })

  test('an unavailable refresh keeps context but pauses stale controls', () => {
    const before = withBlock({ menuOpen: true })
    const next = applyPolledProposal(before, TARGET, unavailable)
    const block = findProposalBlock(next)!
    expect(next).not.toBe(before)
    expect(block.proposal).toEqual(proposal())
    expect(block.refreshUnavailable).toBe(true)
    expect(block.menuOpen).toBe(false)
  })

  test('a successful refresh restores controls after an unavailable poll', () => {
    const before = withBlock({ refreshUnavailable: true })
    const next = applyPolledProposal(before, TARGET, present())
    expect(findProposalBlock(next)?.refreshUnavailable).toBeUndefined()
  })

  test('same-state payload updates replace every rendered field', () => {
    const before = withBlock({
      proposal: proposal({
        state: 'running',
        steps: [{ text: 'Old step', state: 'active' }],
        thread_ref: 'thread-old',
      }),
    })
    const updated = proposal({
      state: 'running',
      advertiser_name: 'Updated advertiser',
      headline: 'Updated headline',
      body: 'Updated body',
      why_this: 'Updated reason',
      steps: [{ text: 'New step', state: 'done' }],
      thread_ref: 'thread-new',
      branch: 'freebuff/new',
      failure_reason: 'Updated failure',
    })
    const next = applyPolledProposal(before, TARGET, present(updated))
    expect(findProposalBlock(next)?.proposal).toEqual(updated)
  })

  test('a row that is already over never ARRIVES as news', () => {
    // Inserting a fresh card at `committed` for a run this process never
    // started would be a report about somewhere else, landing here as an offer.
    for (const state of ['committed', 'failed', 'landed', 'merged'] as const) {
      expect(
        applyPolledProposal([], TARGET, present(proposal({ state }))),
        state,
      ).toEqual([])
    }
  })

  test('a poll for a different repository does not overwrite this one', () => {
    const before = withBlock()
    expect(applyPolledProposal(before, 'other/repo', present())).toBe(before)
  })
})
