import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { runSponsoredProposalControl } from '../sponsored-proposal-control'

import type { SponsoredProposalControlDeps } from '../sponsored-proposal-control'

/**
 * The two ways a sponsored-proposal control used to fail silently (COD-376).
 *
 * Both look identical to the user on the happy path, which is why they need
 * assertions rather than a reading: the preference write's RESULT has to gate
 * the dismiss, and a control that saved nothing has to report false so the
 * card stays live instead of being marked answered.
 */

const PROPOSAL = {
  proposalId: 'proposal-1',
  advertiserId: 'adv_acme',
  reportSnapshot: {
    title: 'Example offer',
    proposalId: 'proposal-1',
    reason: 'This offer makes a misleading claim.',
  },
}

function deps(
  results: { report?: boolean; dismiss?: boolean; setPrefs?: boolean } = {},
) {
  const calls: string[] = []
  const impl: SponsoredProposalControlDeps = {
    getToken: () => 'tok',
    notify: async () => {
      calls.push('notify')
    },
    report: async () => {
      calls.push('report')
      return results.report ?? true
    },
    dismiss: async () => {
      calls.push('dismiss')
      return results.dismiss ?? true
    },
    setPrefs: async () => {
      calls.push('setPrefs')
      return results.setPrefs ?? true
    },
  }
  return { calls, impl }
}

describe('the preference write gates the dismiss', () => {
  for (const control of ['never-advertiser', 'opt-out'] as const) {
    test(`${control} writes the preference first, then dismisses`, async () => {
      const { calls, impl } = deps()
      expect(
        await runSponsoredProposalControl(control, PROPOSAL, 'tok', impl),
      ).toBe(true)
      expect(calls).toEqual(['setPrefs', 'dismiss'])
    })

    test(`${control} does NOT dismiss when the preference write failed`, async () => {
      // THE BUG. Both calls returned a boolean and both were awaited and
      // thrown away, so a failed preference write was followed by a dismiss
      // that succeeded: the card gone, the refusal never recorded, and the
      // same advertiser back on the next offer — with the user believing they
      // had said no. The ordering only means something if the result is read.
      const { calls, impl } = deps({ setPrefs: false })
      expect(
        await runSponsoredProposalControl(control, PROPOSAL, 'tok', impl),
      ).toBe(false)
      expect(calls).toEqual(['setPrefs'])
    })

    test(`${control} reports false when only the dismiss failed`, async () => {
      // A partial. The preference is the durable half and is safe to repeat,
      // so "try again" is the honest answer rather than a success the card
      // cannot demonstrate.
      const { calls, impl } = deps({ dismiss: false })
      expect(
        await runSponsoredProposalControl(control, PROPOSAL, 'tok', impl),
      ).toBe(false)
      expect(calls).toEqual(['setPrefs', 'dismiss'])
    })
  }
})

describe('the single-call controls report what happened', () => {
  test('an account change before submission prevents both notification and proposal writes', async () => {
    const { calls, impl } = deps()
    impl.getToken = () => 'other-account'
    expect(
      await runSponsoredProposalControl('report', PROPOSAL, 'tok', impl),
    ).toBe(false)
    expect(calls).toEqual([])
  })

  test('an account change during notification prevents the subsequent proposal write', async () => {
    const { calls, impl } = deps()
    let token = 'tok'
    let finish!: () => void
    impl.getToken = () => token
    impl.notify = async () => {
      calls.push('notify')
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    }
    const result = runSponsoredProposalControl('report', PROPOSAL, 'tok', impl)
    token = 'other-account'
    finish()
    expect(await result).toBe(false)
    expect(calls).toEqual(['notify'])
  })

  test('report notifies before updating the proposal', async () => {
    const { calls, impl } = deps()
    expect(
      await runSponsoredProposalControl('report', PROPOSAL, 'tok', impl),
    ).toBe(true)
    expect(calls).toEqual(['notify', 'report'])
  })

  test('failed notifications keep the proposal report retryable', async () => {
    const { calls, impl } = deps()
    impl.notify = async () => {
      throw new Error('offline')
    }
    expect(
      await runSponsoredProposalControl('report', PROPOSAL, 'tok', impl),
    ).toBe(false)
    expect(calls).toEqual([])
  })

  test('missing explanation never notifies or changes the proposal', async () => {
    const { calls, impl } = deps()
    expect(
      await runSponsoredProposalControl(
        'report',
        {
          proposalId: PROPOSAL.proposalId,
          advertiserId: PROPOSAL.advertiserId,
        },
        'tok',
        impl,
      ),
    ).toBe(false)
    expect(calls).toEqual([])
  })

  test('dismiss touches nothing else', async () => {
    const { calls, impl } = deps()
    expect(
      await runSponsoredProposalControl('dismiss', PROPOSAL, 'tok', impl),
    ).toBe(true)
    expect(calls).toEqual(['dismiss'])
  })

  for (const control of ['report', 'dismiss'] as const) {
    test(`a failed ${control} is false, not swallowed`, async () => {
      const { impl } = deps({ report: false, dismiss: false })
      expect(
        await runSponsoredProposalControl(control, PROPOSAL, 'tok', impl),
      ).toBe(false)
    })
  }
})

describe('the caller keeps the card live when nothing was saved', () => {
  // Source-scanned: the handler lives inside the Chat component and cannot be
  // mounted here. What must not come back is `answered: true` in a `finally`,
  // which stands a card's controls down permanently — so a failed control left
  // a card that looked spent, could not be retried, and had saved nothing.
  const chat = readFileSync(
    join(import.meta.dir, '..', '..', 'chat.tsx'),
    'utf8',
  )

  test('answered is conditional on the control having succeeded', () => {
    expect(chat).toContain('succeeded ? { busy: false, answered: true }')
    expect(chat).toContain("Couldn't save that")
  })

  test('the control result is read rather than discarded', () => {
    expect(chat).toContain('succeeded = await runSponsoredProposalControl(')
  })
})

describe('the transport resolves its host through the login constant', () => {
  // Reading `process.env.NEXT_PUBLIC_FREEBUFF_APP_URL` raw skipped both halves
  // of that constant: the @codebuff/common/env schema, and the IS_DEV
  // localhost branch — so a developer's proposal traffic left their laptop for
  // production while every other CLI call stayed on :3002, writing real prefs
  // and real dismissals against their real account from a dev build.
  const api = readFileSync(
    join(import.meta.dir, '..', 'sponsored-proposal-api.ts'),
    'utf8',
  )
  // COMMENTS STRIPPED before matching, the way the disclosure invariant does
  // it: the paragraph explaining why `process.env` is wrong here names it, and
  // an explanation must not fail the assertion it explains.
  const code = api.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  test('imports FREEBUFF_WEB_URL and reads no env var of its own', () => {
    expect(api).toContain(
      "import { FREEBUFF_WEB_URL } from '../login/constants'",
    )
    expect(code).not.toContain('process.env')
  })
})
