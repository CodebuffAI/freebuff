/**
 * Provider billing failures observed from CrofAI, OpenRouter, and similar APIs.
 *
 * "Purchase credits" is OpenRouter's own newer wording and the only credit
 * phrase in one of its 402 bodies: "Free BYOK request cap exceeded for this
 * month. Purchase credits at https://openrouter.ai/settings/credits". None of
 * the verbs here matched it. Measured while Freebuff's OpenRouter balance sat
 * at zero on 2026-10-14 (17:42:03Z-17:54:39Z): 915 of the window's 2,002 402s
 * carried exactly that sentence, across 10 model ids, and not one of those
 * requests had a user key — so there was no account any of those users could
 * have purchased credits on. It is ours to refill.
 *
 * The reliable signal for this whole class is the status (HTTP 402), which is
 * what a surface should test when it has one; this alternation is for the
 * surfaces that only ever see the body.
 */
export const FREEBUFF_PROVIDER_USAGE_ERROR_PATTERN =
  /\b(?:(?:not enough|insufficient|out of)\s+credits?|(?:add|purchase|refill|top up)\s+(?:more\s+)?credits?)\b/i

/**
 * The Codebuff API's own 402 for a paid (non-free) request names the user's
 * balance page: "Out of credits. Please add credits at
 * https://www.codebuff.com/usage." That is the USER'S account running dry, so it
 * must reach the ordinary out-of-credits flow; it also matches
 * FREEBUFF_PROVIDER_USAGE_ERROR_PATTERN ("add credits"), which told a paying
 * user "this is on us, not your account" (2026-09-26, CLI, lite mode).
 */
export const CODEBUFF_OWN_CREDITS_ERROR_PATTERN = /codebuff\.com\/usage/i

/** Shared copy keeps every Freebuff surface clear that the user is not billed. */
export const FREEBUFF_PROVIDER_USAGE_MESSAGE =
  'Freebuff ran out of provider usage and needs a refill. This is on us, not your account.'

/** Final for the request's turn: the SDK does not retry it. The per-turn spend
 * breaker that introduced it is gone; servers now send it only to a subagent
 * whose research budget is spent (web/.../chat-subagent-budget.ts and
 * free-mode-subagent-budget.ts), which fails that subagent, not the turn. */
export const FREEBUFF_TURN_SPEND_LIMIT_ERROR_CODE = 'turn_spend_limit'

export const FREEBUFF_TURN_SPEND_LIMIT_MESSAGE =
  'This turn reached its model usage limit. Your session is still available — send a new message to continue from here.'

/**
 * Our own per-message usage-policy refusal (the prompt-strike gate on the
 * chat-completions route): HTTP 403 with `{ error, message }`, where
 * `message` is the user-facing text naming the policy category and the
 * account's strike count. Final: no client retries a 403, and the same
 * message is refused again.
 */
export const FREEBUFF_PROMPT_POLICY_REFUSED_ERROR_CODE = 'prompt_policy_refused'

/** The fixed opening of that refusal's `message`: Freebuff Web's chat
 *  shows the message from here on, and never any text before it. */
export const FREEBUFF_PROMPT_POLICY_REFUSED_OPENING =
  'Freebuff did not send this message to the model.'

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

/**
 * OpenAI's cybersecurity safeguard: 403 "This content was flagged for possible
 * cybersecurity risk. If this seems wrong, try rephrasing your request. …
 * apply for Daybreak access …". Seen on GPT-6.1 Sol (2026-09-30). Applied to
 * the request's content, so the same conversation is refused again on retry.
 */
export const FREEBUFF_PROVIDER_CYBER_RISK_ERROR_PATTERN =
  /flagged for possible cybersecurity risk/i

/** Says what happened and what to DO. OpenAI's own text points at an
 *  organization-access form a Freebuff user cannot use, and after a fallback
 *  it used to surface as an unrelated "organization" 401 instead. */
export const FREEBUFF_PROVIDER_CYBER_RISK_MESSAGE =
  "OpenAI declined this request: it was flagged as a possible cybersecurity risk. The same conversation will be declined again, so rephrase the request (for example, say what you are securing and why), or continue with another model such as DeepSeek V4.1 Flash or GLM 5.3 Flash."

/**
 * OpenRouter's upstream-429 template, which every lane behind it reproduces
 * verbatim: "Provider returned error [<Upstream>: <model> is temporarily
 * rate-limited upstream. Please retry shortly, or add your own key to
 * accumulate your rate limits: https://openrouter.ai/settings/integrations]".
 *
 * Both clauses are matched because either one alone identifies the class, and
 * a gateway that re-words one still means the same thing: the upstream is
 * rate-limiting us, not this user.
 *
 * Measured in the 12.3 hours to 2026-10-14T14:51Z: 3,217 requests, 265
 * distinct users, 543 agent runs, on Gemini 4 Argon (Google AI Studio) and
 * MiMo (Xiaomi). **None of them had sent their own provider key**, so the
 * link's advice could not work for a single one of them.
 */
export const FREEBUFF_PROVIDER_UPSTREAM_RATE_LIMIT_ERROR_PATTERN =
  /\brate-limited upstream\b|\badd your own key to accumulate your rate limits\b/i

/**
 * Says whose problem it is and what to DO. The provider's own sentence points
 * at an account page on a gateway the user has no relationship with — the same
 * defect as {@link FREEBUFF_PROVIDER_CYBER_RISK_MESSAGE}'s Daybreak link — and
 * its only advice, "retry shortly", is what a user does for an hour while
 * every attempt is refused for the same reason.
 *
 * Names no model, so it is also correct for a presented (bait) request, where
 * the served model's id may never be shown.
 */
export const FREEBUFF_PROVIDER_UPSTREAM_RATE_LIMIT_MESSAGE =
  'The provider serving this model is rate-limiting requests right now — this is not a problem with your account. Wait a minute and send it again, or continue with another model such as GLM 5.3 Flash or DeepSeek V4.1 Flash.'

/**
 * What a user is told when OUR server could not get a response out of the
 * provider at all — the request timed out before any headers arrived, or the
 * connection was refused or reset.
 *
 * The raw text for this is the runtime's, not a provider's: undici raises
 * `TypeError: fetch failed` (cause `UND_ERR_HEADERS_TIMEOUT`, `ECONNRESET`),
 * and once SSE headers are already flushed it travels to the client in band as
 * "Upstream provider error: fetch failed". Two things were wrong with that:
 *
 * 1. "fetch failed" says nothing a user can act on, and
 * 2. it is one of the phrases `isTransientNetworkError` keys on, so the client
 *    read our upstream timeout as the user's own socket dying and told them to
 *    check their connection and their provider settings — which a free-mode
 *    user does not have. The user report that found this said, in as many
 *    words, "the internet connection is stable".
 *
 * Measured over the 24 hours to 2026-10-14T15:57Z: 19 in-band upstream
 * failures carried "fetch failed", on 19 runs by 19 distinct users, 18 of them
 * in free mode and 18 of them an ~180s headers timeout.
 *
 * Says whose problem it is and what to DO, and names no upstream or served
 * model id, so it is also correct for a presented (bait) request.
 */
export const FREEBUFF_PROVIDER_UNREACHABLE_MESSAGE =
  'Freebuff could not get a response from the provider serving this model — the request timed out or the connection was dropped before any reply arrived. This is not a problem with your internet connection or your account. Send the message again, or continue with another model such as GLM 5.3 Flash or DeepSeek V4.1 Flash.'
