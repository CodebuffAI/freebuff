/**
 * Codebuff shuts down on 2026-12-01. Until then nothing new may be bought:
 * no subscription checkout, no credit purchase (user or organization), no team
 * seat setup, and no auto top-up charge. Existing subscriptions were already
 * scheduled to end by that date in Stripe, and credits already held keep
 * working. Freebuff's own billing (subscriptions, Freebucks, the paid API,
 * advertisers) is separate and unaffected.
 */
export const CODEBUFF_PURCHASES_CLOSED = true

/** The moment Codebuff stops: 2026-12-01 00:00 PT. No subscription runs past it. */
export const CODEBUFF_SHUTDOWN_AT = new Date('2026-12-01T08:00:00Z')

export const CODEBUFF_PURCHASES_CLOSED_MESSAGE =
  'Codebuff is shutting down on December 1, 2026, so new purchases are closed. Freebuff is free: freebuff.com'
