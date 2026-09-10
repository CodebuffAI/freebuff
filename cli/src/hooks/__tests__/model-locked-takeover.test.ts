import { expect, test } from 'bun:test'

import { getFreebuffModel } from '@codebuff/common/constants/freebuff-models'

import {
  noteFreebuffExplicitPick,
  runModelLockedTakeover,
  takeFreebuffExplicitPick,
  type ModelLockedTakeoverDeps,
  type ModelLockedTakeoverOutcome,
} from '../use-freebuff-session'

import type { FreebuffSessionServerResponse } from '@codebuff/common/types/freebuff-session'

const LOCKED_MODEL = 'deepseek/deepseek-v4-pro'
const PICKED_MODEL = 'mimo/mimo-v2.5'

function heldActive(
  model: string,
): Extract<FreebuffSessionServerResponse, { status: 'active' }> {
  return {
    status: 'active',
    accessTier: 'full',
    instanceId: 'inst-held',
    model,
    admittedAt: '2026-09-09T00:00:00.000Z',
    expiresAt: '2026-09-09T01:00:00.000Z',
    remainingMs: 60_000,
  }
}

/** Records what the takeover branch did. Every collaborator is injected, so
 *  the code under test is the production branch and nothing here reaches a
 *  store, a timer, or the network. */
function takeoverHarness(
  held: FreebuffSessionServerResponse | Error,
  options: { isStale?: () => boolean; deleteRefused?: boolean } = {},
) {
  const calls = {
    reads: 0,
    released: [] as FreebuffSessionServerResponse[],
    notices: [] as string[],
  }
  const deps: ModelLockedTakeoverDeps = {
    fetchHeld: async () => {
      const row = await Promise.resolve(held)
      // Counted on completion: a read issued by a tick that then lost the loop
      // is still a read the branch performed.
      calls.reads += 1
      if (row instanceof Error) throw row
      return row
    },
    releaseSlot: async (row) => {
      if (options.deleteRefused) throw new Error('delete refused')
      calls.released.push(row)
    },
    notify: (message) => {
      calls.notices.push(message)
    },
    isStale: options.isStale ?? (() => false),
  }
  return { calls, deps }
}

// Slot order, not just wording: a takeover that names the models the wrong way
// round tells the user it switched to the model it actually left.
const CURRENT_NAME = getFreebuffModel(LOCKED_MODEL).displayName
const REQUESTED_NAME = getFreebuffModel(PICKED_MODEL).displayName
const ENDED_EXACT = `Ended your previous session on ${CURRENT_NAME} and switched to ${REQUESTED_NAME}.`
const FAILED_END_EXACT = `You're already in an active session on ${CURRENT_NAME}, and ending it failed, so the switch to ${REQUESTED_NAME} was not applied. Run /end-session, then pick ${REQUESTED_NAME}. (Sessions end on their own after 1 hour.)`

test('a live row on the locked model is deleted, then the pick is re-POSTed', async () => {
  const held = heldActive(LOCKED_MODEL)
  const { calls, deps } = takeoverHarness(held)

  expect(await runModelLockedTakeover(PICKED_MODEL, LOCKED_MODEL, deps)).toBe(
    'repick',
  )
  expect(calls.released).toEqual([held])
  expect(calls.notices).toEqual([ENDED_EXACT])
})

test('an ended row still inside the grace window is released, not reported as a failed end', async () => {
  const held: FreebuffSessionServerResponse = {
    status: 'ended',
    instanceId: 'inst-held',
  }
  const { calls, deps } = takeoverHarness(held)

  expect(await runModelLockedTakeover(PICKED_MODEL, LOCKED_MODEL, deps)).toBe(
    'repick',
  )
  expect(calls.released).toEqual([held])
  expect(calls.notices).toEqual([ENDED_EXACT])
})

test('a row that is already gone re-POSTs the pick and claims no failed end (#1298)', async () => {
  const { calls, deps } = takeoverHarness({ status: 'none' })

  expect(await runModelLockedTakeover(PICKED_MODEL, LOCKED_MODEL, deps)).toBe(
    'repick',
  )
  expect(calls.reads).toBe(1)
  expect(calls.released).toEqual([])
  expect(calls.notices).toEqual([])
})

