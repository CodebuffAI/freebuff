import { describe, expect, test } from 'bun:test'

import { describeRefusal } from '../freebuff-session'

import type { FreebuffSessionServerResponse } from '@codebuff/common/types/freebuff-session'

/** Refusals are the one part of admission that needs no network, and the part
 *  a user reads: each must say what to do next, not just that it failed. */
describe('ACP admission refusals', () => {
  test('a rate limit names the reset window and the alternative', () => {
    const message = describeRefusal({
      status: 'rate_limited',
    } as FreebuffSessionServerResponse)
    expect(message).toContain('session limit')
    expect(message).toContain('daily hours')
    expect(message).toContain('another model')
  })

  test('a suspension points at the standing page', () => {
    const message = describeRefusal({
      status: 'banned',
    } as FreebuffSessionServerResponse)
    expect(message).toContain('account?tab=standing')
  })

  test('a locked session says how to release it', () => {
    const message = describeRefusal({
      status: 'model_locked',
    } as FreebuffSessionServerResponse)
    expect(message).toContain('Freebuff Desktop')
  })

  test('every concurrent-slot refusal explains the limit', () => {
    const statuses = [
      'premium_slot_taken',
      'purchase_in_use',
      'purchase_capacity',
    ] as const
    for (const status of statuses) {
      expect(
        describeRefusal({ status } as FreebuffSessionServerResponse),
      ).toContain('concurrent Freebuff session limit')
    }
  })

  test('an unhandled status still names the status it saw', () => {
    const message = describeRefusal({
      status: 'none',
    } as FreebuffSessionServerResponse)
    expect(message).toContain('none')
  })
})
