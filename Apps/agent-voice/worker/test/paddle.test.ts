import { describe, expect, test } from 'bun:test'
import {
  SIGNATURE_TOLERANCE_SECONDS,
  actionForEvent,
  adjustmentRestores,
  adjustmentRevokes,
  expectedSignature,
  idsFromEvent,
  isAdjustmentEvent,
  isTransactionId,
  licenseCodeFromEvent,
  parseSignatureHeader,
  signaturesMatch,
  signingPayload,
  timestampIsFresh,
  type PaddleWebhookPayload,
} from '../src/paddle'

const SECRET = 'whsec_test'
/** Shape of a real Paddle transaction id: `txn_` + 26 base32 chars. */
const TXN = 'txn_01m45q62gzqns1n98dwp38038q'

describe('parseSignatureHeader', () => {
  test('reads ts and h1', () => {
    expect(parseSignatureHeader('ts=1700000000;h1=abc123')).toEqual({
      ts: '1700000000',
      h1: 'abc123',
    })
  })

  test('rejects incomplete headers', () => {
    expect(parseSignatureHeader('')).toBeNull()
    expect(parseSignatureHeader('ts=1')).toBeNull()
    expect(parseSignatureHeader('h1=abc')).toBeNull()
  })
})

describe('expectedSignature', () => {
  test('signs `<timestamp>:<raw body>` exactly as Paddle documents', async () => {
    const a = await expectedSignature('1700000000', '{"a":1}', SECRET)
    const b = await expectedSignature('1700000000', '{"a":1}', SECRET)
    const otherTs = await expectedSignature('1700000001', '{"a":1}', SECRET)
    const otherBody = await expectedSignature('1700000000', '{"a":2}', SECRET)
    const otherSecret = await expectedSignature(
      '1700000000',
      '{"a":1}',
      'other',
    )
    expect(a).toBe(b)
    expect(a).not.toBe(otherTs)
    expect(a).not.toBe(otherBody)
    expect(a).not.toBe(otherSecret)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  test('the signed payload is the timestamp, a colon and the raw body', () => {
    expect(signingPayload('1700000000', '{"a":1}')).toBe('1700000000:{"a":1}')
    // Any whitespace change must therefore change the signature.
    expect(signingPayload('1', '{ "a": 1 }')).not.toBe(
      signingPayload('1', '{"a":1}'),
    )
  })
})

describe('signaturesMatch', () => {
  test('compares equal-length digests without leaking length', () => {
    expect(signaturesMatch('abc123', 'abc123')).toBe(true)
    expect(signaturesMatch('abc123', 'abc124')).toBe(false)
    expect(signaturesMatch('abc', 'abcd')).toBe(false)
    expect(signaturesMatch('', '')).toBe(true)
  })
})

describe('timestampIsFresh', () => {
  test('accepts a timestamp inside the tolerance', () => {
    const now = 1_700_000_000
    expect(timestampIsFresh('1700000000', now)).toBe(true)
    expect(timestampIsFresh('1700000299', now)).toBe(true)
    expect(timestampIsFresh('1699999701', now)).toBe(true)
    expect(timestampIsFresh('1700000301', now)).toBe(false)
    expect(timestampIsFresh('1699999699', now)).toBe(false)
  })

  test('rejects garbage', () => {
    expect(timestampIsFresh('', 1_700_000_000)).toBe(false)
    expect(timestampIsFresh('nope', 1_700_000_000)).toBe(false)
    expect(timestampIsFresh('1700000000', 1_700_000_000, 0)).toBe(true)
  })

  test('tolerance is a documented non-zero window', () => {
    expect(SIGNATURE_TOLERANCE_SECONDS).toBeGreaterThan(0)
  })
})

describe('actionForEvent', () => {
  test('activates on a completed transaction', () => {
    expect(actionForEvent('transaction.completed')).toBe('activate')
  })

  test('revokes on adjustments', () => {
    // Refunds and chargebacks arrive as adjustments; `status` decides, see
    // `adjustmentRevokes`.
    expect(actionForEvent('adjustment.created')).toBe('revoke')
    expect(actionForEvent('adjustment.updated')).toBe('revoke')
  })

  test('recognises adjustment events', () => {
    expect(isAdjustmentEvent('adjustment.created')).toBe(true)
    expect(isAdjustmentEvent('adjustment.updated')).toBe(true)
    expect(isAdjustmentEvent('transaction.completed')).toBe(false)
    expect(isAdjustmentEvent('')).toBe(false)
  })

  test('ignores unrelated events', () => {
    for (const event of [
      'subscription.created',
      'transaction.created',
      'transaction.paid',
      'transaction.updated',
      '',
    ]) {
      expect(actionForEvent(event)).toBe('ignore')
    }
  })
})

describe('adjustmentRevokes', () => {
  test('revokes a refund or chargeback only once Paddle approves it', () => {
    expect(adjustmentRevokes('refund', 'approved')).toBe(true)
    expect(adjustmentRevokes('chargeback', 'approved')).toBe(true)
  })

  test('does not revoke while an adjustment is pending approval', () => {
    // Revoking here would strip Pro from a paying customer under review.
    expect(adjustmentRevokes('refund', 'pending_approval')).toBe(false)
    expect(adjustmentRevokes('chargeback', 'pending_approval')).toBe(false)
  })

  test('does not revoke on credits, warnings or reversals', () => {
    for (const action of [
      'credit',
      'credit_reverse',
      'chargeback_warning',
      'chargeback_warning_reverse',
      'chargeback_reverse',
    ]) {
      expect(adjustmentRevokes(action, 'approved')).toBe(false)
    }
  })

  test('fails safe on an unknown action or status', () => {
    // Anything we do not understand must never revoke a live license.
    expect(adjustmentRevokes('refund', undefined)).toBe(false)
    expect(adjustmentRevokes('refund', 'approved_rejected')).toBe(false)
    expect(adjustmentRevokes('some_future_action', 'approved')).toBe(false)
    expect(adjustmentRevokes(undefined, 'approved')).toBe(false)
    expect(adjustmentRevokes(42, 'approved')).toBe(false)
  })
})

describe('adjustmentRestores', () => {
  test('restores only when Paddle rejects the adjustment', () => {
    expect(adjustmentRestores('rejected')).toBe(true)
    for (const status of ['pending_approval', 'approved', undefined, '']) {
      expect(adjustmentRestores(status)).toBe(false)
    }
  })
})

describe('isTransactionId', () => {
  test('accepts only the Paddle transaction id shape', () => {
    expect(isTransactionId(TXN)).toBe(true)
    for (const bad of [
      'txn_short',
      'PA-1234-ABCD',
      'pri_01m45q62gzqns1n98dwp38038q',
      'txn_01M45Q62GZQNS1N98DWP38038Q',
      '',
      null,
      undefined,
    ]) {
      expect(isTransactionId(bad)).toBe(false)
    }
  })
})

describe('payload parsing', () => {
  const transaction: PaddleWebhookPayload = {
    event_type: 'transaction.completed',
    data: { id: TXN, custom_data: { device_id: 'device-1' } },
  }
  const adjustment: PaddleWebhookPayload = {
    event_type: 'adjustment.created',
    data: {
      id: 'adj_01m45q62gzqns1n98dwp38038q',
      action: 'refund',
      transaction_id: TXN,
    },
  }

  test('reads the license code off a transaction event', () => {
    expect(licenseCodeFromEvent(transaction)).toBe(TXN)
  })

  test('reads the license code off an adjustment', () => {
    expect(licenseCodeFromEvent(adjustment)).toBe(TXN)
  })

  test('refuses ids that are not transactions', () => {
    expect(
      licenseCodeFromEvent({ data: { id: 'adj_01m45q62gzqns1n98dwp38038q' } }),
    ).toBeNull()
    expect(licenseCodeFromEvent({ data: { id: 'PA-ABCD-1234' } })).toBeNull()
    expect(licenseCodeFromEvent({})).toBeNull()
  })

  test('extracts paddle ids', () => {
    expect(idsFromEvent(transaction)).toEqual({
      eventId: TXN,
      adjustmentId: undefined,
      transactionId: TXN,
    })
    expect(idsFromEvent(adjustment)).toEqual({
      eventId: 'adj_01m45q62gzqns1n98dwp38038q',
      adjustmentId: 'adj_01m45q62gzqns1n98dwp38038q',
      transactionId: TXN,
    })
  })
})
