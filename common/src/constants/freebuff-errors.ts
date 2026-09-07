/** Provider billing failures observed from CrofAI, OpenRouter, and similar APIs. */
export const FREEBUFF_PROVIDER_USAGE_ERROR_PATTERN =
  /\b(?:(?:not enough|insufficient|out of)\s+credits?|(?:add|refill|top up)\s+(?:more\s+)?credits?)\b/i

/** Shared copy keeps every Freebuff surface clear that the user is not billed. */
export const FREEBUFF_PROVIDER_USAGE_MESSAGE =
  'Freebuff ran out of provider usage and needs a refill. This is on us, not your account.'

/**
 * The completions API's per-turn spend breaker (web/src/app/api/v1/chat/
 * completions/_post.ts, packages/billing/src/freebuff-turn-spend.ts): a 429
 * whose body is `{ error: 'turn_spend_limit', message }`. It is not transient
 * — the same turn is refused again on every retry, because
 * its spend only ever grows — so every client stops retrying on sight and
 * shows the message as-is. A NEW message starts a new turn with a fresh
 * budget, which is what the copy says.
 */
export const FREEBUFF_TURN_SPEND_LIMIT_ERROR_CODE = 'turn_spend_limit'

export const FREEBUFF_TURN_SPEND_LIMIT_MESSAGE =
  'This turn reached its model usage limit. Your session is still available — send a new message to continue from here.'
