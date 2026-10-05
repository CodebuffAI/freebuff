import { describe, expect, test } from 'bun:test'
import {
  actionForEvent,
  adjustmentRevokes,
  expectedSignature,
  idsFromEvent,
  isTransactionId,
  licenseCodeFromEvent,
  parseSignatureHeader,
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
  test('is deterministic and body/event dependent', async () => {
    const a = await expectedSignature(
      'transaction.completed',
      '{"a":1}',
      SECRET,
    )
    const b = await expectedSignature(
      'transaction.completed',
      '{"a":1}',
      SECRET,
    )
    const otherEvent = await expectedSignature(
      'adjustment.created',
      '{"a":1}',
      SECRET,
    )
    const otherBody = await expectedSignature(
      'transaction.completed',
      '{"a":2}',
      SECRET,
    )
    const otherSecret = await expectedSignature(
      'transaction.completed',
      '{"a":1}',
      'other',
    )
    expect(a).toBe(b)
    expect(a).not.toBe(otherEvent)
    expect(a).not.toBe(otherBody)
    expect(a).not.toBe(otherSecret)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('actionForEvent', () => {
  test('activates on a completed transaction', () => {
    expect(actionForEvent('transaction.completed')).toBe('activate')
  })

  test('revokes on adjustments', () => {
    // Refunds and chargebacks both arrive as `adjustment.created`; the
    // `action` field decides, see `adjustmentRevokes`.
    expect(actionForEvent('adjustment.created')).toBe('revoke')
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
  test('revokes on refund and chargeback', () => {
    expect(adjustmentRevokes('refund')).toBe(true)
    expect(adjustmentRevokes('chargeback')).toBe(true)
  })

  test('does not revoke on credits, warnings or reversals', () => {
    for (const action of [
      'credit',
      'credit_reverse',
      'chargeback_warning',
      'chargeback_warning_reverse',
      'chargeback_reverse',
    ]) {
      expect(adjustmentRevokes(action)).toBe(false)
    }
  })

  test('fails safe on an unknown or missing action', () => {
    // An action we do not understand must never revoke a live license.
    expect(adjustmentRevokes(undefined)).toBe(false)
    expect(adjustmentRevokes('')).toBe(false)
    expect(adjustmentRevokes('some_future_action')).toBe(false)
    expect(adjustmentRevokes(42)).toBe(false)
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