test('an ended row past its grace window has nothing to end: re-POST in silence', async () => {
  const { calls, deps } = takeoverHarness({ status: 'ended' })

  expect(await runModelLockedTakeover(PICKED_MODEL, LOCKED_MODEL, deps)).toBe(
    'repick',
  )
  expect(calls.released).toEqual([])
  expect(calls.notices).toEqual([])
})

test('a row belonging to another model is never deleted and explains the revert', async () => {
  const { calls, deps } = takeoverHarness(heldActive('other/vendor-model'))

  expect(await runModelLockedTakeover(PICKED_MODEL, LOCKED_MODEL, deps)).toBe(
    'revert',
  )
  expect(calls.released).toEqual([])
  expect(calls.notices).toEqual([FAILED_END_EXACT])
})

test('a row under a status the lock cannot attribute explains rather than being deleted', async () => {
  const { calls, deps } = takeoverHarness({ status: 'superseded' })

  expect(await runModelLockedTakeover(PICKED_MODEL, LOCKED_MODEL, deps)).toBe(
    'revert',
  )
  expect(calls.reads).toBe(1)
  expect(calls.released).toEqual([])
  expect(calls.notices).toEqual([FAILED_END_EXACT])
})

test('a read that throws explains instead of reverting in silence', async () => {
  const { calls, deps } = takeoverHarness(new Error('offline'))

  expect(await runModelLockedTakeover(PICKED_MODEL, LOCKED_MODEL, deps)).toBe(
    'revert',
  )
  expect(calls.released).toEqual([])
  expect(calls.notices).toEqual([FAILED_END_EXACT])
})

test('a refused delete explains and does not re-POST the pick', async () => {
  const { calls, deps } = takeoverHarness(heldActive(LOCKED_MODEL), {
    deleteRefused: true,
  })

  expect(await runModelLockedTakeover(PICKED_MODEL, LOCKED_MODEL, deps)).toBe(
    'revert',
  )
  expect(calls.notices).toEqual([FAILED_END_EXACT])
})

test('a tick that lost the loop mid-read deletes nothing and says nothing', async () => {
  const { calls, deps } = takeoverHarness(heldActive(LOCKED_MODEL), {
    isStale: () => true,
  })

  expect(await runModelLockedTakeover(PICKED_MODEL, LOCKED_MODEL, deps)).toBe(
    'stale',
  )
  expect(calls.reads).toBe(1)
  expect(calls.released).toEqual([])
  expect(calls.notices).toEqual([])
})

test('a background rejoin hitting the lock reverts in silence, without reading the server', async () => {
  const { calls, deps } = takeoverHarness(heldActive(LOCKED_MODEL))

  expect(await runModelLockedTakeover(null, LOCKED_MODEL, deps)).toBe('revert')
  expect(calls.reads).toBe(0)
  expect(calls.released).toEqual([])
  expect(calls.notices).toEqual([])
})

test('a pick naming the locked model itself takes over nothing', async () => {
  const { calls, deps } = takeoverHarness(heldActive(LOCKED_MODEL))

  expect(await runModelLockedTakeover(LOCKED_MODEL, LOCKED_MODEL, deps)).toBe(
    'revert',
  )
  expect(calls.reads).toBe(0)
  expect(calls.notices).toEqual([])
})

test('the explicit-pick marker annotates exactly one response', () => {
  takeFreebuffExplicitPick()
  noteFreebuffExplicitPick(PICKED_MODEL)
  expect(takeFreebuffExplicitPick()).toBe(PICKED_MODEL)
  expect(takeFreebuffExplicitPick()).toBeNull()
})

test('a lock that races back after the retry reverts instead of looping', async () => {
  // Driven by the real marker: the tick reads it through
  // `takeFreebuffExplicitPick`, so the re-POST a retry produces arrives with
  // nothing left to take over.
  takeFreebuffExplicitPick()
  noteFreebuffExplicitPick(PICKED_MODEL)
  const { calls, deps } = takeoverHarness({ status: 'none' })
  const outcomes: ModelLockedTakeoverOutcome[] = []
  for (let round = 0; round < 5; round += 1) {
    const outcome = await runModelLockedTakeover(
      takeFreebuffExplicitPick(),
      LOCKED_MODEL,
      deps,
    )
    outcomes.push(outcome)
    if (outcome === 'revert') break
  }

  expect(outcomes).toEqual(['repick', 'revert'])
  expect(calls.reads).toBe(1)
  expect(calls.notices).toEqual([])
})
