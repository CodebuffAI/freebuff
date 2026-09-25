/** Provider billing failures observed from CrofAI, OpenRouter, and similar APIs. */
export const FREEBUFF_PROVIDER_USAGE_ERROR_PATTERN =
  /\b(?:(?:not enough|insufficient|out of)\s+credits?|(?:add|refill|top up)\s+(?:more\s+)?credits?)\b/i

/** Shared copy keeps every Freebuff surface clear that the user is not billed. */
export const FREEBUFF_PROVIDER_USAGE_MESSAGE =
  'Freebuff ran out of provider usage and needs a refill. This is on us, not your account.'

/** Legacy older-server refusal, retained by SDK/CLI/Web recovery handlers.
 * Current servers no longer emit this spend cutoff. */
export const FREEBUFF_TURN_SPEND_LIMIT_ERROR_CODE = 'turn_spend_limit'

export const FREEBUFF_TURN_SPEND_LIMIT_MESSAGE =
  'This turn reached its model usage limit. Your session is still available — send a new message to continue from here.'

/**
 * DeepSeek's platform content filter: HTTP 400 `invalid_request_error`,
 * "Content Exists Risk (request_id: …)". Applied upstream of every V4.1 Flash
 * lane — Luminal returns the identical body — so no divert escapes it, and
 * because clients re-send the whole history, a conversation that trips it
 * keeps tripping it on DeepSeek.
 */
export const FREEBUFF_PROVIDER_CONTENT_FILTER_ERROR_PATTERN =
  /\bcontent exists risk\b/i

/** Says what to DO: the raw string reads like our bug, and the same request
 *  will be refused again, so the only way forward is a different model. */
export const FREEBUFF_PROVIDER_CONTENT_FILTER_MESSAGE =
  "DeepSeek's provider declined this request (content filter). Retrying on DeepSeek will be declined again, since the whole conversation is re-sent. Try again with another model, e.g. GLM 5.3 Flash or MiMo."
