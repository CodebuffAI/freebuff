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

/**
 * The phone match key: the digits of the number only (`+1 (555) 123-4567` ->
 * `15551234567`, the E.164 number without its `+`), unsalted SHA-256. A value
 * with fewer than 7 or more than 15 digits (E.164's limit) is not a phone
 * number and gets no key. Server use only; the raw number is never logged.
 */
export function hashMatchingPhone(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const digits = value.replace(/\D+/g, '')
  if (digits.length < 7 || digits.length > 15) return undefined
  return createHash('sha256').update(digits).digest('hex')
}
