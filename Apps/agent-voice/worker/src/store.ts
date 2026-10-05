/** KV-backed license store and rate limiting.
 *
 * Everything is keyed off the Paddle transaction id: Paddle mints it, hands it
 * back on the `transaction.completed` webhook, and it is the only thing a client
 * can present that the worker did not mint itself.
 */

export interface LicenseRecord {
  /** `active` grants Pro; `revoked` (refund/chargeback) does not. */
  status: 'active' | 'revoked'
  /** Device ids currently allowed to use this code. */
  devices: string[]
  /** Paddle ids, kept for support and audit. */
  paddleTransactionId?: string
  paddleAdjustmentId?: string
  createdAt: number
  updatedAt: number
}

/** A license can be active on at most this many machines. */
export const MAX_DEVICES_PER_LICENSE = 3

/** Fixed-window rate limit for activation attempts, per client IP. */
export const RATE_LIMIT_MAX = 20
export const RATE_LIMIT_WINDOW_SECONDS = 600

export interface KVLike {
  get(key: string, type?: 'text'): Promise<string | null>
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>
  delete(key: string): Promise<void>
  list(options?: { prefix?: string }): Promise<{ keys: { name: string }[] }>
}

const LICENSE_PREFIX = 'license:'

/** KV key for a license code (a Paddle transaction id). */
export function licenseRecordKey(code: string): string {
  return `${LICENSE_PREFIX}${code}`
}

export async function getLicense(
  kv: KVLike,
  code: string,
): Promise<LicenseRecord | null> {
  const raw = await kv.get(licenseRecordKey(code))
  if (!raw) return null
  try {
    return JSON.parse(raw) as LicenseRecord
  } catch {
    return null
  }
}

export async function putLicense(
  kv: KVLike,
  code: string,
  record: LicenseRecord,
): Promise<void> {
  await kv.put(licenseRecordKey(code), JSON.stringify(record))
}

/** Record a paid transaction as an active license (idempotent). */
export async function activateLicense(
  kv: KVLike,
  code: string,
  nowSeconds: number,
  paddle: { adjustmentId?: string; transactionId?: string } = {},
): Promise<LicenseRecord> {
  const existing = await getLicense(kv, code)
  const record: LicenseRecord = {
    status: 'active',
    // Refunds clear the device list, so a re-purchase starts clean.
    devices: existing?.status === 'active' ? existing.devices : [],
    paddleTransactionId: paddle.transactionId ?? existing?.paddleTransactionId,
    paddleAdjustmentId: paddle.adjustmentId ?? existing?.paddleAdjustmentId,
    createdAt: existing?.createdAt ?? nowSeconds,
    updatedAt: nowSeconds,
  }
  await putLicense(kv, code, record)
  return record
}

/** Revoke a license and forget its devices (refund or chargeback). */
export async function revokeLicense(
  kv: KVLike,
  code: string,
  nowSeconds: number,
): Promise<LicenseRecord | null> {
  const existing = await getLicense(kv, code)
  if (!existing) return null
  const record: LicenseRecord = {
    ...existing,
    status: 'revoked',
    devices: [],
    updatedAt: nowSeconds,
  }
  await putLicense(kv, code, record)
  return record
}

/** Release one device slot. Unknown codes and devices are a no-op. */
export async function releaseDevice(
  kv: KVLike,
  code: string,
  deviceId: string,
  nowSeconds: number,
): Promise<boolean> {
  const existing = await getLicense(kv, code)
  if (!existing || !existing.devices.includes(deviceId)) return false
  await putLicense(kv, code, {
    ...existing,
    devices: existing.devices.filter((d) => d !== deviceId),
    updatedAt: nowSeconds,
  })
  return true
}

/**
 * Claim a device slot for a license, persisting the new device list.
 *
 * Returns `true` when the device may use the license, `false` when every slot
 * is already taken by other machines.
 */
export async function claimDevice(
  kv: KVLike,
  code: string,
  record: LicenseRecord,
  deviceId: string,
  nowSeconds: number,
): Promise<boolean> {
  if (record.devices.includes(deviceId)) return true
  if (record.devices.length >= MAX_DEVICES_PER_LICENSE) return false
  await putLicense(kv, code, {
    ...record,
    devices: [...record.devices, deviceId],
    updatedAt: nowSeconds,
  })
  return true
}

// ------------------------------------------------------------ rate limiting --

/**
 * Best-effort fixed-window limiter.
 *
 * KV is eventually consistent, so this throttles casual abuse rather than
 * guaranteeing an exact count; a Durable Object is the upgrade path if the
 * endpoint ever becomes a target.
 */
export async function isRateLimited(
  kv: KVLike,
  clientId: string,
  nowSeconds: number,
  max = RATE_LIMIT_MAX,
  windowSeconds = RATE_LIMIT_WINDOW_SECONDS,
): Promise<boolean> {
  const window = Math.floor(nowSeconds / windowSeconds)
  const key = `ratelimit:${clientId}:${window}`
  const current = Number.parseInt((await kv.get(key)) ?? '0', 10)
  if (Number.isFinite(current) && current >= max) return true
  await kv.put(key, String((Number.isFinite(current) ? current : 0) + 1), {
    expirationTtl: windowSeconds * 2,
  })
  return false
}
