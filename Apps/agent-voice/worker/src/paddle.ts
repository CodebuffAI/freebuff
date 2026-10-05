/** Paddle webhook verification and event handling.
 *
 * Paddle signs each webhook with HMAC-SHA256 over
 * `"<unix timestamp>:<raw request body>"` and sends
 * `Paddle-Signature: ts=<unix>;h1=<hex digest>`. The raw body must be
 * verified *before* parsing it, and any whitespace change breaks the
 * signature. See https://developer.paddle.com/webhooks/signature-verification
 *
 * Paddle does not send an event-type header: the event type is a field inside
 * the payload (`event_type`), so it can only be read after the body verifies.
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

/** The exact bytes Paddle signs: `<timestamp>:<raw body>`. */
export function signingPayload(timestamp: string, body: string): string {
  return `${timestamp}:${body}`
}

export async function expectedSignature(
  timestamp: string,
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
    new TextEncoder().encode(signingPayload(timestamp, body)) as BufferSource,
  )
  return toHex(mac)
}

/**
 * Timing-safe equality for two hex digests. `crypto.subtle.verify` would be
 * the usual choice, but it needs the algorithm and key again here; a fixed
 * comparison of equal-length hex is sufficient and avoids leaking early.
 */
export function signaturesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Reject a signature whose timestamp is too far from now.
 *
 * Paddle's own SDKs use five seconds. Deliveries are retried with a fresh
 * timestamp and every action here is idempotent, so this is a replay
 * *guard* rather than a correctness guarantee — hence a generous window.
 */
export const SIGNATURE_TOLERANCE_SECONDS = 300

export function timestampIsFresh(
  timestamp: string,
  nowSeconds: number,
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
): boolean {
  const parsed = Number.parseInt(timestamp, 10)
  if (!Number.isFinite(parsed)) return false
  return Math.abs(nowSeconds - parsed) <= toleranceSeconds
}

export type LicenseAction = 'activate' | 'revoke' | 'ignore'

/** Is this event an adjustment (refund / credit / chargeback) notification? */
export function isAdjustmentEvent(eventType: string): boolean {
  return (
    eventType === 'adjustment.created' || eventType === 'adjustment.updated'
  )
}

/**
 * Paddle Billing has no license keys — the license *is* the paid transaction,
 * so the transaction id (`txn_…`) is the code the customer holds and the key
 * every record is filed under.
 *
 * Refunds and chargebacks do not have their own events either: Paddle emits
 * `adjustment.created` / `adjustment.updated` whose `action` distinguishes
 * them and whose `status` says whether the decision is final.
 */
export function actionForEvent(eventType: string): LicenseAction {
  switch (eventType) {
    case 'transaction.completed':
      return 'activate'
    case 'adjustment.created':
    case 'adjustment.updated':
      return 'revoke'
    default:
      return 'ignore'
  }
}

/**
 * `adjustment` actions that actually take the money back.
 *
 * Deliberately an allowlist: Paddle also emits credits, reversals and
 * chargeback *warnings*, and an action we do not recognise must never cost a
 * paying customer their license. `chargeback_reverse` (a dispute we won) is
 * the one reversal that should re-activate, which is handled by
 * [`adjustmentRestores`] rather than guessed at here.
 */
const REVOKING_ADJUSTMENTS = new Set(['refund', 'chargeback'])

/** Paddle only considers a refund final once it is approved. */
const APPROVED = 'approved'

/**
 * Does this adjustment mean the customer no longer paid?
 *
 * A refund starts at `pending_approval`, so revoking on `created` alone would
 * strip Pro from a paying customer while Paddle still had the refund under
 * review — and if Paddle then *rejects* it, nothing would put the license
 * back. Only a final `approved` status revokes.
 */
export function adjustmentRevokes(action: unknown, status: unknown): boolean {
  return (
    typeof action === 'string' &&
    REVOKING_ADJUSTMENTS.has(action) &&
    status === APPROVED
  )
}

/**
 * A previously-pending refund or chargeback was `rejected`, so no money moved
 * and a license revoked in the meantime should come back.
 */
export function adjustmentRestores(status: unknown): boolean {
  return status === 'rejected'
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
    /** `adjustment.*` only. */
    action?: string
    /** `pending_approval` | `approved` | `rejected`. */
    status?: string
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
