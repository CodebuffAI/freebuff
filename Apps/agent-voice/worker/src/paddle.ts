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

/** Map a Paddle event type onto a license operation. */
export function actionForEvent(eventType: string): LicenseAction {
  switch (eventType) {
    case 'license_key_created':
    case 'license_key_activated':
      return 'activate'
    case 'license_key_revoked':
    case 'license_key_refunded':
    case 'transaction.refunded':
    case 'transaction.chargeback':
    case 'transaction.dispute.created':
      return 'revoke'
    default:
      return 'ignore'
  }
}

export interface PaddleWebhookPayload {
  event_type?: string
  data?: {
    id?: string
    license_key?: { id?: string; key?: string }
    transaction_id?: string
    custom_data?: Record<string, string>
  }
}

/** Pull the license key out of a webhook body, if the event carries one. */
export function licenseKeyFromEvent(
  payload: PaddleWebhookPayload,
): string | null {
  const key = payload.data?.license_key?.key
  return key && key.trim().length > 0 ? key.trim() : null
}

export interface PaddleEventIds {
  licenseId?: string
  transactionId?: string
}

export function idsFromEvent(payload: PaddleWebhookPayload): PaddleEventIds {
  return {
    licenseId: payload.data?.license_key?.id,
    transactionId: payload.data?.id ?? payload.data?.transaction_id,
  }
}
