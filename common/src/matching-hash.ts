import { createHash } from 'node:crypto'

/**
 * The one email normalization every vendor documents for its hashed match key
 * (Meta `em`, TikTok `email`, X `hashed_email`): trim, lowercase, unsalted
 * SHA-256. Server use only; the raw address is never stored or logged.
 */
export function hashMatchingEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const email = value.trim().toLowerCase()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return undefined
  return createHash('sha256').update(email).digest('hex')
}
