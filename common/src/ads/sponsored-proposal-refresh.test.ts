/**
 * The proposal card's REFRESH cadence — which state of a row is still owed an
 * answer, and which is finished.
 *
 * NOT in `sponsored-proposal-view.test.ts`, even though the function under test
 * sits beside the view model. That suite is pinned one-to-one against the
 * web/Desktop conformance matrix by
 * `freebuff/web/.../sponsoredProposalConformance.test.ts`, which counts its
 * `test(` cases — so adding cases there breaks a render-parity invariant for a
 * reason that has nothing to do with render parity. Nothing below is about what
 * the two surfaces draw.
 *
 * The bug these exist for: on the COD-397 local walk a sponsored run failed, the
 * row was `failed` server-side for several minutes, and the card went on
 * rendering `offered` with a live "Start sponsored thread" button until the
 * renderer was reloaded. Pressing that button aims an Accept at a proposal that
 * is already dead.
 */

import { describe, expect, test } from 'bun:test'

import {
  SPONSORED_STATE_IS_TERMINAL,
  sponsoredProposalAwaitsVerdict,
  type SponsoredProposalState,
} from './sponsored-proposal-view'
import { sponsoredProposalRefreshMayPoll } from './sponsored-proposal-refresh'

const ALL_STATES: SponsoredProposalState[] = [
  'offered',
  'accepted',
  'running',
  'committed',
  'landed',
  'failed',
  'merged',
]

describe('sponsoredProposalAwaitsVerdict', () => {
  test('classifies every state, so a new one cannot default to unwatched', () => {
    expect(Object.keys(SPONSORED_STATE_IS_TERMINAL).sort()).toEqual(
      [...ALL_STATES].sort(),
    )
    for (const state of ALL_STATES) {
      expect(typeof SPONSORED_STATE_IS_TERMINAL[state]).toBe('boolean')
    }
  })

  test('watches a run in flight whether or not the row has caught up', () => {
    // THE REPORTED CASE. Accept leaves the card on `offered` and records only
    // the run's thread id, so between the accept and the first poll the row
    // still reads `offered` while a run is very much in flight. Keying on the
    // state alone stops watching exactly when watching starts to matter.
    expect(sponsoredProposalAwaitsVerdict('offered', true)).toBe(true)
    expect(sponsoredProposalAwaitsVerdict('accepted', true)).toBe(true)
    expect(sponsoredProposalAwaitsVerdict('running', true)).toBe(true)
    // And with no local run, the states that mean a run exists still count: it
    // may have been started from another window.
    expect(sponsoredProposalAwaitsVerdict('accepted', false)).toBe(true)
    expect(sponsoredProposalAwaitsVerdict('running', false)).toBe(true)
  })

  test('leaves a plain offer on the ordinary cadence', () => {
    // An offer changes only when the server rotates it. Watching it hard would
    // poll every few seconds forever, for every user, for no new information.
    expect(sponsoredProposalAwaitsVerdict('offered', false)).toBe(false)
  })

  test('stops watching once the row is terminal, run or no run', () => {
    for (const state of ['committed', 'landed', 'failed', 'merged'] as const) {
      expect(sponsoredProposalAwaitsVerdict(state, true)).toBe(false)
      expect(sponsoredProposalAwaitsVerdict(state, false)).toBe(false)
    }
  })
})

describe('sponsoredProposalRefreshMayPoll', () => {
  test('refreshes an active thread in a visible desktop window without activity', () => {
    expect(
      sponsoredProposalRefreshMayPoll({
        windowVisible: true,
        threadIsActive: true,
      }),
    ).toBe(true)
  })

  test('does not refresh a hidden window or an inactive thread', () => {
    expect(
      sponsoredProposalRefreshMayPoll({
        windowVisible: false,
        threadIsActive: true,
      }),
    ).toBe(false)
    expect(
      sponsoredProposalRefreshMayPoll({
        windowVisible: true,
        threadIsActive: false,
      }),
    ).toBe(false)
  })
})
