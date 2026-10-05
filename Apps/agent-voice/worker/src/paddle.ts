/** Paddle webhook verification and event handling.
 *
 * Paddle signs each webhook with HMAC-SHA256 over
 * `"<Paddle-Event-Type>:<body>"` and sends the digest in `Paddle-Signature`.
 */

export interface PaddleSignatureHeader {
  /** `ts=<unix>;h1=<hex digest>` */
  ts: string
  h1: string
}

export function parseSignatureHeader(
  header: string,
): PaddleSignatureHeader | null {
  const parts = header.split(';')
  const ts = parts.find((p) => p.startsWith('ts='))?.slice(3)
  const h1 = parts.find((p) => p.startsWith('h1='))?.slice(3)
  if (!ts || !h1) return null
  return { ts, h1 }
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function expectedSignature(
  eventType: string,
  body: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${eventType}:${body}`) as BufferSource,
  )
  return toHex(mac)
}

export type LicenseAction = 'activate' | 'revoke' | 'ignore'

/**
 * Paddle Billing has no license keys — the license *is* the paid transaction,
 * so the transaction id (`txn_…`) is the code the customer holds and the key
 * every record is filed under.
 *
 * Refunds and chargebacks do not have their own events either: Paddle emits a
 * single `adjustment.created` whose `action` distinguishes them.
 */
export function actionForEvent(eventType: string): LicenseAction {
  switch (eventType) {
    case 'transaction.completed':
      return 'activate'
    case 'adjustment.created':
      return 'revoke'
    default:
      return 'ignore'
  }
}

/**
 * `adjustment.created` actions that actually take the money back.
 *
 * Deliberately an allowlist: Paddle also emits credits, reversals and
 * chargeback *warnings*, and an action we do not recognise must never cost a
 * paying customer their license. `chargeback_reverse` (a dispute we won) is
 * the one reversal that should re-activate, and reconciliation via the Paddle
 * API is the path for that rather than guessing here.
 */
const REVOKING_ADJUSTMENTS = new Set(['refund', 'chargeback'])

/** Does this adjustment action mean the customer no longer paid? */
export function adjustmentRevokes(action: unknown): boolean {
  return typeof action === 'string' && REVOKING_ADJUSTMENTS.has(action)
}

/** Paddle transaction ids are `txn_` + 26 lowercase base32 characters. */
export const TRANSACTION_ID_PATTERN = /^txn_[a-z0-9]{26}$/

export function isTransactionId(value: unknown): value is string {
  return typeof value === 'string' && TRANSACTION_ID_PATTERN.test(value)
}

export interface PaddleWebhookPayload {
  event_type?: string
  data?: {
    id?: string
    /** `adjustment.created` only. */
    action?: string
    transaction_id?: string
    custom_data?: Record<string, string>
  }
}

/**
 * The license code carried by a webhook body: the transaction id itself for
 * transaction events, or the referenced transaction for adjustments.
 */
export function licenseCodeFromEvent(
  payload: PaddleWebhookPayload,
): string | null {
  if (isTransactionId(payload.data?.id)) return payload.data.id
  if (isTransactionId(payload.data?.transaction_id))
    return payload.data.transaction_id
  return null
}

/** Paddle ids worth keeping for support and audit. */
export interface PaddleEventIds {
  eventId?: string
  adjustmentId?: string
  transactionId?: string
}

export function idsFromEvent(payload: PaddleWebhookPayload): PaddleEventIds {
  const isAdjustment = payload.event_type === 'adjustment.created'
  return {
    eventId: payload.data?.id,
    adjustmentId: isAdjustment ? payload.data?.id : undefined,
    transactionId: isAdjustment
      ? payload.data?.transaction_id
      : (payload.data?.id ?? payload.data?.transaction_id),
  }
}
