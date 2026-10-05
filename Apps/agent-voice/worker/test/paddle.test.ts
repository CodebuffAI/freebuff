import { describe, expect, test } from 'bun:test'
import {
  actionForEvent,
  expectedSignature,
  idsFromEvent,
  licenseKeyFromEvent,
  parseSignatureHeader,
  type PaddleWebhookPayload,
} from '../src/paddle'

const SECRET = 'whsec_test'

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
      'license_key_activated',
      '{"a":1}',
      SECRET,
    )
    const b = await expectedSignature(
      'license_key_activated',
      '{"a":1}',
      SECRET,
    )
    const otherEvent = await expectedSignature(
      'license_key_refunded',
      '{"a":1}',
      SECRET,
    )
    const otherBody = await expectedSignature(
      'license_key_activated',
      '{"a":2}',
      SECRET,
    )
    const otherSecret = await expectedSignature(
      'license_key_activated',
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
  test('activates on license issuance', () => {
    expect(actionForEvent('license_key_created')).toBe('activate')
    expect(actionForEvent('license_key_activated')).toBe('activate')
  })

  test('revokes on refund, chargeback and dispute', () => {
    for (const event of [
      'license_key_revoked',
      'license_key_refunded',
      'transaction.refunded',
      'transaction.chargeback',
      'transaction.dispute.created',
    ]) {
      expect(actionForEvent(event)).toBe('revoke')
    }
  })

  test('ignores unrelated events', () => {
    expect(actionForEvent('subscription.created')).toBe('ignore')
    expect(actionForEvent('')).toBe('ignore')
  })
})

describe('payload parsing', () => {
  const payload: PaddleWebhookPayload = {
    event_type: 'license_key_created',
    data: {
      id: 'txn_123',
      license_key: { id: 'lic_123', key: '  PA-ABCD-1234  ' },
      transaction_id: 'txn_123',
    },
  }

  test('extracts and trims the license key', () => {
    expect(licenseKeyFromEvent(payload)).toBe('PA-ABCD-1234')
    expect(
      licenseKeyFromEvent({ data: { license_key: { key: '   ' } } }),
    ).toBeNull()
    expect(licenseKeyFromEvent({})).toBeNull()
  })

  test('extracts paddle ids', () => {
    expect(idsFromEvent(payload)).toEqual({
      licenseId: 'lic_123',
      transactionId: 'txn_123',
    })
  })
})
