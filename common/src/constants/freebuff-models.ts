import {
  addDaysToYmd,
  getUtcForZonedTime,
  getZonedParts,
  type ZonedDateParts,
} from '../util/zoned-time'
import {
  deepSeekExpensiveWindowEndsAt,
  FALLBACK_WINDOW_TIME_ZONE,
  formatDeepSeekExpensiveWindowReturn,
  formatDeepSeekOffPeakWindowLocal,
  formatWindowTimeZoneLabel,
  isDeepSeekExpensiveWindow,
} from './freebuff-peak-hours'
import { mimoModels } from './model-config'
import { SOLAR_REGULAR_OFFER } from './freebuff-solar-promo'
import {
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
  FREEBUFF_MINIMAX_M3_MODEL_ID,
} from './freebuff-model-ids'
import {
  FREEBUFF_AI_TRAINING_NOTICE,
  type FreebuffModelDataUse,
} from './freebuff-data-use'
import {
  FREEBUFF_SOLAR_PRO_4_ENTITLEMENT,
  FREEBUFF_SOLAR_PRO_4_MODEL_ID,
  type FreebuffAccessTier,
} from './freebuff-model-entitlements'
import { clampReasoningEffort, type ReasoningEffort } from './reasoning-effort'

export {
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
  FREEBUFF_MINIMAX_M3_MODEL_ID,
} from './freebuff-model-ids'
export {
  FREEBUFF_SOLAR_PRO_4_MODEL_ID,
  type FreebuffAccessTier,
} from './freebuff-model-entitlements'

/**
 * Models a freebuff user can pick between in the waiting-room model selector.
 *
 * Each model has its own queue (server keys queue position by `model`), so the
 * list here is effectively the set of separate waiting lines. Order is the
 * order shown in the UI.
 */
export interface FreebuffModelOption {
  /** Stable ID used in the wire protocol and DB. Matches the model id passed
   *  to the chat-completions endpoint. */
  id: string
  /** Short label for the selector UI. */
  displayName: string
  /** One-line description shown next to the label. */
  tagline: string
  /** Availability policy for the selector and server-side admission. */
  availability: 'always' | 'deployment_hours' | 'off_peak_only'
  /**
   * Where a pick lands while THIS model is closed by `availability`.
   *
   * Without it an unavailable pick falls to FALLBACK_FREEBUFF_MODEL_ID, which
   * is the unlimited row — correct when a model is gone, wrong when it is
   * merely asleep and a better substitute is awake. V4 Flash closes at peak
   * precisely so its traffic lands on V4 Pro, and a silent detour to MiMo would
   * defeat the whole point of closing it.
   *
   * Advisory, not a guarantee: it is used only when the named model is itself
   * available, so this can never strand a pick on a second closed row.
   */
  unavailableFallback?: string
  /** Optional caveat shown in the picker (e.g. AI-training warning).
   *  Rendered in the warning/secondary color so users spot it before
   *  picking the model. */
  warning?: string
  /** Machine-readable data-use policy. Never infer storage or training
   *  behavior from the human-readable warning text. */
  dataUse: FreebuffModelDataUse
  /** Whether full access meters this model through the shared premium pool. */
  premium: boolean
  /** Whether the model accepts image input. Drives whether uploaded images
   *  are forwarded as real multimodal content vs. dropped/inlined as text. */
  multimodal: boolean
  /** Reasoning effort Freebuff turns run this model at. Not advisory: the
   *  completions layer sends it whenever the caller names no reasoning of its
   *  own (applyFreebuffReasoningDefaults in web/src/llm-api/openrouter.ts),
   *  and the Desktop and CLI pickers display the same field — one source, so
   *  on those surfaces what users see and what the server sends cannot drift.
   *  Omit where the model has no effort levels (MiniMax) or the provider
   *  default should stand untouched (GLM, MiMo). CAUTION: both DeepSeek V4
   *  models expose low/high/max and neither has a distinct medium rung — see
   *  DEEPSEEK_V4_REASONING_EFFORTS. */
  /** Reasoning effort sent for this model, on the PROVIDER's own scale.
   *  Deliberately wider than the shared agent-definition enum: Meta's ladder is
   *  minimal/low/medium/high/xhigh (its own 400 names the set). Not every
   *  provider accepts every rung, so each model still declares its own ladder.
   *
   *  `max` joined this union for GLM 5.3 Flash, whose declared ladder tops out
   *  there and whose previous behaviour (unset) was DEEPER than max — so any
   *  narrower wire default would have been a silent downgrade rather than the
   *  small, deliberate one that row documents. */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /**
   * The ladder a USER may pick from for this model, ascending. Absent means the
   * model offers no choice and shows no control — the default for every row.
   *
   * Same field name and shape as Desktop's `ModelOption.efforts`
   * (freebuff-desktop/src/shared/models.ts), deliberately: Desktop already had
   * per-model effort lists driving its Claude/Codex picker, and one pattern
   * across surfaces beats two that must be kept in step.
   *
   * Values must be native provider settings, not compatibility aliases or
   * prompt approximations. The model's ordinary setting belongs in
   * `defaultEffort`; rungs may sit on either side of it.
   */
  efforts?: readonly ReasoningEffort[]
  /**
   * Where `efforts` starts before a user touches it.
   *
   * Usually equal to `reasoningEffort`, but kept separate so a future model can
   * expose a picker default that differs from its server-owned wire default.
   */
  defaultEffort?: ReasoningEffort
  /** Whether the model is still being trialed and may be unreliable. Surfaced
   *  in the picker as a "TEST" badge with a tooltip so users know it is not
   *  yet production-grade. */
  experimental?: boolean
  /** Tooltip attached to the tagline, for a tagline that names a behavior the
   *  word alone cannot explain (e.g. "Queue"). Rendered with the same
   *  dotted-underline affordance as the data-use "Data" label, so a row can
   *  carry both without growing a second line. */
  taglineTooltip?: string
  /** Freshly released or freshly re-trained. Surfaced as a "NEW" badge so a
   *  returning user notices the model changed rather than assuming it is the
   *  same one they already formed an opinion about. Clear it once the model
   *  stops being news. */
  isNew?: boolean
  /** Set when another model has overtaken this one and users should generally
   *  move. Pickers render `notice` on the row and offer a one-click switch to
   *  `modelId`. Kept structured rather than folded into `warning` so the button
   *  has a real target, and so this stays distinct from the data-use caveat —
   *  a row can carry both. */
  supersededBy?: {
    modelId: string
    notice: string
    actionLabel: string
  }
}

/** Server-facing fallback copy for APIs and provider errors that can't know
 *  the caller's local timezone. The CLI should render
 *  `getFreebuffDeploymentAvailabilityLabel()` instead. */
export const FREEBUFF_DEPLOYMENT_HOURS_LABEL = '9am ET-5pm PT every day'
export const FREEBUFF_GEMINI_PRO_MODEL_ID = 'google/gemini-3.1-pro-preview'
/** Legacy wire id emitted by older freebuff.com/chat deployments. The shared
 *  completions API keeps accepting it, but routes it to DeepSeek direct. New
 *  chat code must use FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID instead. */
export const FREEBUFF_DEEPSEEK_V4_FLASH_FIREWORKS_MODEL_ID =
  'fireworks/deepseek-v4-flash'
// HY3 IS GONE, on every surface and every route (removed 2026-08-07). It left
// Freebuff on 2026-08-04 but its wire ids lived on for paid/BYOK callers via
// web/src/llm-api/hy3-fallback.ts; that file, the Atlas Cloud adapter that was
// its paid lane, and the `tencent/hy3*` model-config entries have all been
// deleted. Nothing routes these slugs now — a request for one falls through to
// the ordinary unknown-model path.
export const FREEBUFF_MIMO_V25_MODEL_ID = mimoModels.mimoV25
/** GLM 5.2, served by CrofAI's direct OpenAI-compatible API (moved off
 *  Fireworks serverless 2026-07-29, at ~4x less than Fireworks' list price).
 *  The `z-ai/` prefix is a wire id inherited from the Fireworks era — nothing
 *  reaches Z.ai; CrofAI receives its native `glm-5.2` id (see CROF_MODEL_MAP).
 *
 *  This is the ONLY GLM 5.2 route. Unlike the other picker models it is NOT
 *  freely available — it is unlocked by referring friends. Each qualified
 *  referral grants one 1-hour GLM session per day, uncapped since 2026-07-30.
 *  Gated by a per-user daily session pool whose limit equals the caller's GLM
 *  referral score (see the free-session quota).
 *
 *  A second wire id (`crof/glm-5.2`) used to reach the same CrofAI upstream on
 *  the ordinary daily PREMIUM pool. It was retired from the pickers 2026-07-30
 *  and deleted outright 2026-08-04: the picker exclusion was client-side only,
 *  so hand-written API callers kept admitting sessions on it and collecting
 *  GLM 5.2 with zero referrals (12-49 distinct accounts/day, mostly known
 *  sock-puppet clusters). Never reintroduce a second wire id for a
 *  entitlement-gated model — the quota pool is chosen by model id, so an extra
 *  id is an extra door. */
export const FREEBUFF_GLM_V52_MODEL_ID = 'z-ai/glm-5.2'
/**
 * GLM 5.3 Flash, served through OpenRouter. The id is OpenRouter's own slug, so
 * it falls through to the default OpenRouter route with no provider-specific
 * handler — the same arrangement as GPT-5.6 Luna and Ox Alpha.
 *
 * NOT a second door onto GLM 5.2. The name and the `z-ai/` prefix are shared,
 * but this is a different model on a different lane and a different pool, and
 * that distinction is load-bearing: 5.2 is the REFERRAL reward metered by
 * FREEBUFF_REWARD_MODEL_IDS, and the whole reason `crof/glm-5.2` had to be
 * deleted (see above) is that a second id for an earned model is a second free
 * entitlement. Every GLM predicate in this file is written against an explicit
 * id list for that reason — none of them prefix-match `z-ai/glm`, and none of
 * them should be rewritten to.
 *
 * PREMIUM AND CAPPED, which is the point of adding it. It replaces DeepSeek V4
 * Pro as the catalog's deep row at a fraction of the price: $0.075 in /
 * $0.015 cache read / $0.25 out per M on the cheap endpoints (Z.ai, NovitaAI,
 * GMICloud, read off OpenRouter 2026-08-26), against Pro's $0.66 / $0.022 /
 * $1.98 off-peak on DeepSeek direct — roughly 8.8x on fresh input and 7.9x on
 * output, and cheaper on the cache reads that dominate an agent turn.
 *
 * Three of the six listed endpoints charge exactly 2x the other three, so the
 * route carries FREEBUFF_GLM_V53_FLASH_MAX_PRICE. Without it OpenRouter is free
 * to land a session on a double-priced host and nothing anywhere would say so —
 * the shape of bill this repo has already paid twice (the retired OpenRouter
 * DeepSeek lane; the Kimi/Infron unit-price doubling).
 */
export const FREEBUFF_GLM_V53_FLASH_MODEL_ID = 'z-ai/glm-5.3-flash'
/**
 * The price ceiling GLM 5.3 Flash routes under, in dollars per MILLION tokens
 * (OpenRouter's `provider.max_price` unit).
 *
 * BETWEEN the two bands, not at either one. OpenRouter lists this model on six
 * endpoints in exactly two price bands — $0.075/$0.015/$0.25 (Z.ai, NovitaAI,
 * GMICloud) and $0.15/$0.03/$0.50 (Cloudflare, DeepInfra, io.net) — so the
 * ceiling has an unusually wide gap to sit in, and it must sit strictly inside
 * it at BOTH ends:
 *
 *   - Strictly ABOVE the cheap band. OpenRouter compares strictly, which is not
 *     a guess: shipping Luna's exact list price 404'd every request with "No
 *     endpoints found that satisfy the max price" (see
 *     FREEBUFF_GPT_5_6_LUNA_MAX_PRICE, verified against the live API). A
 *     ceiling equal to list is an outage waiting on a rounding change.
 *   - Strictly BELOW the dear band, which is the whole reason the fence exists.
 *
 * Fallbacks stay ALLOWED, so this bounds cost without pinning a host: three
 * endpoints sit under it, which is enough that losing one is not an outage.
 * When every endpoint under the ceiling is down OpenRouter returns 404 rather
 * than serving above it, and — as on Ox Alpha — the fix for that 404 is never
 * to raise the number. `max_price` takes prompt and completion only; the cache
 * read that dominates an agent turn is not expressible here, and the two bands
 * move together anyway.
 */
export const FREEBUFF_GLM_V53_FLASH_MAX_PRICE = {
  prompt: 0.1,
  completion: 0.3,
} as const
/** GPT-5.6 Luna (OpenAI), served through OpenRouter. The id is OpenRouter's own
 *  slug, so it falls through to the default OpenRouter route with no
 *  provider-specific handler (same as Ling 3.0 Flash).
 *
 *  Two things about this model are enforced server-side rather than left to the
 *  agent definitions, so they hold for every Freebuff surface, every subagent,
 *  and BYOK callers alike (see applyOpenRouterProviderRouting and
 *  applyFreebuffReasoningDefaults in web/src/llm-api/openrouter.ts):
 *
 *   - Routing PREFERS OpenAI's own endpoint ($0.10/$0.60 per M) via `order`,
 *     with fallbacks allowed and cost bounded by FREEBUFF_GPT_5_6_LUNA_MAX_PRICE
 *     rather than by the pin. A hard pin (allow_fallbacks:false) held until
 *     2026-08-16, when OpenAI began refusing every request from this account
 *     ("Policy Violation: this user has been blocked") and took Luna to a 100%
 *     failure rate with four usable endpoints sitting under the ceiling.
 *   - Reasoning effort is `high`. Luna is cheap enough per token that the
 *     quality is worth more than the reasoning tokens.
 *
 *  Both are scoped to FREEBUFF traffic on purpose: `LITE_MODEL`
 *  (agents/constants.ts) is this same model id, so keying either off the model
 *  alone would change Codebuff's paid lite mode as a side effect. */
export const FREEBUFF_GPT_5_6_LUNA_MODEL_ID = 'openai/gpt-5.6-luna'
/**
 * The Novita `-es` route. GOD-ONLY, and NOT a cheaper GPT-5.6 Luna.
 *
 * Its own id rather than a second lane under Luna's, because it is a different
 * model: measured 2026-08-21 it answers "I'm Codex, an OpenAI coding agent
 * based on GPT-5", volunteers Codex's internal tool names, and carries a fixed
 * ~4,450-token Codex system prompt we did not send. Serving that under Luna's
 * row would be the silent substitution the DeepSeek legacy/GA split exists to
 * prevent — and here the model says the quiet part out loud to any user who
 * asks what it is.
 *
 * A SECOND ID FOR THE SAME MODEL IS NORMALLY THE BUG (see GLM's note above:
 * an extra id is an extra door onto a quota pool). This is the opposite case —
 * one id per distinct model, kept apart precisely so neither can be mistaken
 * for the other. It is god-only, so it opens no pool.
 */
export const FREEBUFF_GPT_5_6_LUNA_ES_MODEL_ID = 'openai/gpt-5.6-luna-es'
/** OpenRouter provider slug Luna prefers (first in `provider.order`). */
export const FREEBUFF_GPT_5_6_LUNA_PROVIDER_ROUTE = 'openai'
/** Price ceiling for Luna, USD per million tokens. Sent as OpenRouter's
 *  `provider.max_price`, which REFUSES to route above it rather than serving
 *  and billing, so a provider re-pricing surfaces as a loud error instead of a
 *  surprise invoice. Since 2026-08-16 this — not a hard provider pin — is the
 *  sole cost guarantee, so it must not be widened casually.
 *
 *  This is a COST FENCE, not an assertion of the list price, and the gap is
 *  deliberate on both sides:
 *
 *   - It must sit ABOVE list. OpenRouter compares strictly: shipping the exact
 *     list price (0.1 / 0.6) made every Luna request 404 with "No endpoints
 *     found that satisfy the max price for this request" — verified against the
 *     live API on 2026-07-30, where 0.11/0.61 passed and 0.1/0.6 did not. A
 *     ceiling equal to list is an outage waiting on a rounding change.
 *   - It must stay under the next tier up. Azure, Azure EU and Amazon Bedrock
 *     listed $1.00/$6.00 when this was written and re-priced to $0.20/$1.20 by
 *     2026-08-16; the ceiling admits them at today's price and would exclude
 *     them again if they returned to the old one.
 *
 *  The headroom covers OpenAI's own tiers (list $0.10/$0.60, priority
 *  $0.20/$1.20, flex $0.05/$0.30) and ordinary price drift, while still failing
 *  closed well before a 10x endpoint could serve a request. */
export const FREEBUFF_GPT_5_6_LUNA_MAX_PRICE = {
  prompt: 0.5,
  completion: 3.0,
} as const
/** Reasoning effort every Luna turn runs at. */
export const FREEBUFF_GPT_5_6_LUNA_REASONING_EFFORT = 'high' as const
/** Solar Pro 4 (Upstage), served through OpenRouter and constrained to Upstage
 *  by `applyOpenRouterProviderRouting`. Context 524,288, text in / text out,
 *  and the `upstage/zdr` (zero data retention) tag.
 *
 *  PRICE: Upstage's LIST card is $0.30/M in, $0.06/M cached, $1.20/M out.
 *  OpenRouter's card shows $0.03/$0.006/$0.12 with `"discount": 0.9` — that is
 *  Upstage's own launch promo ("Solar Pro 4: 90% off through Sep 10 (UTC)" on
 *  the Upstage console), not an OpenRouter-only price.
 *
 *  The route is BYOK (`usage.is_byok: true`): OpenRouter serves it with our
 *  own Upstage key, bills nothing itself (`usage.cost` is 0) and reports an
 *  ESTIMATE of the upstream charge in `cost_details.upstream_inference_cost`,
 *  computed at the LIST card. It does not know our key is on the promo, so
 *  through 2026-09-10 that estimate is ten times Upstage's invoice. An earlier
 *  version of this comment read the estimate as "what we are billed" and
 *  concluded BYOK forfeits the discount; Upstage's invoice says otherwise.
 *
 *  The OpenRouter lane therefore reprices this model from tokens while the
 *  promo runs (web/src/llm-api/openrouter-price-overrides.ts, with the dates),
 *  and falls back to OpenRouter's figure — correct again at list — when it
 *  ends. Re-evaluate the row before then rather than silently changing what
 *  "unmetered" means when the price changes. */
/**
 * The OpenRouter endpoint Solar Pro 4 is pinned to — TAG-QUALIFIED, not the
 * bare `upstage` provider slug.
 *
 * OpenRouter lists two endpoints for this model that are identical in price,
 * context, supported parameters and `provider_name`, and differ only by `tag`:
 * this one and an untagged `upstage`. The bare slug matches both, which split
 * traffic across two prompt caches (worse hit rates with no warming than
 * every other high-volume row) and — because SOLAR_PRO_4_MODEL's
 * `dataUse: 'service'` rests on the ZDR tag — let half of all turns run on an
 * endpoint that is not zero-data-retention while the UI suppressed the training
 * notice.
 *
 * See applyOpenRouterProviderRouting for the full reasoning and for the probe
 * that shows OpenRouter validates tags rather than ignoring them.
 */
export const SOLAR_PRO_4_OPENROUTER_ENDPOINT = 'upstage/zdr'

/**
 * Gemini 3.8 Flash (Google), served through OpenRouter. The id is OpenRouter's
 * own slug, so it falls through to the default OpenRouter route with no
 * provider-specific handler (same as Luna and Ox Alpha).
 *
 * A 1,048,576-token context, text/image/video/audio/PDF in and text out, and
 * the only row in the catalog that accepts audio at all.
 *
 * PRICE IS THE WHOLE STORY HERE, and it is a story about tiers rather than a
 * number. OpenRouter lists SIX endpoints for this model — two providers
 * (Google AI Studio, Google Vertex) times three service tiers — in three price
 * bands per million tokens, read off the live API 2026-09-03:
 *
 *   | tier     | in     | cache read | out    |
 *   | flex     | $0.375 | $0.0375    | $1.875 |
 *   | standard | $0.75  | $0.075     | $3.75  |
 *   | priority | $1.35  | $0.135     | $6.75  |
 *
 * Flex is the target, and reaching it takes BOTH halves of this row's routing
 * — which is unusual and is the thing to understand before changing either.
 * FREEBUFF_GEMINI_38_FLASH_MAX_PRICE fences the dear bands out;
 * GEMINI_38_FLASH_OPENROUTER_UPSTREAM_ORDER is what puts the cheap band in
 * range at all. Measured 2026-09-03: an UNPINNED request does not land on flex
 * and cannot be made to by a ceiling alone — our account's tier filtering cuts
 * the six endpoints to the two BYOK Vertex ones, so a flex-gap ceiling answers
 * 404 while an unpinned request quietly serves on Vertex at full list. The
 * default for this model, in other words, is 2x the price and a seventh of the
 * speed. Neither half of the routing is decoration.
 *
 * TWO THINGS ABOUT THE FLEX PRICE THAT THE TABLE DOES NOT SHOW.
 *
 * 1. IT IS A DISCOUNT, NOT A CARD. Flex's list price is $0.75/$3.75 — the same
 *    as standard — currently at `"discount": 0.5` on both flex endpoints. When
 *    that promo ends, flex costs what standard costs and the ceiling below
 *    stops admitting it, so the row 404s rather than doubling its bill
 *    silently. That is the intended failure and it is the Ox Alpha shape: the
 *    fix for that 404 is a decision about the row, never a higher number here.
 *
 * 2. THE VERTEX ENDPOINTS ARE BYOK AND BILL AT FULL LIST. Measured 2026-09-03:
 *    every `google-vertex/*` tag serves with `usage.is_byok: true` and
 *    `usage.cost: 0`, because OpenRouter routes them through our own Google
 *    credentials and bills Google directly. Its
 *    `cost_details.upstream_inference_cost` for one such response worked out to
 *    $0.75/$3.75 per M — the UNDISCOUNTED rate — against $0.375/$1.875 on the
 *    AI Studio flex response beside it. So the Vertex flex endpoint is listed
 *    at the flex price and invoiced at twice it, and `max_price` cannot see the
 *    difference: THE CEILING BOUNDS THE LISTED PRICE, NOT THE BYOK INVOICE.
 *    That is why routing PREFERS AI Studio (see
 *    FREEBUFF_GEMINI_38_FLASH_UPSTREAM_ORDER) rather than treating the two flex
 *    endpoints as interchangeable. The ledger stays honest either way —
 *    `extractUsageAndCost` records `max(cost, upstream_inference_cost)` — so a
 *    drift onto Vertex shows up as a doubled $/msg on /web/admin/spend rather
 *    than as free traffic.
 *
 * The row is PREMIUM and carries a per-session dollar ceiling
 * (FREEBUFF_PER_MODEL_SESSION_SPEND_CAPS). At the flex rate and the cache
 * rates the browser surfaces actually get, it prices out at roughly 4x DeepSeek
 * V4 Flash and 9x GLM 5.3 Flash per message; the cache-read rate is the dearest
 * in the catalog and cache reads are ~96% of an agent turn's tokens. Figures
 * and the sensitivity to the hit rate are in ./freebuff-costs.knowledge.md.
 */
export const FREEBUFF_GEMINI_38_FLASH_MODEL_ID = 'google/gemini-3.8-flash'

/**
 * The price ceiling Gemini 3.8 Flash routes under, in dollars per MILLION
 * tokens (OpenRouter's `provider.max_price` unit).
 *
 * Sits strictly BETWEEN the flex band ($0.375/$1.875) and the standard band
 * ($0.75/$3.75), and both halves of "strictly" are load-bearing:
 *
 *   - Strictly ABOVE flex. A ceiling equal to list is an outage: verified
 *     against the live API 2026-09-03, `max_price` of exactly
 *     {0.375, 1.875} answers `404 No endpoints found that satisfy the max
 *     price`, with `failed_routing_step: "Filter by Max Price"`. This is the
 *     same comparison that bit FREEBUFF_GPT_5_6_LUNA_MAX_PRICE.
 *   - Strictly BELOW standard, which is the entire reason the fence exists —
 *     four of the six endpoints are 2x or 3.6x the flex band.
 *
 * Fallbacks stay ALLOWED, so this bounds cost without pinning a host: two
 * endpoints sit under it. When both are down OpenRouter returns 404 rather
 * than serving above the ceiling, and the fix for that 404 is never to raise
 * this number.
 */
export const FREEBUFF_GEMINI_38_FLASH_MAX_PRICE = {
  prompt: 0.5,
  completion: 2.5,
} as const
/**
 * Kimi K3 (Eco), served by CrofAI. God-only on Freebuff Web, for testing.
 *
 * The `crof/` prefix names the only place this exists — unlike the retired
 * `crof/glm-5.2`, which was a SECOND id for a model already offered under
 * `z-ai/glm-5.2` and became a quota-bypass route. There is no other id for
 * this, so the prefix creates no such door. (Note the paid `moonshotai/kimi-*`
 * slugs in model-config.ts are different models on a different provider, not
 * second doors onto this one.)
 *
 * `-eco` is load-bearing in the WIRE id and deliberately absent from the
 * DISPLAY name. CrofAI serves two K3 builds — `kimi-k3` at $2.00/$8.00 per M
 * and this Q2_K-quantized `kimi-k3-eco` at $1.00/$4.00 — so the id must name
 * the exact build or a future `kimi-k3` row would collide with it. The picker
 * label is plain "Kimi K3" by request; see KIMI_K3_ECO_MODEL.
 */
export const FREEBUFF_KIMI_K3_ECO_MODEL_ID = 'crof/kimi-k3-eco'
/**
 * Extended-context tiers for the DeepSeek V4 and Luna routes.
 *
 * Wire ids only. These are provisioned per-account rather than offered from a
 * client catalog, so they are deliberately absent from FREEBUFF_MODELS and
 * from every quota list — a client that rendered one would offer a row most
 * accounts cannot run. Requests carry the id directly on any free-mode root.
 *
 * Pricing and context windows track their base tier; the suffix names the
 * provisioned variant, not a different model family, so nothing here needs a
 * second entry in the price tables.
 */
export const FREEBUFF_DEEPSEEK_V4_PRO_MAX_MODEL_ID =
  'deepseek/deepseek-v4-pro-max'
export const FREEBUFF_DEEPSEEK_V4_FLASH_MAX_MODEL_ID =
  'deepseek/deepseek-v4-flash-max'
export const FREEBUFF_GPT_5_6_LUNA_MAX_MODEL_ID = 'openai/gpt-5.6-luna-max'

/**
 * Claude Fable 5 — Anthropic's frontier model, offered to free CLI users as a
 * capacity-limited trial rather than as a standing picker model.
 *
 * It is deliberately NOT in FREEBUFF_MODELS: no client may render it from its
 * own catalog. The server decides, per request, whether the shared pool still
 * has sessions left and says so in the session response
 * (`limitedModelOffers`); a client that receives nothing renders exactly what
 * it rendered before the offer existed. See FREEBUFF_LIMITED_OFFER_MODEL_IDS.
 */
export const FREEBUFF_FABLE_5_MODEL_ID = 'anthropic/claude-fable-5'

/**
 * Meta Muse Spark 1.2 (Contributor tier), served by Meta's own developer API
 * (`https://api.meta.ai/v1`, OpenAI-compatible chat completions). The `meta/`
 * prefix names the only place it exists — there is no second wire id, so it
 * cannot become a quota-bypass route the way `crof/glm-5.2` did.
 *
 * RETIRED FROM EVERY PICKER ON 2026-09-02, replaced by
 * FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID below. The id is still served —
 * it stays in FREEBUFF_WEB_MODELS and the Web premium pool — because a Web
 * session admitted on it before the deploy runs for the rest of its hour, and
 * dropping the id from the catalog fails that session's admission mid-run
 * (see FREEBUFF_WEB_RETIRED_PICKER_MODEL_IDS, which is what hides the row).
 * Keeping it reachable is harmless in the meantime: it costs the same, is
 * metered by the same pool, and draws on the same Contributor-tier budget at
 * Meta as the row that replaced it. A saved 1.2 pick is rewritten to 1.3 by
 * `supersededBy`. Delete the row, its roots and the retired-list entry once
 * live sessions have drained.
 *
 * It was Freebuff Web only for its whole life: the Contributor tier was capped
 * at 60 requests/minute per TEAM, and the only surface that could render the
 * resulting wait was the browser (docs/freebuff-muse-spark.md). What changed
 * that for 1.3 is below.
 *
 * Contributor pricing (a small fraction of Standard's published per-M rates;
 * the negotiated numbers stay out of this exported file) is bought with
 * training rights over prompts and completions, which is why this is
 * `dataUse: 'training'` and carries the AI-training warning.
 */
export const FREEBUFF_MUSE_SPARK_12_CONTRIBUTOR_MODEL_ID =
  'meta/muse-spark-1.2-contributor'
/** Meta's own model id for the wire id above — what api.meta.ai receives. */
export const MUSE_SPARK_12_CONTRIBUTOR_UPSTREAM_MODEL_ID =
  'muse-spark-1.2-contributor'

/**
 * Meta Muse Spark 1.3 (Contributor tier) — the current Muse Spark row, on
 * EVERY surface (CLI, Desktop, Web, Cloud) since 2026-09-04.
 *
 * Same Contributor terms as 1.2: the same per-token price and the same
 * training grant (`dataUse: 'training'`), so the disclosure on the row is
 * unchanged. Meta's card for it: a 1,048,576-token context, tuned for
 * agentic multi-step tool work, with better coding than 1.2. It also shares
 * 1.2's RATE LIMIT — Meta meters the Contributor tier as one bucket across
 * both versions — so this row adds capability, not capacity.
 *
 * WHY IT COULD LEAVE THE BROWSER. 1.2 could not: a team-wide ceiling needs a
 * wait the surface can explain, and only the browser had somewhere to render
 * one. Two things changed. Anything the silent retry window cannot absorb is
 * served on MUSE_SPARK_FALLBACK_MODEL_ID with no client involvement, so a
 * saturated minute produces an answer rather than a wait on any surface; and
 * the key pool (web/src/llm-api/meta-key-pool.ts) makes saturation itself much
 * rarer — four teams' buckets rather than one, 600 RPM against 150, with a
 * rate-limited request walking the pool before it waits at all.
 *
 * The row therefore ships to the CLI and Desktop catalogs, and
 * FREEBUFF_SERVICE_ONLY_MODEL_IDS — which refused it to anything but the Web
 * runner's own service account — necessarily goes with it. Those two are
 * mutually exclusive by construction: the fence names a service account no
 * released binary can authenticate as, so leaving it would 403 every CLI and
 * Desktop turn. What replaces it as the guard is the same thing that guards
 * every other picker row: the free-mode agent+model allowlist, the premium
 * pool, and the per-session Freebucks price.
 *
 * CLIENT RELEASES ARE SEPARATE. The catalogs a CLI or Desktop build renders
 * are compiled into the binary, so this change makes the server ready and
 * those surfaces show the row only from their next release — which is the
 * point: each client can ship on its own schedule without another server
 * change.
 *
 * Still PREMIUM, and not for the usual reason: it is cheaper per token than
 * the unmetered rows. The shared daily premium pool is doing a different job
 * here — bounding how many accounts sit inside the team-wide ceiling at once —
 * and being in SOME pool is mandatory, since FREEBUFF_STANDARD_MODEL_IDS is
 * derived by filtering `!premium`.
 */
export const FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID =
  'meta/muse-spark-1.3-contributor'
/** Meta's own model id for the wire id above — what api.meta.ai receives. */
export const MUSE_SPARK_13_CONTRIBUTOR_UPSTREAM_MODEL_ID =
  'muse-spark-1.3-contributor'
/** Every Muse Spark wire id, current first. One entry per Meta model, and
 *  every entry is metered by the same pool: a second id for the SAME upstream
 *  model would be the `crof/glm-5.2` quota-bypass shape, which this list is
 *  not — 1.2 and 1.3 are different models on one shared rate-limit bucket. */
export const FREEBUFF_MUSE_SPARK_MODEL_IDS = [
  FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID,
  FREEBUFF_MUSE_SPARK_12_CONTRIBUTOR_MODEL_ID,
] as const
/** Contributor-tier limits, PER TEAM and shared by every Freebuff user — and
 *  shared across BOTH Contributor versions, so 1.3 did not add headroom.
 *  Meta's pricing page says 100 RPM / 3M TPM (up from 60 RPM in Aug 2026);
 *  the `x-ratelimit-limit-*` headers on a live 2026-09-02 response for OUR
 *  team said **150** requests and 3,000,000 tokens, and the header is what
 *  the limiter actually enforces, so that is the number recorded here. The
 *  TPM figure is the one to watch for agent traffic, since a single
 *  long-context request spends far more of it than of the request budget.
 *  Re-check both against a live response after any key or team change. */
export const MUSE_SPARK_CONTRIBUTOR_RPM = 150
export const MUSE_SPARK_CONTRIBUTOR_TPM = 3_000_000
/**
 * Reasoning effort sent with every Muse Spark request.
 *
 * Muse Spark ALWAYS reasons — `reasoning_effort: "none"` is a hard 400 — so
 * this chooses how much, not whether. The full ladder is
 * minimal/low/medium/high/xhigh; Meta's own 400 on an unknown value names the
 * set, which is the only place it is documented.
 *
 * Measured live 2026-08-06, same word problem, n=6 per level:
 *
 *   minimal   153 reasoning tokens   1.0s
 *   low      ~300                    —
 *   high      362                    1.9s
 *   xhigh     391                    2.4s
 *
 * The top of the ladder is nearly flat: xhigh buys ~8% more reasoning than
 * high, inside the run-to-run spread, and spends ~26% more latency for it.
 * The real lever is downward — minimal is a 2.4x cut and still answered
 * correctly on every sample. So read this constant as "max depth, latency
 * accepted", and reach for `minimal` or `low` if a turn ever needs to feel
 * fast. Cost barely enters into it: 500k output tokens across 347 prod
 * requests came to roughly $0.10.
 */
export const FREEBUFF_MUSE_SPARK_REASONING_EFFORT = 'xhigh' as const

/**
 * Ox Alpha — an anonymous ("stealth") frontier coding model, served through
 * OpenRouter at a list price of zero while its host evaluated it.
 *
 * WITHDRAWN FROM FREE MODE ON 2026-08-27. The host ended the free promotion,
 * so the model is not served to us any more at any price. The id is PAUSED
 * (FREEBUFF_PAUSED_FREE_MODEL_IDS) rather than deleted, and the row below stays
 * in SUPPORTED_FREEBUFF_MODELS, so the released CLI and Desktop binaries that
 * still list it get a coercion instead of a refusal — see the pause list for
 * why that distinction is worth a whole row of dead catalog.
 *
 * It reached Web and Cloud on 2026-08-20 and CLI, Desktop and the limited tier
 * on 2026-08-24. Everything below records what was true while it ran; keep it
 * until the id is removed outright, because restoring the row means answering
 * these points again. docs/freebuff-ox-alpha.md has the withdrawal order.
 *
 * The id is OpenRouter's own slug, so it falls through to the default
 * OpenRouter route with no provider-specific handler (same as Luna). Three
 * things about it are not like the other rows served that way:
 *
 *  - IT IS FREE, AND THAT IS FENCED RATHER THAN TRUSTED — see
 *    FREEBUFF_OX_ALPHA_MAX_PRICE. A stealth model's price is whatever an
 *    anonymous host decides tomorrow, and this row sits in no session pool at
 *    all, so an unnoticed repricing would be unmetered spend.
 *  - REASONING IS MANDATORY (the endpoint reports `reasoning.mandatory`), and
 *    the provider's own default effort is `max`. Measured on one debugging
 *    prompt, n=4 per rung, 2026-08-20: `low` answered correctly in 409
 *    completion tokens and 8.4s, `high` in 725 and 11.3s, `max` in 3,505 and
 *    48.5s — with one of the four `max` samples truncated by a 4k token limit
 *    mid-answer. So the row names its effort explicitly; leaving it unset opts
 *    every turn into the slowest and most truncation-prone rung there is.
 *  - Prompts and completions are RETAINED BY THE HOST and, per OpenRouter's
 *    stealth-model terms, not used for training. That is neither case
 *    `dataUse` was written for; see the row for how it is labelled.
 */
export const FREEBUFF_OX_ALPHA_MODEL_ID = 'stealth/ox-alpha'
/**
 * Price ceiling for Ox Alpha, USD per million tokens — ZERO, sent as
 * OpenRouter's `provider.max_price`.
 *
 * Same mechanism as FREEBUFF_GPT_5_6_LUNA_MAX_PRICE and deliberately the
 * opposite ceiling. Luna's sits ABOVE list to leave routing headroom; this one
 * sits exactly AT a list price of zero, so the first endpoint that charges
 * anything stops being routable at all.
 *
 * Both halves verified against the live API on 2026-08-20, because a fence
 * nobody has watched fail is not a fence: a zero ceiling serves Ox Alpha
 * normally, and the SAME ceiling on a priced model answers 404 "No endpoints
 * found that satisfy the max price for this request". It fails closed, loudly,
 * before the first billed token rather than after the invoice — which is the
 * shape of bill this repo has already paid twice (the retired OpenRouter
 * DeepSeek lane; the Kimi/Infron unit-price doubling).
 *
 * This guard is why the model can sit outside every session pool. Do not widen
 * it to "just a little headroom" without giving the row a pool in the same
 * change: the two are one decision.
 */
export const FREEBUFF_OX_ALPHA_MAX_PRICE = {
  prompt: 0,
  completion: 0,
} as const

/**
 * The user-pickable ladders, named like Desktop's THROUGH_XHIGH / NO_XHIGH so
 * the two catalogs read the same way.
 *
 * These are reusable provider-native ladders. A model's default is independent
 * and may sit below the last rung.
 */
export const EFFORTS_THROUGH_HIGH = ['low', 'medium', 'high'] as const
export const EFFORTS_THROUGH_XHIGH = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const
export const EFFORTS_THROUGH_MAX = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const
/**
 * The three native DeepSeek V4 templates, shared by Flash 07/31 and Pro 08/13.
 *
 * DeepSeek publishes one requested→actual effort table for both models, and
 * since the Pro 08/13 GA build it is genuinely identical (read off
 * api-docs.deepseek.com/guides/thinking_mode, 2026-08-12): low→low, medium→high,
 * high→high, xhigh→high, max→max. Pro used to collapse low into high, which is
 * why it shipped a shorter ladder; that is no longer true, so the two rows now
 * share this one. Medium is still not a distinct level on either model and is
 * intentionally absent.
 *
 * The table is the ONLY source for this. DeepSeek's API accepts any
 * `reasoning_effort` string without complaint — `"gigantic"` returns a normal
 * 200 (verified against the live API, 2026-08-12) — so a rung being accepted
 * proves nothing about it being distinct, and a ladder can never be derived by
 * probing.
 */
const DEEPSEEK_V4_REASONING_EFFORTS = ['low', 'high', 'max'] as const
/** Ox Alpha's native ladder, read off the endpoint's `supported_efforts`.
 *  The same three rungs as DeepSeek V4 and, like it, no distinct medium — so
 *  it is a separate constant rather than a shared one only because the two
 *  providers are free to diverge. */
const OX_ALPHA_REASONING_EFFORTS = ['low', 'high', 'max'] as const
/**
 * GLM 5.3 Flash's pickable ladder — `low` and `high`, and deliberately NOT the
 * whole of what the endpoint declares.
 *
 * The Merge Gateway DECLARES three values for this model
 * (`effort_values: ["low","high","max"]`), which is also a subset of
 * OpenRouter's enum and passes through CrofAI verbatim, so all three rungs of
 * the cascade mean the same thing and a divert cannot silently change depth
 * (see MERGE_VENDOR_ORDER for how often diverts happen). `max` is therefore
 * available on every lane; it is withheld here as a PRODUCT decision, not a
 * capability one.
 *
 * `max` WAS OFFERED AND WAS REMOVED ON 2026-08-31, because at that depth this
 * model does not converge on agent work: it re-reads the same files, re-plans
 * the same step and re-issues tool calls it has already made, until the turn is
 * spent on deliberation rather than edits. Depth past `high` is not free on a
 * harness that feeds every thought back into the next step's prompt.
 *
 * REMOVING THE RUNG IS ONLY HALF THE FIX, and the other half is the reason this
 * row now also carries `reasoningEffort: 'high'`. Measured in thinking
 * characters on a prompt that needs reasoning (2026-08-27, recorded in
 * merge-gateway.ts):
 *
 *   low 107  <  high 175  <  max 590  <  unset 708
 *
 * and again on an agent-shaped refactor prompt, three samples each (2026-08-29):
 *
 *   unset  8118 / 9942 / 9871      max  7271 / 8011 / 5781
 *
 * UNSET IS DEEPER THAN `max`. Unset is what this row sent on every untouched
 * turn from launch until 2026-08-31 — no `reasoningEffort` meant
 * `applyFreebuffReasoningDefaults` sent no effort at all — so the looping
 * setting was ALSO the default one, and the majority of turns never went near
 * the picker. Deleting the rung while leaving the wire default unset would have
 * taken the control away from the few users who could already see the problem
 * and left it running for everyone else. Hence the pin.
 *
 * (A short logic puzzle REVERSES the unset/max ordering — unset 649, max 1356 —
 * so no single sample is the ordering. What survives repetition is that unset
 * and max are both far above `high` on real agent turns, which is all this
 * needs.)
 *
 * `low` EMITS NO THINKING TRACE AT ALL — 0 chars on both vendors, measured
 * 2026-08-29, while still answering normally. That is the rung behaving as
 * named, not a fault, but it means a user who picks `low` sees the thinking
 * blocks disappear entirely rather than merely shorten. Expect it to be
 * reported as a bug at least once.
 *
 * `none` is deliberately absent and must never be added: the model declares
 * `disable_supported: false`, and the undeclared `'none'` measures at 732 —
 * MORE thinking than unset, the exact opposite of what it names.
 *
 * NOT a change to what BYOK and direct-API callers may send. MERGE_EFFORT_ALIASES
 * still maps OpenRouter's wider enum onto the gateway's declared three, `max`
 * included: a caller paying their own bill keeps the rung. This list governs
 * what Freebuff itself picks and offers.
 *
 * `max` IS BACK (2026-09-01, evening), and it is the ONLY rung on which this
 * model thinks at all. Measured with agent tools in the body, thinking
 * characters, two samples per cell, same prompt as the reasoning monitor:
 *
 *              low       high        xhigh      max              unset
 *   zai        0 / 40    229 / 538   157 / 277  7,282 / 9,104    12,272 / 16,652
 *   particle   0 / 26    178 / 447   262 / 296  5,506 / 6,729    237 / 255
 *   OpenRouter          49 tok      78 tok     2,381 tok        1,814 tok
 *
 * `high` had measured 2-4k on particle on 2026-08-31; by the next evening it
 * was ~300 characters on both vendors, and `xhigh` is `high` under another
 * name on Z.ai's side. Nothing in between exists: OpenRouter's reasoning
 * token budget is ignored and the native `thinking` parameter switches
 * thinking OFF. So the ladder is none / almost-none / deep, and a "Deep
 * reasoning" row that never reaches the third rung is mislabelled. On the
 * tool-bearing mini-bench `max` scored 10/10 at ~614 reasoning tokens against
 * 8/10 at ~15 for `high`, at 21s median latency against 9s.
 *
 * The looping that removed the rung (#2528) is real and is the trade being
 * made here on purpose: depth over the loop risk, with the wire default
 * moving to `max` in the same change. Watch tool-call repetition per turn.
 */
const GLM_V53_FLASH_REASONING_EFFORTS = ['low', 'high', 'max'] as const
/**
 * The marker that turns a Muse Spark rate limit into a queued turn rather than
 * a failed one.
 *
 * It travels twice in the same 429 — as `error.code`, and inside
 * `error.message` — because only the message survives the whole path from
 * `web/src/llm-api/meta.ts` through the AI SDK to the runner's error handling.
 * The runner matches on it (see docs/freebuff-muse-spark.md); if it ever stops
 * matching, rate limits degrade to plain errors with no queue and no notice,
 * which is exactly the failure this constant exists to make greppable.
 */
export const MUSE_SPARK_RATE_LIMITED_ERROR_CODE = 'muse_spark_rate_limited'

/**
 * Where a rate-limited Muse Spark request goes instead of waiting.
 *
 * DeepSeek V4 Flash since 2026-08-18, when V4 Pro was paused for free mode (it
 * held this from 2026-08-12, and GPT-5.6 Luna before that). The choice is
 * constrained rather than free on two counts, and Flash satisfies both for the
 * same reasons Pro did:
 *
 *  - The fallback must be a model the caller is ALREADY entitled to, or a rate
 *    limit would become a way to reach something they are not. Flash shared the
 *    daily premium pool with Muse Spark until 2026-08-24; it is UNMETERED now,
 *    which satisfies this more strongly rather than weakening it — every
 *    full-access caller can run an unmetered row, so the reroute cannot hand out
 *    anything unearned. The direction that would is a referral-EARNED row, and
 *    the invariant test guards that explicitly.
 *  - It should be the model we would recommend anyway, since the user never
 *    chose it. Flash held DEFAULT_FREEBUFF_WEB_MODEL_ID when this was written;
 *    that is Pro now, so the two no longer coincide. Flash stays the right
 *    reroute on the stronger ground that it costs the user nothing.
 *
 * Both bullets are why this had to move with the pause rather than after it: a
 * fallback pointing at a paused model turns a queue overflow into a refusal.
 *
 * Being text-only costs this nothing: images reaching a Freebuff model that
 * cannot see pixels are converted to vision-model descriptions at the
 * completions layer (getFreebuffModelImageSupport gates it), so a rerouted turn
 * carrying an image still reads it.
 */
export const MUSE_SPARK_FALLBACK_MODEL_ID = FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID

/**
 * How long a caller may be asked to wait before the request is rerouted.
 *
 * This IS the provider's silent retry window — `web/src/llm-api/meta.ts`
 * imports it rather than keeping a twin — and that identity is the whole
 * design: a wait we can hide costs nothing and keeps the user on the model
 * they picked, while a wait we would have to *explain* is worse than quietly
 * serving the answer on a peer model. So the rule is exactly two-sided: a
 * rate limit the window absorbs is invisible, and a rate limit that outlives
 * it reroutes. There is no third outcome. (Until 2026-09-02 there was one — a
 * handoff whose remaining Retry-After happened to be under this number fell
 * through to the Web queue, or to a bare 429 on any surface without one. That
 * gap is what kept the model browser-bound, and closing it is what makes a
 * later CLI/Desktop rollout a catalog change rather than a design one.)
 *
 * FIFTEEN SECONDS since 2026-09-03, up from ten, and the reason is the key
 * pool rather than a change of heart about how long silence is tolerable.
 * A rate-limited request now walks the pool before it waits at all
 * (web/src/llm-api/meta-key-pool.ts): with independent per-team buckets, the
 * common case that used to spend the whole window on backoff is answered by
 * another key in one round trip. The window is what remains for the case where
 * EVERY key is spent — rarer, and worth a little more patience because the
 * alternative is answering on a different model. Raising it without the pool
 * would simply have made users wait 50% longer to be told the same thing.
 */
export const MUSE_SPARK_FALLBACK_AFTER_MS = 15_000

/** Picker copy for the tagline tooltip, and the single source for it — the
 *  server's behavior and the row's promise must not drift. Names the model
 *  MUSE_SPARK_FALLBACK_MODEL_ID actually points at; a catalog invariant test
 *  checks the two agree. */
export const MUSE_SPARK_FALLBACK_NOTICE =
  'Rate limited and shared by all users: queues when busy, then answers on DeepSeek V4 Flash.'

/** UI-only rollout switch. Backend support and free-mode allowlists remain
 *  wired even when these models are hidden from the Freebuff picker. */
export const FREEBUFF_ENABLE_MIMO_MODELS_IN_UI = true
/** UI-only rollout switch for the streak indicator in the waiting room. */
export const FREEBUFF_ENABLE_STREAK_IN_UI = true
/** Local/debug switch: force the localhost free-mode country bypass into
 *  limited access so the limited Freebuff UX can be exercised without an env
 *  var. */
export const FREEBUFF_FORCE_LIMITED_MODE = false
/**
 * Base premium sessions per Pacific day, before anything is earned.
 *
 * 5 → 4 when Levels shipped (`freebuff-levels.ts`), and the small size of that
 * cut is the design. A free tier whose floor already hands out everything has
 * nothing left to reward with — but a floor that COLLAPSES is a regression
 * every existing user feels on the same afternoon, and no amount of "you can
 * earn it back" reads as anything other than a takeaway. One session is what
 * an honest account loses; Levels then take it to 7, which is more than
 * anybody had before.
 *
 * Referral, streak, bounty and operator entitlement still add on top of this,
 * unchanged.
 */
// Back to 5 on 2026-09-07, the day Levels were retired: the 5 → 4 retune
// existed so a Level could add the difference back, and with the ladder gone
// a reduced base is the pure takeaway the switch below was built to prevent.
// Moot for a metered account (Freebucks is the meter and these pools are not
// consulted), so this is the rollback-safety value, not a live limit.
export const FREEBUFF_PREMIUM_SESSION_LIMIT = 5
/**
 * Limited-region base sessions per Pacific day.
 *
 * Levels shipped this as 6 → 3, aimed at the brand-new-account /
 * unsupported-region / often-VPN intersection that `docs/freebuff-trust-levels.md`
 * records as the shape of the reselling farms. Restored to 6 on 2026-09-02,
 * the day the switch went on: this pool meters MiMo, the ONLY model a
 * limited-access account can use without a plan, and MiMo is not a premium
 * model — halving the one thing those users have is not what the premium
 * retune (5 → 4) was for. The farms are handled by the trust-level matrix and
 * the signup gate, not by this base. Levels still take it to 7.
 */
export const FREEBUFF_LIMITED_SESSION_LIMIT = 6

/**
 * There is no standard-model session limit, on any surface.
 *
 * `FREEBUFF_WEB_STANDARD_SESSION_LIMIT` used to live here at 6, capping fresh
 * standard sessions on browser surfaces only — unlimited in CLI and Desktop,
 * six a day in Web and Cloud. Removed on 2026-08-18, because a product whose
 * central promise is "Freebuff is free" cannot have that promise be true on
 * one surface and not another, with no way for a user to discover the
 * difference except by hitting it.
 *
 * It was also close to redundant. `docs/freebuff-trust-levels.md` argues at
 * length that session COUNT is the wrong thing to meter — starting a session
 * costs nothing and an idle session costs nothing, while the traffic inside it
 * is bounded four separate ways (`messagesPerDay`, `messagesPer5Hours`,
 * `userMessagesPerDay`, and the daily spend ceiling). The churn it was aimed
 * at is project creation, which has its own gate
 * (`docs/freebuff-web-creation-gate.md`).
 *
 * Levels therefore scale only the two pools that are genuinely scarce: premium
 * and the limited region. See `freebuff-levels.ts`.
 */
export const FREEBUFF_PREMIUM_SESSION_RESET_TIMEZONE = 'America/Los_Angeles'
export const FREEBUFF_PREMIUM_SESSION_PERIOD = 'pacific_day'
/** The earned-reward session pool — referrals, streak bonus, operator grants
 *  and the bounty bank, all in one balance. Distinct from the shared premium
 *  daily pool: it resets daily (Pacific; weekly until 2026-07-29) and its
 *  per-user limit is what the account has EARNED rather than what it is
 *  granted. Note the streak reward bonus is a live entitlement on this same
 *  pool, so it refills at this cadence too.
 *
 *  Since 2026-08-31 the pool is metered per tier — it gates the reward model at
 *  LIMITED access, and adds an extra session to the premium pool at FULL
 *  access. Both halves read these window constants, so the two tiers' rewards
 *  refill together and a user who changes tier does not gain a reset. */
export const FREEBUFF_REWARD_SESSION_PERIOD = FREEBUFF_PREMIUM_SESSION_PERIOD
export const FREEBUFF_REWARD_SESSION_RESET_TIMEZONE =
  FREEBUFF_PREMIUM_SESSION_RESET_TIMEZONE
export const FREEBUFF_REWARD_SESSION_WINDOW_HOURS = 24
/**
 * Hard ceiling on EARNED reward sessions per user per day, applied to the WHOLE
 * pool — referrals, streak bonus, operator grants and bounty bank together.
 *
 * It bounds the reward at both tiers and means the same thing at each: at
 * limited access it is the reward pool's own `maxLimit`, and at full access it
 * caps what the earned terms may add to the shared premium pool. "One a day"
 * has to survive the tier split, or a user could hold one entitlement and spend
 * it twice by being classified differently on two requests.
 *
 * Restored on 2026-08-25. Between 2026-07-30 and that date the pool was
 * effectively unbounded: the old `FREEBUFF_GLM_V52_REFERRAL_CAP = 10` was
 * removed, so entitlement scaled 1:1 with qualified referrals up to
 * FREEBUFF_REFERRAL_SIGNUP_LIMIT (100), and a referral farm converted
 * directly into a hundred paid hours a day.
 *
 * IT IS A CEILING ON THE SUM, NOT ON THE REFERRAL TERM. Capping only the
 * referral component would leave a 28-day streak (up to
 * FREEBUFF_STREAK_REWARD_BONUS_MAX_MULTIPLIER) stacking on top of it, so "one a
 * day" would mean five for the accounts most motivated to find that out.
 *
 * At full access it is a ceiling on the EARNED terms only, never on the premium
 * base beneath them — the reward adds a session, it does not replace the daily
 * allowance.
 *
 * NOTHING EARNED IS DESTROYED. A bounty bank is a BALANCE, not a rate: the
 * grant-debit path spends one unit per admission beyond the recurring
 * entitlement, so ten bounty units become ten days of one session rather than
 * one day of ten. Referrers keep whatever the invite banner already credited
 * them; the cap changes how fast it may be spent, not whether it exists.
 *
 * Consequence worth knowing: while this is 1 the bounty promo
 * (`FREEBUFF_GLM_PROMO_*`, glm-promo.ts) can no longer do anything — it lifts
 * how much of a bounty bank may be spent in a day, and this is below its
 * floor. The promo is left wired rather than deleted so raising this number
 * restores it without a second change.
 */
export const FREEBUFF_REWARD_MAX_DAILY_SESSIONS = 1
/** Master kill-switch for the referral-reward program. While true, qualified
 *  referrals grant daily reward sessions and the CLI advertises the perk. Flip
 *  to false to wind the program down: entitlement drops to 0 for everyone and
 *  the CLI stops showing the banner. The perk is intentionally framed as
 *  limited-time in the UI so turning this off isn't a surprise. */
export const FREEBUFF_REWARD_REFERRAL_ENABLED = true
/** Reward sessions are exactly one hour of wall-clock time, regardless of the
 *  global free-session length, so the "1 hour per referral per day" promise is
 *  exact. */
export const FREEBUFF_REWARD_SESSION_LENGTH_MS = 60 * 60 * 1000
export const FREEBUFF_LIMITED_SESSION_RESET_TIMEZONE =
  FREEBUFF_PREMIUM_SESSION_RESET_TIMEZONE
export const FREEBUFF_LIMITED_SESSION_PERIOD = FREEBUFF_PREMIUM_SESSION_PERIOD

/**
 * Streak rewards. Once a user reaches a `FREEBUFF_STREAK_REWARD_INTERVAL_DAYS`
 * (7)-day daily streak, they earn:
 *   - +1 session in their primary daily pool (premium for full-access users,
 *     limited for limited-access) **every day** the streak stays at 7+; and
 *   - +1 EARNED REWARD session per reward-pool window per completed 7 days of
 *     the current streak (7 days → 1, 14 → 2), capped at
 *     `FREEBUFF_STREAK_REWARD_BONUS_MAX_MULTIPLIER` (28-day streak), on top of
 *     referrals. The reward pool resets daily (Pacific) since 2026-07-29,
 *     weekly before.
 *
 * The second bullet used to be full-access-only, because what it paid was a GLM
 * 5.2 session and that model was full-access-only. Since 2026-08-31 the reward
 * is tier-shaped rather than model-shaped — the reward model at limited access,
 * an extra premium session at full — so the bonus is earned at both tiers and
 * spent on whichever of the two the account can actually use.
 *
 * The daily premium/limited bonus is persisted after today's first use. The
 * reward bonus is derived live from the current streak, so it refills at the
 * reward pool reset and shuts off as soon as the streak breaks.
 */
export const FREEBUFF_STREAK_REWARD_INTERVAL_DAYS = 7
/** Cap on the reward streak bonus: at most this many 7-day tiers count, so a
 *  28-day (or longer) streak earns 4 reward sessions per pool window — before
 *  FREEBUFF_REWARD_MAX_DAILY_SESSIONS clamps the pool's total. */
export const FREEBUFF_STREAK_REWARD_BONUS_MAX_MULTIPLIER = 4
/** Master kill-switch for streak rewards. When false, streaks grant nothing
 *  and effective limits fall back to the base pool limits. */
export const FREEBUFF_STREAK_REWARDS_ENABLED = true
/** Sub-switch for the recurring streak REWARD entitlement. Lets the perk be
 *  wound down independently of the premium/limited bonus (and of the separate
 *  referral-driven reward program). */
export const FREEBUFF_STREAK_REWARD_BONUS_ENABLED = true
/** Session units added to an eligible streak-reward pool. One whole session. */
export const FREEBUFF_STREAK_BONUS_SESSION_UNITS = 1

/** How much history the account hub's activity map covers. A year, matching
 *  what the grid can legibly draw at 53 columns. Free: the map is drawn from
 *  one narrow row per active day. */
export const FREEBUFF_USAGE_MAP_DAYS = 365

/** Lookback for the hub's token and message totals, which are aggregated from
 *  `message` on demand. Days rather than months on purpose: that table's cost
 *  scales with how much the account sent, not with the calendar. */
export const FREEBUFF_RECENT_TOKENS_DAYS = 7

/** Which session pool a streak bonus credit applies to. `premium` and `limited`
 *  are the daily pools (full vs limited access); `glm` is the weekly GLM 5.2
 *  pool (full access only). */
export type FreebuffStreakRewardPool = 'premium' | 'limited' | 'glm'
/** Deprecated wire compatibility field. Session usage now resets at midnight
 *  Pacific time rather than using a rolling hourly window. */
export const FREEBUFF_PREMIUM_SESSION_WINDOW_HOURS = 24
export const FREEBUFF_LIMITED_SESSION_WINDOW_HOURS =
  FREEBUFF_PREMIUM_SESSION_WINDOW_HOURS

const FREEBUFF_EASTERN_TIMEZONE = 'America/New_York'
const FREEBUFF_PACIFIC_TIMEZONE = 'America/Los_Angeles'

interface LocalTimeFormatOptions {
  locale?: string
  timeZone?: string
}

/** Full-access freebuff models that benefit from spawning the gemini-thinker
 *  subagent for deeper reasoning. Used by the CLI to toggle the gemini-thinker
 *  spawnable + prompts based on the user's pick, and by the server to admit
 *  gemini-thinker child requests against a parent session bound to one of
 *  these models.
 *
 *  This used to be "every full-access picker model except the limited-tier
 *  ones", and that rule no longer describes the list. DeepSeek V4 Flash left
 *  the limited tier on 2026-08-18 and is now premium, yet it is deliberately
 *  still OUT: a thinker child is an extra Gemini Pro call on top of the parent
 *  turn, and Flash now carries the bulk of free-mode traffic. Adding it would
 *  multiply exactly the cost the same day's changes were made to contain.
 *  Membership is a cost decision now, not a tier one.
 *
 *  V4 Pro stays listed while paused. The check only ever runs against a row's
 *  bound model, and no row can be bound to a paused model, so the entry is
 *  inert — and it means the thinker comes back with Pro in one edit instead of
 *  being forgotten. */
export const FREEBUFF_GEMINI_THINKER_PARENT_MODELS = new Set<string>([
  FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
  FREEBUFF_MINIMAX_M3_MODEL_ID,
  FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
])

export function canFreebuffModelSpawnGeminiThinker(modelId: string): boolean {
  return FREEBUFF_GEMINI_THINKER_PARENT_MODELS.has(modelId)
}

/**
 * Hard context windows (in tokens) of the freebuff models, keyed by the backend
 * model id sent to the completions endpoint.
 *
 * Every number was read off a real provider rejection in prod rather than a
 * spec sheet, so it is the limit the provider actually enforces:
 *   minimax-m3            "model maximum context length: 524287"
 *   deepseek-v4-flash     "model maximum context length: 1048575"
 *   deepseek-v4-pro       "This model's maximum context length is 1048576
 *                          tokens. However, you requested 1300092 tokens"
 *   kimi-k2.7-code        "Range of input length should be [1, 262144]"
 *
 * The consumer is agents/base-chat.ts, which prunes a chat thread's replayed
 * history to a fraction of the selected model's window. Its `handleSteps` is
 * serialized with toString() and so cannot import — it inlines a copy of this
 * table, and agents/__tests__/base-chat.test.ts fails if the two drift. This
 * is the reference copy: add a model here (with the rejection text that proves
 * the number) and the test will tell you to mirror it.
 *
 * Models absent from the map fall back to FREEBUFF_DEFAULT_CONTEXT_WINDOW. The
 * risk is asymmetric — guessing too high silently wedges a thread forever,
 * guessing too low only prunes earlier than strictly needed — so a model is
 * added only once its real limit has been observed.
 */
export const FREEBUFF_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  [FREEBUFF_MINIMAX_M3_MODEL_ID]: 524_288,
  [FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID]: 1_048_576,
  // Read off the rejection above on 2026-08-12 — the same window as Flash, and
  // the entry Pro had been missing since it shipped. Absent, base-chat gave a
  // million-token model FREEBUFF_DEFAULT_CONTEXT_WINDOW's 131_072 and summarized
  // a Pro chat thread at ~52k estimated tokens, 8x early. Unlike Luna and Muse
  // Spark below this is an observed limit rather than a published one, so it is
  // entered exactly.
  [FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID]: 1_048_576,
  // Luna is the one entry not read off a provider rejection. Every Luna
  // endpoint OpenRouter lists (OpenAI, its flex/priority tiers, Azure, Bedrock)
  // declares context_length 1_050_000, verified against the live endpoints API
  // on 2026-08-01; 1_000_000 is deliberately entered instead, which stays on
  // the safe side of the asymmetry above AND makes base-chat's 0.4 budget come
  // out at exactly 400k.
  //
  // Absent, Luna fell to FREEBUFF_DEFAULT_CONTEXT_WINDOW and base-chat budgeted
  // it 131_072 * 0.4 = 52_428 — a 20x under-estimate of a million-token model,
  // which summarizes a chat thread that had plenty of room left. Every
  // summarize rewrites history from the front and throws away the prompt cache
  // with it.
  [FREEBUFF_GPT_5_6_LUNA_MODEL_ID]: 1_000_000,
  // Novita publishes 372k for the `-es` route (their /v1/models, 2026-08-21),
  // far below Luna's own 1M — it is a Codex session, not the Luna API model.
  // Sized from what the provider states rather than inherited from the name.
  [FREEBUFF_GPT_5_6_LUNA_ES_MODEL_ID]: 372_000,
  // Meta publishes 1,048,576 for every Muse Spark variant. Entered as 1_000_000
  // for the same reason Luna is: it stays on the safe side of the asymmetry
  // above while remaining an honest order of magnitude, where falling through
  // to the 131_072 default would summarize a million-token thread 8x early.
  [FREEBUFF_MUSE_SPARK_12_CONTRIBUTOR_MODEL_ID]: 1_000_000,
  // OpenRouter publishes 1,048,576 for the single Ox Alpha endpoint. Entered as
  // 1_000_000 for the same reason as the two above: a published number is not
  // an observed rejection, and the asymmetry here punishes guessing high.
  [FREEBUFF_OX_ALPHA_MODEL_ID]: 1_000_000,
  // OpenRouter publishes 1,310,720 for GLM 5.3 Flash (131,072 max completion
  // tokens). Entered as 1_000_000, again for the reason above: this is a
  // published figure rather than an observed rejection, and guessing high
  // wedges a thread forever while guessing low only prunes early. Correct it
  // upward once a real rejection quotes the number.
  [FREEBUFF_GLM_V53_FLASH_MODEL_ID]: 1_000_000,
  // Solar Pro 4: 524,288 published, entered low for the same reason.
  [FREEBUFF_SOLAR_PRO_4_MODEL_ID]: 500_000,
}

/** Window assumed for any model missing from FREEBUFF_MODEL_CONTEXT_WINDOWS.
 *  Smaller than every window we have measured. */
export const FREEBUFF_DEFAULT_CONTEXT_WINDOW = 131_072

/* Two supersedes notices lived here — FLASH_SUPERSEDES_NOTICE ("V4 Flash 07/31
 * performs better for most tasks") and FLASH_RECOMMENDED_NOTICE ("V4 Flash
 * 07/31 is the recommended pick") — and both were deleted on 2026-08-21 with
 * their last referrers. The catalog now carries NO supersedes notice at all and
 * no row is badged RECOMMENDED; ordering is the only steer left.
 *
 * Worth reading in git before writing anything like them again, for two reasons
 * that outlive the particular models:
 *
 *  - BOTH EXPIRED WITHOUT ANYONE NOTICING. Each asserted Flash was the better
 *    default. Flash became premium on 2026-08-18 and started closing for the
 *    ten-hour peak window on 2026-08-21, so by the end the picker was steering
 *    users toward a model that is asleep for part of every day.
 *  - A NOTICE IS NOT JUST COPY. migrateSupersededFreebuffModelPreference
 *    rewrites a SAVED pick on every load, so a stale notice does not merely
 *    give bad advice — it silently moves users off the model they chose, on
 *    every launch, with no action from them.
 */

/**
 * DeepSeek V4 Pro, on the 08/13 GA build (2026-08-12).
 *
 * SAME ENDPOINT AND SAME WIRE ID as the preview build it replaces, and that is
 * not an assumption: DeepSeek direct serves only the undated ids, so the GA
 * build arrived on `deepseek-v4-pro` with no route to add. Every dated slug is
 * refused outright — `deepseek-v4-pro-0813` returns "The supported API model
 * names are deepseek-v4-pro or deepseek-v4-flash" (verified against the live
 * API, 2026-08-12), and /v1/models lists exactly the two undated ids. So there
 * is nothing to plumb for a new build; what changes is what this row SAYS.
 *
 * Pricing was unchanged by the GA release, but DeepSeek repriced the whole
 * family at 16:00 UTC on 2026-08-16 and split it into peak and off-peak cards:
 * $0.66 in / $0.022 cache read / $1.98 out per M off-peak, exactly double that
 * at peak (01:00-04:00 and 06:00-10:00 UTC). DEEPSEEK_V4_PRO_PRICING in
 * web/src/llm-api/deepseek.ts carries both.
 */
const DEEPSEEK_V4_PRO_MODEL = {
  id: FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
  // Dated for the same reason Flash is: the wire id is undated and auto-updates,
  // so an undated label tells a returning user nothing changed when in fact the
  // GA build is a different model from the preview they formed an opinion about.
  // UNDATED as of 2026-08-19, and that is a correction rather than a style
  // change. The rule here is that a name must identify the build a user
  // actually gets, and Pro stopped having one: the CrofAI lane serves the
  // undated `deepseek-v4-pro` snapshot while the direct lane serves 08/13, and
  // which one answers depends on the hour (see the peak-window gating in
  // deepseek-router.ts). "08/13" was true of only one of those, so it promised
  // a build we may not hand over.
  displayName: 'DeepSeek V4 Pro',
  // No longer a superlative. Pro is not the recommendation — it is the
  // expensive row that a user may still choose — so the tagline describes it
  // instead of ranking it. "Smartest" read as a recommendation the rest of the
  // catalog no longer makes.
  tagline: 'Deep reasoning',
  // ALWAYS as of 2026-08-22, and this tracks the LANE rather than a change of
  // policy — the third time this row has moved, always for the same reason.
  // Pro is closed at peak only while it is served by a provider that doubles
  // there. It is back on Cheaper Inference, whose card is FLAT, so there is no
  // expensive window to hide from and a ten-hour closure would cost users the
  // model for nothing.
  //
  // THE PAIRING STILL HOLDS: V4 Flash is `always` too, so neither is shut. The
  // rule that matters is that these two are never closed at once, not that one
  // of them always is — if Pro ever returns to DeepSeek direct, close it again
  // and check Flash in the same commit.
  availability: 'always',
  warning: FREEBUFF_AI_TRAINING_NOTICE,
  dataUse: 'training',
  premium: true,
  multimodal: false,
  // DeepSeek's own documented default (thinking on, effort high,
  // api-docs.deepseek.com/guides/thinking_mode), sent explicitly so a
  // provider-side default change cannot silently move Freebuff.
  reasoningEffort: 'high',
  // Low maps to a real low template on these builds, so Pro offers the same
  // three rungs as Flash. See DEEPSEEK_V4_REASONING_EFFORTS.
  efforts: DEEPSEEK_V4_REASONING_EFFORTS,
  defaultEffort: 'high',
  // NO `supersededBy` as of 2026-08-21, and its removal is the point rather
  // than housekeeping. This row carried "V4 Flash is what we recommend",
  // steering users off Pro on COST — it read cache at $0.022/M off-peak and
  // $0.044/M at peak, several times Flash, out of the same shared pool.
  //
  // Both halves of that argument inverted on the same day. Pro reads cache at
  // $0.002538/M FLAT on its new lane, and Flash is now the row that closes at
  // peak. Pointing Pro at Flash would send users to a model that is asleep for
  // ten hours precisely when this one is their best option — and because
  // `migrateSupersededFreebuffModelPreference` rewrites a SAVED pick on every
  // load, it would do that silently and repeatedly. That exact failure is
  // documented on MIMO_V25_MODEL; this is the same trap pointing the other way.
  // No `isNew`. The badge exists to pull attention to a row, which is the
  // opposite of what this one should do now.
} as const satisfies FreebuffModelOption

const MIMO_V25_MODEL = {
  id: FREEBUFF_MIMO_V25_MODEL_ID,
  displayName: 'MiMo 2.5',
  tagline: 'Balanced',
  availability: 'always',
  dataUse: 'service',
  premium: false,
  multimodal: true,
  // Xiaomi exposes only disabled and high (enabled) for MiMo 2.5. Since the
  // product has no separate thinking on/off control, there is no depth ladder
  // to render here; low/medium/max would merely be compatibility aliases.
  // NOT superseded as of 2026-08-18, and the reason is the whole point of the
  // pause. The pointer to Flash rested on "same price, strictly better model,
  // so there is no cost argument to weigh". Flash costing a premium session
  // ended that: MiMo is now the only UNLIMITED row and the target of
  // FALLBACK_FREEBUFF_MODEL_ID, so this row is precisely where a user lands
  // when their premium pool is spent.
  //
  // Two things went wrong while the pointer was still here, and both are worse
  // than a stale nudge:
  //  - `migrateSupersededFreebuffModelPreference` rewrites a SAVED pick on
  //    every load, so a user who deliberately chose the unlimited model was
  //    silently moved onto the premium one at each launch.
  //  - The picker nagged "switch to V4 Flash" on the very row it had just
  //    stepped a spent user down to — advice they cannot take until tomorrow.
  //
  // Restore it together with Flash leaving FREEBUFF_PREMIUM_MODEL_IDS, not
  // before: the argument returns only when Flash is free again.
} as const satisfies FreebuffModelOption

const DEEPSEEK_V4_FLASH_MODEL = {
  id: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  // Dated on purpose: the wire id is undated and auto-updates, so without the
  // date a returning user sees the same name and assumes the same model. The
  // 0731 GA build is a different, re-post-trained model.
  displayName: 'DeepSeek V4 Flash 07/31',
  // "Smart & Fast" survived Flash becoming premium on 2026-08-18: it describes
  // the model, and the one word in it that described the TIER ("unlimited") had
  // already gone when Pro took the recommendation on 2026-08-12. The picker
  // renders the premium group heading, so the tagline does not have to.
  tagline: 'Smart & Fast',
  // CLOSED AT PEAK again as of 2026-08-24. The 08-22 reopening was correct for
  // its moment and its premise has since expired: it reasoned that Pro was
  // "back on DeepSeek direct and closed at peak, so Flash has to be the row
  // that stays up". Pro is neither of those now — it runs on Cheaper Inference
  // at a flat $0.002538/M cache read and is open at all hours — so a row that
  // can hold the peak window exists again, and Flash is once more the row whose
  // whole cost doubles inside it.
  //
  // Flash is a large share of fleet spend and DeepSeek doubles its price for
  // ten hours a day. Measured 2026-08-24 09:00Z, inside the window (per-message
  // figures in the internal cost notes — measured $ numbers do not belong in
  // this file, which is exported to the public repo): Pro at Cheaper Inference
  // cost within 2% of peak Flash, so redirecting saved nothing, while Luna ran
  // at roughly half.
  //
  // Hence the fallback points at LUNA, not Pro. The old pointer named Pro from
  // when Pro was the flat-priced row; it is now merely the same price as the
  // row being closed, so redirecting there would shut a model for no saving —
  // the worst of both outcomes.
  // REOPENED 2026-08-28. The closure above was correct on its own measurement
  // and was invalidated by its own effect.
  //
  // That 08-24 reading caught Luna at its WARM price, taken before Flash's
  // traffic was displaced onto it. Closing Flash is what moved a flood of
  // unfamiliar prefixes onto Luna's lane, and a prefix cache is the whole cost
  // of these rows: Luna's cache rate collapsed inside the window and its price
  // went with it. Re-measured 2026-08-28, hourly: absorbing Luna became the
  // DEAREST of the three per message; peak Flash about half of that; and Flash
  // on Luminal — which is not DeepSeek and so has no peak surcharge at all —
  // cheaper than both by ~4x (~8x at the hour peak pricing begins, same model,
  // same minute).
  //
  // The closure therefore cost a meaningful daily sum of excess Luna spend,
  // against a saving premised on a price that no longer existed.
  //
  // A closure justified by a measurement must be rechecked when the thing it
  // measured is downstream of the closure itself. This one was not, for four
  // days.
  //
  // The peak PRICE is untouched and still real -- `deepseekPricingWindow` still
  // bills the 2x card, because DeepSeek still charges it. What is removed is
  // only the decision to stop SERVING inside that window.
  availability: 'always',
  unavailableFallback: FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
  warning: FREEBUFF_AI_TRAINING_NOTICE,
  dataUse: 'training',
  // UNLIMITED again as of 2026-08-24, reversing the 2026-08-18 metering. Flash
  // went into the daily pool because it was the single largest driver of
  // free-mode spend; what changed is that it now has a cheap lane to spend on.
  // The Luminal lane carries Flash at a fraction of DeepSeek direct, and it is
  // running far under its concurrency ceiling — 43 pins against 80 measured
  // 2026-08-24 21:35Z, with ~90% of Flash sessions refused a slot. Metering
  // Flash by the premium pool throttles the demand that would fill that lane.
  //
  // The limited tier is a separate catalog (LIMITED_FREEBUFF_MODEL_IDS).
  //
  // What did NOT move with it, on purpose:
  //  - FALLBACK_FREEBUFF_MODEL_ID stays MiMo. The fallback has to be available
  //    at every hour and Flash is `off_peak_only`; non-premium is necessary for
  //    that slot, not sufficient.
  //  - DEFAULT_FREEBUFF_MODEL_ID stays Luna. Which model leads the picker is a
  //    product decision, not a consequence of the quota bucket.
  //  - MIMO_V25_MODEL's supersededBy pointer stays off. Its comment asks for it
  //    back "when Flash is free again", but that was written before Flash
  //    closed for the peak window; restoring it would rewrite saved MiMo picks
  //    onto a model that is shut ten hours a day.
  //
  // Reverting is this flag plus the FREEBUFF_PREMIUM_MODEL_IDS entry, which
  // move together, and the FREEBUFF_TIER_CHANGE_NOTICE copy.
  premium: false,
  multimodal: false,
  reasoningEffort: 'high',
  // The 07/31 build has native low/high/max prompt templates. Medium is not a
  // distinct level and is intentionally absent.
  efforts: DEEPSEEK_V4_REASONING_EFFORTS,
  defaultEffort: 'high',
  isNew: true,
} as const satisfies FreebuffModelOption

/**
 * The provisioned extended-context tiers.
 *
 * Full rows so the provisioning tooling, the usage ledger and support have a
 * display name and a data-use classification to read, exactly like every other
 * model. They are deliberately NOT in FREEBUFF_MODELS, FREEBUFF_WEB_MODELS or
 * any quota list: the tier is granted per account rather than picked, so a
 * client that rendered one would offer a row most accounts cannot run, and a
 * quota list would meter a tier whose ceiling is the grant itself.
 *
 * Reasoning defaults, pricing and context tracking their base tier is the
 * point of the suffix — it names the provisioned variant, not a new family.
 */
const DEEPSEEK_V4_PRO_MAX_MODEL = {
  id: FREEBUFF_DEEPSEEK_V4_PRO_MAX_MODEL_ID,
  displayName: 'DeepSeek V4 Pro (Max context)',
  tagline: 'Extended context',
  availability: 'always',
  warning: FREEBUFF_AI_TRAINING_NOTICE,
  dataUse: 'training',
  premium: false,
  multimodal: false,
  reasoningEffort: 'high',
  defaultEffort: 'high',
} as const satisfies FreebuffModelOption

const DEEPSEEK_V4_FLASH_MAX_MODEL = {
  id: FREEBUFF_DEEPSEEK_V4_FLASH_MAX_MODEL_ID,
  displayName: 'DeepSeek V4 Flash (Max context)',
  tagline: 'Extended context',
  availability: 'always',
  warning: FREEBUFF_AI_TRAINING_NOTICE,
  dataUse: 'training',
  premium: false,
  multimodal: false,
  reasoningEffort: 'high',
  defaultEffort: 'high',
} as const satisfies FreebuffModelOption

const GPT_5_6_LUNA_MAX_MODEL = {
  id: FREEBUFF_GPT_5_6_LUNA_MAX_MODEL_ID,
  displayName: 'GPT-5.6 Luna (Max context)',
  tagline: 'Extended context',
  availability: 'always',
  dataUse: 'service',
  premium: true,
  multimodal: false,
  reasoningEffort: FREEBUFF_GPT_5_6_LUNA_REASONING_EFFORT,
} as const satisfies FreebuffModelOption

/**
 * The provisioned tiers, as rows. Exported for the provisioning tooling and
 * for support lookups; NOT spread into any catalog, for the reason above.
 */
export const FREEBUFF_PROVISIONED_MODELS = [
  DEEPSEEK_V4_PRO_MAX_MODEL,
  DEEPSEEK_V4_FLASH_MAX_MODEL,
  GPT_5_6_LUNA_MAX_MODEL,
] as const satisfies readonly FreebuffModelOption[]

const MINIMAX_M3_MODEL = {
  id: FREEBUFF_MINIMAX_M3_MODEL_ID,
  displayName: 'MiniMax M3',
  tagline: 'Fastest',
  availability: 'always',
  dataUse: 'service',
  // M3 is served by Fireworks without provider-side training. Its `service`
  // data-use classification keeps it out of FREEBUFF_TRACED_MODEL_IDS.
  // WITHDRAWN 2026-08-20 (FREEBUFF_PAUSED_FREE_MODEL_IDS). The row is kept
  // here, not deleted: a paused model has to stay in SUPPORTED so the server
  // still recognises the id and can coerce it. `premium` is now moot — nothing
  // reaches a pool through a model that never survives admission — but it stays
  // true so that restoring the row is one edit to the paused list rather than
  // two that must agree.
  premium: true,
  multimodal: true,
  // MiniMax M3 supports adaptive thinking or disabled thinking, but no effort
  // levels. A depth picker would therefore be cosmetic.
  // NO `supersededBy`. This was the last supersedes notice in the catalog and
  // it went on 2026-08-21 with the rest: the picker no longer nudges anyone
  // anywhere. Its claim had also expired twice over — it pointed at Flash as
  // "free rather than premium-pooled" (Flash became premium on 2026-08-18) and
  // as the better default (Flash now closes for ten hours a day). A nudge that
  // survives the argument it was making is worse than none, because
  // migrateSupersededFreebuffModelPreference acts on it silently.
} as const satisfies FreebuffModelOption

const GPT_5_6_LUNA_MODEL = {
  id: FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
  displayName: 'GPT-5.6 Luna',
  // Luna is the general-purpose premium option; its row's own badges (Images,
  // no training notice) distinguish it from the other all-around models.
  tagline: 'Strong all-around',
  availability: 'always',
  // OpenAI's API does not train on request data, and the route carries
  // data_collection: 'deny', so no AI-training notice and no trace storage
  // (FREEBUFF_TRACED_MODEL_IDS keys off this).
  dataUse: 'service',
  premium: true,
  // OpenRouter reports input modalities text + image + file for this model.
  multimodal: true,
  reasoningEffort: FREEBUFF_GPT_5_6_LUNA_REASONING_EFFORT,
  // OpenRouter's model metadata advertises all five enabled effort levels.
  efforts: EFFORTS_THROUGH_MAX,
  defaultEffort: FREEBUFF_GPT_5_6_LUNA_REASONING_EFFORT,
  // Luna led the browser surfaces from 2026-08-04 until Pro's 08/13 GA build
  // took the recommendation on 2026-08-12. It stays fully selectable, and stays
  // the one premium row with no AI-training notice and native image input —
  // reasons a user may still deliberately want it — but the picker now says
  // plainly that Pro is the better default.
  //
  // NOT in FREEBUFF_WEB_DEEMPHASIZED_MODEL_IDS — which is now empty, but Luna
  // would not qualify anyway: muting is this product's "materially dearer"
  // signal, and against Pro that does not resolve — Pro is 2.76x cheaper on the cache reads that
  // dominate agent traffic, and dearer on fresh input and output (full table on
  // that constant). Steering on quality is honest; implying a settled price
  // difference in either direction would not be.
} as const satisfies FreebuffModelOption

const SOLAR_PRO_4_MODEL = {
  id: FREEBUFF_SOLAR_PRO_4_MODEL_ID,
  displayName: 'Solar Pro 4',
  tagline: SOLAR_REGULAR_OFFER.tagline,
  availability: 'always',
  // `upstage/zdr` — zero data retention, so no training notice and no trace
  // storage (FREEBUFF_TRACED_MODEL_IDS keys off this field).
  dataUse: 'service',
  // Limited access still uses its tier-specific metering.
  premium: FREEBUFF_SOLAR_PRO_4_ENTITLEMENT.fullAccess.premium,
  multimodal: false,
} as const satisfies FreebuffModelOption

/**
 * Gemini 3.8 Flash. Premium, and unlike most premium rows it is priced premium
 * as well as badged it — see FREEBUFF_GEMINI_38_FLASH_MODEL_ID for the tier
 * table and FREEBUFF_PER_MODEL_SESSION_SPEND_CAPS for the ceiling that bounds
 * one session on it.
 */
const GEMINI_38_FLASH_MODEL = {
  id: FREEBUFF_GEMINI_38_FLASH_MODEL_ID,
  displayName: 'Gemini 3.8 Flash',
  // The 1M context is the thing a user picks this row FOR, and it is the
  // largest in the catalog by a wide margin.
  tagline: '1M context',
  availability: 'always',
  // Google's paid APIs do not train on request data, and both endpoints this
  // row can reach are paid ones — every probe billed a non-zero amount, which
  // is what distinguishes the paid tier from the AI Studio free tier that does
  // train. So no training notice and no trace storage
  // (FREEBUFF_TRACED_MODEL_IDS keys off this field).
  //
  // Worth knowing when revisiting: OpenRouter's own UI badges the AI Studio
  // endpoints with a data-retention warning and the Vertex ones with a shield,
  // and its public API exposes neither flag, so that badge could not be read
  // programmatically. The claim above rests on Google's paid-tier terms rather
  // than on the badge. If this row is ever pinned to the AI Studio endpoint
  // ALONE, re-check it — that is the Solar Pro 4 lesson, where a `service`
  // claim rested on a tag half the traffic did not carry.
  dataUse: 'service',
  premium: true,
  // Text, image, video, audio and PDF in — the only row here that takes audio.
  multimodal: true,
  // OpenRouter reports `reasoning` and `reasoning_effort` on every endpoint.
  // No pinned `reasoningEffort`: the row runs at the model's own default, and
  // the pickers offer the ladder. Note it reasons freely by default — a
  // two-token "Say hi" spent 111-126 reasoning tokens in probing — and
  // reasoning bills as output at $1.875/M, so the effort control is a real
  // cost lever here rather than a latency one.
  efforts: EFFORTS_THROUGH_MAX,
  defaultEffort: 'high',
  isNew: true,
} as const satisfies FreebuffModelOption

const GLM_V52_MODEL = {
  id: FREEBUFF_GLM_V52_MODEL_ID,
  displayName: 'GLM 5.2',
  tagline: 'Unlock by referring friends',
  availability: 'always',
  dataUse: 'service',
  // Served by Fireworks without provider-side training; its `service`
  // data-use classification keeps GLM out of FREEBUFF_TRACED_MODEL_IDS.
  // `premium` drives the "Premium" badge styling in the picker; GLM's real
  // gate is its weekly referral-session pool, not the daily premium pool.
  premium: true,
  multimodal: false,
  // Our CrofAI route accepts but ignores reasoning_effort (including invalid
  // values), so OpenRouter's GLM ladder does not describe the route users run.
} as const satisfies FreebuffModelOption

/**
 * GLM 5.3 Flash — the catalog's deep row, and DeepSeek V4 Pro's replacement.
 *
 * It is an unmetered full-access model. At limited access it is the earned
 * reward row, so callers must pair reward checks with the access tier rather
 * than infer entitlement from the model id alone.
 */
const GLM_V53_FLASH_MODEL = {
  id: FREEBUFF_GLM_V53_FLASH_MODEL_ID,
  // Undated. The wire id carries the build ('5.3-flash') and there is no second
  // snapshot to tell apart, so the rule the DeepSeek rows follow — date a name
  // whose wire id auto-updates — has nothing to bite on here.
  displayName: 'GLM 5.3 Flash',
  // Describes the row rather than ranking it, like every other tagline since
  // the catalog stopped recommending anything. "Deep reasoning" is the slot V4
  // Pro vacated and the reason a user reaches for this one.
  tagline: 'Deep reasoning',
  // OPEN AT EVERY HOUR. Nothing about this lane is time-of-day priced — the
  // peak/off-peak split that closes DeepSeek rows is DeepSeek's card, not
  // OpenRouter's — so there is no expensive window to hide from, and closing it
  // would cost users the model for nothing. If it ever moves to a lane with a
  // peak card, close it and check what else is closed in the same commit.
  availability: 'always',
  // Z.ai's terms for this endpoint carry no training grant to pass on and no
  // assurance to repeat, so `service` is the conservative reading: we assert no
  // training warning we cannot substantiate, and no safety we cannot either.
  // Load-bearing beyond the copy — FREEBUFF_TRACED_MODEL_IDS keys off this
  // field, so 'training' here would start storing hour-long agent traces of a
  // model nobody granted us traces on.
  dataUse: 'service',
  // UNMETERED, like DeepSeek V4 Flash and MiMo — the two other rows in
  // FREEBUFF_STANDARD_MODEL_IDS. It was premium-pooled while its true cost was
  // unknown; measured production spend has now settled that, and it is the
  // CHEAPEST row we serve (per-message and per-session figures live in the
  // internal cost notes, not in this exported file).
  //
  // This row is 4.6x cheaper per session than MiMo and 8.9x cheaper than V4
  // Flash, both of which already run with no ceiling at all. Keeping a session
  // cap on the cheapest model while the dearer ones are uncapped inverts the
  // reason caps exist.
  //
  // WHAT THIS ALSO DROPS, deliberately: `premium` gates
  // FREE_MODE_PREMIUM_RATE_LIMITS, the endpoint-level ceiling that catches
  // callers who script /v1/chat/completions and never create an agent_run. That
  // protection goes with the flag. It is the same posture V4 Flash already runs
  // — by volume the largest row in the fleet — and the exposure per request
  // here is 8.9x SMALLER, so if that trade is acceptable there it is acceptable
  // here first. Revisit both together if scripted abuse appears, not this one
  // alone.
  //
  // NOT a limited-tier change. That tier reads the explicit
  // LIMITED_FREEBUFF_MODEL_IDS / FREEBUFF_WEB_GEO_EXEMPT_MODEL_IDS allowlists,
  // not this flag, so limited-region users are unaffected.
  premium: false,
  // OpenRouter reports text + image + video in, text out.
  multimodal: true,
  // LADDERED as of 2026-08-29. `z-ai/glm-5.3-flash` carries `reasoning_effort`
  // in its `supported_parameters`, and the Merge Gateway — the lane that
  // actually serves nearly all of this row's traffic — DECLARES
  // `effort_values: ["low","high","max"]` and was measured behaving
  // monotonically across them, so the bar this catalog sets (a native provider
  // setting, never a compatibility alias) is met. MiniMax M3, Solar Pro 4 and
  // MiMo stay bare — those genuinely expose no effort parameter.
  //
  // PINNED TO `max` ON 2026-09-01 (evening). The 08-31 pin to `high` was made
  // when `high` still measured 2-4k thinking characters on particle; a day
  // later it measured ~300 on both vendors, and every rung below `max` is
  // effectively no thinking at all (see GLM_V53_FLASH_REASONING_EFFORTS for the
  // table). An explicit default still matters for the reason the 08-31 note
  // gave — unset inherits whatever the vendor feels like today, 12-17k on zai
  // and ~250 on particle the same evening — it just has to name the rung
  // that thinks. The loop risk that removed `max` is accepted on purpose and
  // is the thing to watch: tool-call repetition per turn, not thinking depth.
  //
  // `defaultEffort` EQUALS `reasoningEffort`, the ordinary shape.
  efforts: GLM_V53_FLASH_REASONING_EFFORTS,
  reasoningEffort: 'max',
  defaultEffort: 'max',
  //
  // No `supersededBy` and no RECOMMENDED badge: nothing in this catalog nudges
  // anyone anywhere, and a notice here would rewrite saved picks on every load
  // (see migrateSupersededFreebuffModelPreference).
  isNew: true,
} as const satisfies FreebuffModelOption

/**
 * Kimi K3 (Eco), CrofAI. God-only, for testing, and the cost is part of why.
 *
 * List price per M (CrofAI catalog, read from the live /v1/models endpoint on
 * 2026-08-07): $1.00 in, $0.10 cache read, $4.00 out. Against DeepSeek V4
 * Flash's $0.12/$0.21 on the same provider that is ~8x input and ~19x output,
 * which is the argument for keeping it off the public picker rather than
 * merely marking it premium.
 *
 * `displayName` is 'Kimi K3', NOT 'Kimi K3 Eco', by explicit request. This
 * breaks the convention DEEPSEEK_V4_FLASH_MODEL sets — name the exact build so
 * a returning user cannot mistake one for another — and the divergence is
 * deliberate rather than an oversight, so do not "fix" it: CrofAI also serves a
 * full `kimi-k3` at twice the price, and this row is the Q2_K-quantized Eco
 * build (1M context, 131,072 max completion tokens). The wire id keeps `-eco`
 * so the two builds stay distinguishable everywhere it actually matters —
 * routing, billing, and the CROF_MODEL_MAP entry. If the full K3 is ever added
 * as its own row, this label has to be disambiguated at that point.
 */
const GPT_5_6_LUNA_ES_MODEL = {
  id: FREEBUFF_GPT_5_6_LUNA_ES_MODEL_ID,
  // Named for what it IS. "Luna" appears nowhere: the route answers "Codex" when
  // asked, so a row calling it Luna would be contradicted by the model itself.
  displayName: 'Codex (test)',
  tagline: 'Novita route — evaluation only',
  availability: 'always',
  // No AI-training claim either way: the supplier has no resale agreement for
  // this route, so we have no data-use terms to pass on. `service` is the
  // conservative reading — we are not asserting a training warning we cannot
  // substantiate, and not asserting safety we cannot either.
  dataUse: 'service',
  // TRUE so it cannot fall into FREEBUFF_STANDARD_MODEL_IDS, which is derived
  // as `WEB_ALL.filter(m => !m.premium)` — the UNMETERED pool. God-only is the
  // gate; this flag is what stops the row becoming free inference if the gate
  // is ever widened.
  premium: true,
  multimodal: false,
  reasoningEffort: FREEBUFF_GPT_5_6_LUNA_REASONING_EFFORT,
} as const satisfies FreebuffModelOption

const KIMI_K3_ECO_MODEL = {
  id: FREEBUFF_KIMI_K3_ECO_MODEL_ID,
  displayName: 'Kimi K3',
  tagline: 'Via CrofAI',
  availability: 'always',
  dataUse: 'service',
  premium: true,
  multimodal: false,
  experimental: true,
  // CrofAI likewise ignores reasoning_effort for this build. Do not expose a
  // control until this concrete route reports distinct supported levels.
} as const satisfies FreebuffModelOption

const FABLE_5_MODEL = {
  id: FREEBUFF_FABLE_5_MODEL_ID,
  displayName: 'Claude Fable 5',
  tagline: "Anthropic's most intelligent model",
  availability: 'always',
  // Load-bearing, not decoration: `dataUse: 'training'` is what puts this model
  // in FREEBUFF_TRACED_MODEL_IDS, which is the entire point of the trial — we
  // are buying hour-long agent traces with the pool. The warning is the
  // disclosure that makes that legitimate, and the catalog invariant test
  // requires the two to agree.
  warning: FREEBUFF_AI_TRAINING_NOTICE,
  dataUse: 'training',
  // Not in FREEBUFF_PREMIUM_MODEL_IDS: the daily premium pool is shared across
  // its models and Fable is metered by its OWN global pool instead (see
  // FREEBUFF_LIMITED_OFFER_MODEL_IDS). The flag only marks it as scarce for the
  // pickers' styling and for FREEBUFF_STANDARD_MODEL_IDS, which must not
  // absorb it.
  premium: true,
  multimodal: true,
  // OpenRouter reports low/medium/high/xhigh/max, with high as the default.
  efforts: EFFORTS_THROUGH_MAX,
  defaultEffort: 'high',
  isNew: true,
} as const satisfies FreebuffModelOption

/**
 * Meta Muse Spark 1.2 Contributor — RETIRED from the picker on 2026-09-02 and
 * kept only so live Web sessions drain (FREEBUFF_WEB_RETIRED_PICKER_MODEL_IDS
 * hides it; see FREEBUFF_MUSE_SPARK_12_CONTRIBUTOR_MODEL_ID for the removal
 * order). Every field except `supersededBy` is as it shipped, so a session
 * still on it behaves exactly as it did.
 */
const MUSE_SPARK_12_CONTRIBUTOR_MODEL = {
  id: FREEBUFF_MUSE_SPARK_12_CONTRIBUTOR_MODEL_ID,
  displayName: 'Muse Spark 1.2',
  tagline: 'Queue',
  taglineTooltip: MUSE_SPARK_FALLBACK_NOTICE,
  availability: 'always',
  // Load-bearing pair (a catalog invariant test enforces it): the Contributor
  // tier's whole discount is Meta training on prompts and completions.
  warning: FREEBUFF_AI_TRAINING_NOTICE,
  dataUse: 'training',
  premium: true,
  multimodal: false,
  reasoningEffort: FREEBUFF_MUSE_SPARK_REASONING_EFFORT,
  efforts: EFFORTS_THROUGH_XHIGH,
  defaultEffort: FREEBUFF_MUSE_SPARK_REASONING_EFFORT,
  // The one supersedes pointer in the catalog, and a strict version bump
  // rather than a steer: identical price, identical terms, identical pool, a
  // better model. migrateSupersededFreebuffModelPreference rewrites a saved
  // 1.2 pick to 1.3 on load, which is the only way a browser that remembered
  // this row ever reaches the new one — the retired row itself is not offered.
  supersededBy: {
    modelId: FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID,
    notice:
      'Muse Spark 1.3 replaces 1.2: same price and terms, better at agentic coding.',
    actionLabel: 'Switch to Muse Spark 1.3',
  },
} as const satisfies FreebuffModelOption

/**
 * Meta Muse Spark 1.3 Contributor. Premium on Web and Cloud, and unusual in
 * WHY: every other premium row is priced premium, while this one is cheaper
 * per token than DeepSeek V4 Flash. What is scarce is the team-wide rate
 * limit, so the daily premium session pool is doing double duty here as a way
 * to bound how many people are inside that limit at once. See
 * FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID for why it stays off the CLI and
 * Desktop for now, and what widening it takes.
 */
const MUSE_SPARK_13_CONTRIBUTOR_MODEL = {
  id: FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID,
  displayName: 'Muse Spark 1.3',
  // Three facts have to fit here, because on the CLI and Desktop this is the
  // ONLY line a row gets — those pickers render no tooltip: the row is rate
  // limited, it queues, and it can answer as a different model. "Queues, then
  // falls back" carries all three in three words, since only a rate-limited row
  // queues and only a row that gives up on the queue falls back. The tooltip,
  // where there is one, names the model it falls back to.
  //
  // It read 'Falls back when busy' while the row was Web-only, which stated the
  // third fact and left the first two to be discovered.
  tagline: 'Queues, then falls back',
  taglineTooltip: MUSE_SPARK_FALLBACK_NOTICE,
  availability: 'always',
  // Load-bearing pair (a catalog invariant test enforces it): the Contributor
  // tier's whole discount is Meta training on prompts and completions.
  warning: FREEBUFF_AI_TRAINING_NOTICE,
  dataUse: 'training',
  premium: true,
  // Meta lists image/video/PDF input for this model, but the Meta handler
  // sends text only; an image reaching this row is substituted with a
  // vision-model description at the completions layer, which is a real
  // fallback and not a capability worth badging (same call as 1.2).
  multimodal: false,
  reasoningEffort: FREEBUFF_MUSE_SPARK_REASONING_EFFORT,
  efforts: EFFORTS_THROUGH_XHIGH,
  defaultEffort: FREEBUFF_MUSE_SPARK_REASONING_EFFORT,
  isNew: true,
} as const satisfies FreebuffModelOption

/**
 * The Ox Alpha picker row. STANDARD rather than premium — metered by no session
 * pool on any surface, which is what `!premium` means here
 * (FREEBUFF_STANDARD_MODEL_IDS is derived by filtering on it).
 *
 * That is a reading of a $0 price and a measured ceiling, not an oversight of
 * the rule the premium lists keep repeating. There is nothing to ration: the
 * model costs nothing and the fence keeps it that way
 * (FREEBUFF_OX_ALPHA_MAX_PRICE), and its host absorbed 300 concurrent requests,
 * ~99k prompt tokens/sec and 1,800 requests at a sustained 10/s without a
 * single 429 (docs/freebuff-ox-alpha.md). What a pool would really ration is
 * our standing with that host, and no number in this file can tell us where
 * that limit is — serving the model and watching it can, which is what the two
 * browser surfaces are for here.
 *
 * `experimental` was doing real work on this row rather than decorating it. An
 * anonymous host can reprice, rename or withdraw a stealth model with no
 * notice, so the TEST badge was the only promise about it we could actually
 * keep — and on 2026-08-27 the host withdrew it, which is the outcome that
 * badge was warning about.
 *
 * WITHDRAWN. The row is kept rather than deleted because a paused model must
 * stay a recognised id (see FREEBUFF_PAUSED_FREE_MODEL_IDS); it is in no picker
 * list, so `premium: false` no longer places it anywhere — it is out of
 * FREEBUFF_WEB_ALL_MODELS, and therefore out of the derived
 * FREEBUFF_STANDARD_MODEL_IDS. The flag stays as written so that restoring the
 * row is one edit to the pause list rather than several that must agree.
 */
const OX_ALPHA_MODEL = {
  id: FREEBUFF_OX_ALPHA_MODEL_ID,
  displayName: 'Ox Alpha',
  // Names the property a user picks this row FOR. "Free" would not distinguish
  // it — every row in this catalog is free to the user — and naming the host
  // is impossible, which is the whole point of a stealth model.
  tagline: '1M context',
  availability: 'always',
  // NOT the AI-training notice, and the gap between the two is the point. The
  // stealth terms say the host keeps prompts and completions and does not train
  // on them, so `dataUse` stays 'service' — that field is what
  // FREEBUFF_TRACED_MODEL_IDS keys off, and claiming a training grant we were
  // not given would be wrong in the direction that changes behavior. The
  // warning still says the thing a user wants before pasting a private repo
  // into a provider whose name nobody will tell them.
  //
  // NOTE this is the one row where a warning does not imply `dataUse:
  // 'training'`. The invariant test asserting they move together scopes itself
  // to SUPPORTED_FREEBUFF_MODELS (the CLI/Desktop catalog), which this is
  // deliberately not in; ox-alpha.test.ts pins the exception so it reads as a
  // decision rather than as drift.
  warning: 'Anonymous provider retains prompts',
  dataUse: 'service',
  premium: false,
  // text + image + video in, text out.
  multimodal: true,
  // See FREEBUFF_OX_ALPHA_MODEL_ID for the measurement behind this. The
  // provider's own default is `max`, which is 4x the tokens and 4x the latency
  // of `high` for no better answer.
  reasoningEffort: 'high',
  efforts: OX_ALPHA_REASONING_EFFORTS,
  defaultEffort: 'high',
  experimental: true,
  // NOT `isNew` any more: the row is withdrawn, and a NEW badge on a paused
  // model would be the one claim about it that is actively false. It renders
  // nowhere today — the row is in no picker list — but it would be the first
  // thing seen if the pause were ever lifted without re-reading this row.
} as const satisfies FreebuffModelOption

export const SUPPORTED_FREEBUFF_MODELS = [
  OX_ALPHA_MODEL,
  DEEPSEEK_V4_PRO_MODEL,
  MINIMAX_M3_MODEL,
  GPT_5_6_LUNA_MODEL,
  SOLAR_PRO_4_MODEL,
  GEMINI_38_FLASH_MODEL,
  MUSE_SPARK_13_CONTRIBUTOR_MODEL,
  GLM_V52_MODEL,
  GLM_V53_FLASH_MODEL,
  DEEPSEEK_V4_FLASH_MODEL,
  MIMO_V25_MODEL,
  FABLE_5_MODEL,
] as const satisfies readonly FreebuffModelOption[]

// GLM 5.2 is intentionally NOT in FREEBUFF_MODELS: it isn't a freely-pickable
// grid model, it's a referral reward surfaced by the separate referral banner.
// It stays in SUPPORTED_FREEBUFF_MODELS so the session/chat layers accept it as
// a valid model id once the user's weekly entitlement admits them.
//
// MiMo 2.5 Pro is GONE (2026-08-04). It was hidden from the client pickers on
// 2026-07-31 and kept server-valid for released clients, exactly as Kimi K2.7
// Code was; this is the second stage of that same retirement. Requests for it
// now 403 with free_mode_invalid_agent_model. The non-Pro MiMo 2.5 is
// unaffected, and paid/BYOK MiMo Pro plus its llm-api provider routing are
// untouched.
// Order is the order shown in every picker: the recommended default leads, the
// unlimited fallback it steps down to follows, then the rest of the full-access
// grid.
//
// DeepSeek V4 Pro is WITHDRAWN (2026-08-26) and left this list — the row is gone
// from every picker and every pool. It stays in SUPPORTED_FREEBUFF_MODELS on
// purpose: released clients hold their catalog in the binary and keep asking for
// it, and an id the server does not RECOGNISE cannot be coerced, only refused.
// Recognising it is what lets admission substitute (see
// FREEBUFF_PAUSED_FREE_MODEL_IDS) instead of wedging those clients the way
// #1801 wedged the limited tier.
//
// GLM 5.3 Flash takes the slot it vacated — the row a user reaches for depth —
// at roughly an eighth of the price per token. That substitution is the whole
// change: the catalog keeps a deep option, and the line that could not be
// afforded goes.
export const FREEBUFF_MODELS = [
  // GLM 5.3 FLASH LEADS as of 2026-08-30, and the position is not a preference —
  // a test pins FREEBUFF_MODELS[0] to DEFAULT_FREEBUFF_MODEL_ID, so this moved
  // because the DEFAULT moved. It is an explicit product decision, taken
  // against the note that used to sit on this row telling you not to.
  //
  // It clears the two invariants a default has to clear, and clears them more
  // comfortably than the Luna it replaces:
  //
  //  - OPEN AT EVERY HOUR (`availability: 'always'`). Nothing about the Merge
  //    lane is time-of-day priced. A default dark for part of the day fails
  //    admission for exactly the people least able to diagnose it.
  //  - JOINABLE WITH AN EMPTY WALLET. This row is UNMETERED — `premium: false`
  //    — so unlike every default since 2026-08-18 it cannot be exhausted. The
  //    `premiumExhausted` step-down in
  //    getRecommendedFreebuffModelId still exists for the limited tier and for
  //    callers that pass it, but it is no longer load-bearing FOR THE DEFAULT:
  //    a new user's first send cannot fail because a pool ran dry.
  //
  // And it is the cheapest row we serve, by a wide margin — measured production
  // spend per message puts MiMo at 4.6x this row and V4 Flash at 8.9x (exact
  // figures in the internal cost notes, not in this exported file).
  //
  // WHAT THIS GIVES UP is no longer latency, and that changed on 2026-08-31.
  // This row led the list while running UNSET on the wire — ~7-9k thinking
  // characters on an agent-shaped prompt against `high`'s ~175 — which made a
  // new user's first turn slower than it was on Luna. That was the trade this
  // comment warned would need revisiting first, and it has been: the row is now
  // pinned to `reasoningEffort: 'high'` and `max` is off its ladder entirely,
  // because at that depth it looped rather than finished (see
  // GLM_V53_FLASH_REASONING_EFFORTS). Leading the list costs nothing on latency
  // now; what it gives up is depth, and the case for the row is the cost and
  // availability wins, which are untouched.
  //
  // Ordering is still the ONLY steer here — no supersedes notices, nothing
  // badged RECOMMENDED, because a `supersededBy` would rewrite saved picks on
  // every load (see migrateSupersededFreebuffModelPreference). Leading the list
  // IS the recommendation; a returning user who chose another row keeps it.
  // A test pins the first row to DEFAULT_FREEBUFF_MODEL_ID.
  //
  // GLM 5.3 FLASH LEADS AGAIN as of 2026-09-05, retaking the position it held
  // from 08-30 to 09-02. This moved because the DEFAULT moved, which is the
  // only reason this line ever moves.
  GLM_V53_FLASH_MODEL,
  DEEPSEEK_V4_FLASH_MODEL,
  GPT_5_6_LUNA_MODEL,
  ...(FREEBUFF_ENABLE_MIMO_MODELS_IN_UI ? [MIMO_V25_MODEL] : []),
  // OX ALPHA LEFT THIS LIST on 2026-08-27, when its anonymous host ended the
  // free promotion the row existed for. MiMo is the sole UNMETERED row again.
  //
  // Dropping it here is what takes it out of every picker on every surface —
  // FREEBUFF_WEB_MODELS reaches it only by spreading this list — but it is NOT
  // what stops it being served. FREEBUFF_PAUSED_FREE_MODEL_IDS is, and the row
  // stays in SUPPORTED_FREEBUFF_MODELS so the id remains recognisable and
  // coercible for the installed binaries that still hold it.
  SOLAR_PRO_4_MODEL,
  // GEMINI 3.8 FLASH LEFT THIS LIST on 2026-09-03, hours after joining it, when
  // the row was withdrawn (FREEBUFF_PAUSED_FREE_MODEL_IDS). Dropping it here is
  // what takes it out of every picker on every surface — FREEBUFF_WEB_MODELS
  // reaches it only by spreading this list — but it is NOT what stops it being
  // served; the pause is. Its row stays in SUPPORTED_FREEBUFF_MODELS so the id
  // stays recognisable and coercible for the installed binaries that hold it.
  //
  // MUSE SPARK 1.3 JOINED on 2026-09-04, and is last on purpose: ordering is
  // the only steer this list gives, and this is the one row that may answer on
  // a different model when its shared ceiling is full. A row carrying that
  // caveat should not outrank one without it. Joining here is also what puts it
  // in the premium pool and in the Web picker — both are derived from this list
  // and the row's own `premium` flag, so there is no second entry to keep in
  // step.
  MUSE_SPARK_13_CONTRIBUTOR_MODEL,
] as const satisfies readonly FreebuffModelOption[]

/** Public full-access models metered by the shared premium pool. The catalog
 *  flag is the owner; server admission and every picker consume this
 *  projection. The limited tier meters its explicit catalog by region instead. */
export const FREEBUFF_PREMIUM_MODEL_IDS = Object.freeze(
  FREEBUFF_MODELS.filter((model) => model.premium).map((model) => model.id),
)

/**
 * The catalog's human-facing name for `model`, or the raw id when it has none.
 */
export function freebuffModelLabel(model: string): string {
  return (
    SUPPORTED_FREEBUFF_MODELS.find((m) => m.id === model)?.displayName ?? model
  )
}

/**
 * Whether the catalog marks `model` experimental.
 *
 * Read by quota-refusal telemetry. Derived from the catalog rather than a
 * second list, so a row that stops being experimental stops saying so
 * everywhere at once.
 */
export function isFreebuffExperimentalModel(
  model: string | null | undefined,
): boolean {
  if (!model) return false
  const row = SUPPORTED_FREEBUFF_MODELS.find((m) => m.id === model)
  // `in` rather than a property read: the catalog is a union of `as const`
  // literals and only some carry the optional flag, so a direct access does not
  // typecheck against the members that omit it.
  return row !== undefined && 'experimental' in row && row.experimental === true
}

/**
 * Per-session provider-spend ceilings. The lookup happens before any database
 * read, so models absent from this table stay off the spend-gate path.
 */
export const FREEBUFF_PER_MODEL_SESSION_SPEND_CAPS: Readonly<
  Record<string, number>
> = {
  // Gemini 3.8 Flash, $0.50 a session from the day it shipped (2026-09-03).
  // Revisit after its implicit-cache hit rate has been measured in production.
  [FREEBUFF_GEMINI_38_FLASH_MODEL_ID]: 0.5,
}

/** The per-session dollar ceiling for `model`, or undefined when it has none. */
export function getFreebuffPerModelSessionSpendCap(
  model: string | null | undefined,
): number | undefined {
  if (!model) return undefined
  return FREEBUFF_PER_MODEL_SESSION_SPEND_CAPS[model]
}

/**
 * Models free mode no longer runs, but still RECOGNISES.
 *
 * This is not a picker-only retirement (FREEBUFF_WEB_RETIRED_PICKER_MODEL_IDS
 * is that, and is deliberately empty) — nothing here is served to anyone. It is
 * the opposite problem: a paused model must stay a known id so the server can
 * SUBSTITUTE for it.
 *
 * An id dropped from SUPPORTED entirely is one `isFreebuffSessionModelId` says
 * nothing about, so the coercion in `resolveFreebuffSessionModelForAccessTier`
 * never runs and the request is simply refused. Every installed client holding
 * that pick then retries forever, because the pick comes from the catalog
 * compiled into its binary and no server change reaches it — measured at 2.5x
 * admissions and 91% of sessions ending at the 0.1-unit floor when the limited
 * tier hit exactly this on 2026-08-18 (#1801).
 *
 * So: out of every picker, out of every quota list, still recognised, and
 * coerced to the tier's default at admission and at the session gate.
 *
 * This is the tested answer to a question that keeps coming up under cost
 * pressure, and the expensive way to learn it is the one already paid for in
 * #1801: the coercion has to exist BEFORE a model is taken away, because the
 * clients that need it are the ones already installed.
 */
export const FREEBUFF_PAUSED_FREE_MODEL_IDS: readonly string[] = [
  // Withdrawn from free mode entirely on 2026-08-20. Its hourly burn became
  // the largest single line on the bill — and is not worth that at any tier.
  //
  // PAUSED rather than deleted, which is the difference between withdrawing a
  // model and breaking the clients that still ask for it. Every released CLI and
  // Desktop holds this id in its compiled-in catalog and will keep sending it;
  // an id the server does not RECOGNISE cannot be coerced, only refused, and a
  // refusal here is the retry loop that cost the limited tier 2.5x its
  // admissions in #1801. Listed here it stays recognised, is coerced to the
  // fallback at admission, and is served to nobody.
  FREEBUFF_MINIMAX_M3_MODEL_ID,
  // Withdrawn from free mode entirely on 2026-08-26, on cost. Pro was the
  // dearest row we serve — $0.66 in / $0.022 cache read / $1.98 out per M
  // off-peak on DeepSeek direct, exactly double inside the peak windows — and
  // the catalog now has a deep row (GLM 5.3 Flash) at roughly an eighth of
  // that. Withdrawing it is not a judgement on the model; it is that the same
  // slot can be filled for a fraction of the money.
  //
  // PAUSED rather than deleted, for the reason above it: every released CLI and
  // Desktop holds this id in its compiled-in catalog and will keep sending it.
  // The row stays in SUPPORTED_FREEBUFF_MODELS and its agent entries stay in
  // FREE_MODE_AGENT_MODELS so sessions admitted before the deploy drain instead
  // of failing mid-turn — the door is shut in front of them, not under them.
  //
  // NOT withdrawn with it: FREEBUFF_DEEPSEEK_V4_PRO_MAX_MODEL_ID, the
  // provisioned extended-context tier. That is granted per account rather than
  // picked, so it is not part of what free mode hands out, and pausing it would
  // break the accounts it was granted to without any of them asking.
  FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
  // Withdrawn from free mode entirely on 2026-08-27: the anonymous host ended
  // the free promotion, so the row is no longer served to us at all. This is
  // not a cost decision like the two above it — there is nothing left to buy.
  //
  // Pausing rather than deleting matters MORE here than for either of them,
  // because this row shipped to CLI and Desktop on 2026-08-24 and to the
  // limited tier with it. Every released binary holds the id in its compiled-in
  // catalog and will keep sending it; an id the server does not RECOGNISE
  // cannot be coerced, only refused, and that refusal is the retry loop that
  // cost the limited tier 2.5x its admissions in #1801. Listed here it stays
  // recognised, is coerced to the tier's default at admission, and reaches
  // nobody.
  //
  // Its roots and agent allowlist entries stay for the same reason V4 Pro's
  // did (base2-free-ox-alpha / base3-free-ox-alpha in free-agents.ts): sessions
  // admitted before the deploy drain instead of failing mid-turn with
  // free_mode_invalid_agent_model. The door is shut in front of them, not under
  // them. See "Withdrawing it" in docs/freebuff-ox-alpha.md for the order.
  //
  // The zero-price fence in web/src/llm-api/openrouter.ts stays too. It costs
  // nothing while nothing is admitted, and it is the guard that would stop a
  // repriced stealth slug billing us if this row were ever restored.
  FREEBUFF_OX_ALPHA_MODEL_ID,
  // Withdrawn from free mode entirely on 2026-08-31, on cost, when the reward
  // it backed moved to GLM 5.3 Flash (FREEBUFF_REWARD_MODEL_IDS). This row was
  // reachable ONLY through that earned pool, so re-pointing the pool left it
  // reachable by nobody — and it is materially dearer per token than the row
  // that replaced it, which is the whole reason the reward moved.
  //
  // PAUSING IS LOAD-BEARING HERE AND NOT A FORMALITY, for a reason specific to
  // this row: it is `premium: true`. Dropping it from the reward pool without
  // pausing it would have let `quotaConfigForModel` fall through to the SHARED
  // DAILY PREMIUM POOL, which every full-access account holds — turning a model
  // that cost referrals to reach into one anybody could spend a premium session
  // on. That is the `crof/glm-5.2` quota-bypass failure again, arrived at from
  // the opposite direction, and this list is what closes it.
  //
  // Paused rather than deleted for the reason the three rows above give: every
  // released CLI and Desktop holds this id, an unrecognised id can only be
  // refused, and that refusal is the #1801 retry loop. Its row stays in
  // SUPPORTED_FREEBUFF_MODELS and its agent entries stay in FREE_MODE_AGENT_MODELS
  // so sessions admitted before the deploy drain instead of failing mid-turn.
  FREEBUFF_GLM_V52_MODEL_ID,
  // GEMINI 3.8 FLASH WAS HERE from 2026-09-03 to 2026-09-04 and is NOT any
  // more. Both halves of what withdrew it were measured again before it came
  // back, because only one of them had actually been fixed:
  //
  //  - ROUTING. Unpinned turns were landing on the BYOK Vertex endpoint at
  //    16.37s and 29 tok/s against AI Studio flex's 2.39s and 104 tok/s. Fixed
  //    in #2787; re-measured 2026-09-04 over 24 concurrent streaming turns,
  //    every one of which landed on Google AI Studio, non-BYOK, at the flex
  //    rate.
  //  - RELIABILITY, which is what actually withdrew it: the flex endpoint
  //    answered "Provider returned error" on roughly one probe in four. That
  //    figure does NOT reproduce — 24 of 24 turns completed with
  //    `finish_reason: stop`. The original probe capped `max_tokens` at 120,
  //    and this row reasons before it answers, so a short cap was consumed by
  //    thinking and returned an empty completion. Re-running it at a realistic
  //    budget is clean. Some of that quarter was the Vertex path, and some was
  //    the measurement.
  //
  // It comes back BEHIND THE PAYWALL rather than to where it was:
  // FREEBUFF_SUBSCRIPTION_PRO_MODEL_IDS, listed to everyone without a price and
  // openable only on a paid session. It is also Web-only now — it is in
  // FREEBUFF_WEB_MODELS and deliberately NOT back in FREEBUFF_MODELS, because
  // Pro is enforced on Web alone (FREEBUFF_PRO_ENFORCED_SURFACES) and listing
  // the dearest row in the catalog on a surface that cannot charge for it would
  // hand it out free.
]

/**
 * What a caller asking for a withdrawn model is told.
 *
 * Names the model it asked for and what to use instead — the client that sends
 * this id is a released binary whose picker still lists it, so "unavailable"
 * alone leaves the user staring at a row that looks fine and does not work.
 */
export function freebuffWithdrawnModelMessage(id: string): string {
  const model = SUPPORTED_FREEBUFF_MODELS.find((m) => m.id === id)
  const name = model?.displayName ?? id
  const replacement =
    SUPPORTED_FREEBUFF_MODELS.find((m) => m.id === DEFAULT_FREEBUFF_MODEL_ID)
      ?.displayName ?? DEFAULT_FREEBUFF_MODEL_ID
  return `${name} is no longer available in Freebuff. We recommend using ${replacement} instead.`
}

/** The same fact as `freebuffWithdrawnModelMessage`, shaped to sit inside the
 *  sentence released clients build around `availableHours` — "<model> isn't
 *  available right now (…)". Those binaries predate the `withdrawn` flag and
 *  render that field verbatim, so this is the only wording they can be told a
 *  withdrawal in. */
export function freebuffWithdrawnModelAvailabilityLabel(): string {
  const replacement =
    SUPPORTED_FREEBUFF_MODELS.find((m) => m.id === DEFAULT_FREEBUFF_MODEL_ID)
      ?.displayName ?? DEFAULT_FREEBUFF_MODEL_ID
  return `no longer offered in free mode — we recommend ${replacement}`
}

/** Suffix-tolerant like the other model predicates, so a dated provider
 *  snapshot of a paused model cannot slip past the pause. */
export function isFreebuffPausedFreeModelId(
  id: string | null | undefined,
): boolean {
  if (!id) return false
  return FREEBUFF_PAUSED_FREE_MODEL_IDS.some((modelId) =>
    freebuffModelIdMatches(id, modelId),
  )
}

// ---------------------------------------------------------------------------
// Limited-offer models
//
// A model here is NOT in any client's picker catalog. The server counts how
// many sessions the current wave has left out of one GLOBAL pool and, only
// while the pool has capacity, tells the client about it in the session
// response (`limitedModelOffers`). Clients render the extra row from that
// payload and nothing else — so when the pool is spent, the offer disappears
// with no client release, and a client that never learned about the offer is
// byte-identical to what it is today.
//
// This exists because these are frontier models we cannot afford to leave
// standing open, and because the point of running them at all is the traces:
// they are `dataUse: 'training'`, so every hour-long session lands in
// chat_completion_traces (FREEBUFF_TRACED_MODEL_IDS).
// ---------------------------------------------------------------------------

/** Models offered only while their shared global pool has sessions left. */
export const FREEBUFF_LIMITED_OFFER_MODEL_IDS = [
  FREEBUFF_FABLE_5_MODEL_ID,
] as const

export type FreebuffLimitedOfferModelId =
  (typeof FREEBUFF_LIMITED_OFFER_MODEL_IDS)[number]

/** Suffix-tolerant like the other model predicates, so a dated provider
 *  snapshot can't dodge the pool accounting. */
export function isFreebuffLimitedOfferModelId(
  id: string | null | undefined,
): boolean {
  if (!id) return false
  return FREEBUFF_LIMITED_OFFER_MODEL_IDS.some((modelId) =>
    freebuffModelIdMatches(id, modelId),
  )
}

/**
 * Per-user daily ceiling on limited-offer sessions, on top of the global pool.
 *
 * One. A 50-session pool spent by five people is five traces of five people's
 * habits; spent by fifty people it is the distribution we actually want to
 * learn from. It also bounds what one account can cost us on a frontier model
 * whose sessions run a full hour.
 */
export const FREEBUFF_LIMITED_OFFER_SESSION_LIMIT = 1

/** Reset cadence for the per-user ceiling above — same Pacific-day boundary as
 *  every other freebuff pool, so a user sees one reset time, not two. */
export const FREEBUFF_LIMITED_OFFER_SESSION_PERIOD =
  FREEBUFF_PREMIUM_SESSION_PERIOD
export const FREEBUFF_LIMITED_OFFER_SESSION_RESET_TIMEZONE =
  FREEBUFF_PREMIUM_SESSION_RESET_TIMEZONE
export const FREEBUFF_LIMITED_OFFER_SESSION_WINDOW_HOURS =
  FREEBUFF_PREMIUM_SESSION_WINDOW_HOURS

/** Freebuff Web-only picker/support set: the CLI/Desktop catalog plus the
 *  earned GLM 5.2 row. */
export const FREEBUFF_WEB_MODELS = [
  // Ox Alpha is gone from both browser pickers as of 2026-08-27. It reached
  // this list only by spreading ...FREEBUFF_MODELS, and it left that list when
  // its host ended the free promotion. Naming it here would put a PAUSED row
  // back in the picker without making it admissible — a visible row whose
  // first send is coerced away, which is the offer-without-gate shape
  // common/src/testing/freebuff-offer-invariants.ts exists to catch.
  // Muse Spark 1.2 is RETIRED from the picker as of 2026-09-02
  // (FREEBUFF_WEB_RETIRED_PICKER_MODEL_IDS) and stays here only so sessions
  // admitted on it finish their hour. Remove this entry with the row once
  // those sessions have drained.
  MUSE_SPARK_12_CONTRIBUTOR_MODEL,
  // Gemini 3.8 Flash is listed HERE rather than in FREEBUFF_MODELS, and the
  // difference is the whole gate. It is a Pro row
  // (FREEBUFF_SUBSCRIPTION_PRO_MODEL_IDS), and Pro is enforced on Freebuff Web
  // alone; naming it in FREEBUFF_MODELS would put it in the CLI and Desktop
  // pickers too, where `checkProOnlyModel` does not run and the row would be
  // served free. Web-only listing and Web-only enforcement are the same
  // decision written in two places, and they must move together.
  GEMINI_38_FLASH_MODEL,
  // GLM 5.2 LEFT on 2026-08-31, when the reward it backed moved to GLM 5.3
  // Flash and the row was withdrawn (FREEBUFF_PAUSED_FREE_MODEL_IDS). It
  // reached this list, and only this list, as the earned row the browser picker
  // rendered locked; there is nothing left for that row to unlock.
  //
  // Leaving it would be the offer-without-gate shape that
  // common/src/testing/freebuff-offer-invariants.ts exists to catch — a visible
  // row whose first send is coerced away. Removing it is ALSO what keeps it out
  // of FREEBUFF_STANDARD_MODEL_IDS, which is derived by filtering `!premium`
  // over FREEBUFF_WEB_ALL_MODELS; the pause and this removal close the two
  // halves of that door separately and both are needed.
  ...FREEBUFF_MODELS,
] as const satisfies readonly FreebuffModelOption[]

export const FREEBUFF_WEB_GOD_ONLY_MODELS = [
  KIMI_K3_ECO_MODEL,
  GPT_5_6_LUNA_ES_MODEL,
] as const satisfies readonly FreebuffModelOption[]

export const FREEBUFF_WEB_ALL_MODELS = [
  ...FREEBUFF_WEB_GOD_ONLY_MODELS,
  ...FREEBUFF_WEB_MODELS,
] as const satisfies readonly FreebuffModelOption[]

/** Derived rather than hand-listed: this is what isFreebuffWebGodOnlyModelId()
 *  checks to keep a god-only row off /api/live, /api/latency and the picker
 *  for a non-god user, and a hand-maintained second list can drift from
 *  FREEBUFF_WEB_GOD_ONLY_MODELS above without either failing to compile — the
 *  same shape FREEBUFF_ROOT_AGENT_IDS avoids relative to the base3 map. */
export const FREEBUFF_WEB_GOD_ONLY_MODEL_IDS = Object.freeze(
  FREEBUFF_WEB_GOD_ONLY_MODELS.map((model) => model.id),
)

/**
 * Web/Cloud models the picker no longer offers, while the backend keeps
 * honoring them so a session already running on one finishes normally: the id
 * stays in FREEBUFF_WEB_MODELS and in whichever quota list meters it, because
 * dropping a live session's model from the catalog fails admission mid-run and
 * dropping it from its quota list alone would leave it metered by NO pool.
 *
 * EMPTY BY DEFAULT, and the bar for adding to it is high.
 *
 * A picker-only retirement is a UI change, not a gate: the filter runs
 * client-side, so anything talking to the API directly still reaches the id.
 * Both former occupants proved it. The CrofAI GLM 5.2 route sat here from
 * 2026-07-30 and hand-written callers kept admitting free premium-pool GLM
 * sessions on it for five days. HY3 sat here since the initial web rollout.
 * Both were deleted outright on 2026-08-04.
 *
 * Park a model here ONLY to let genuinely live sessions drain, and only when
 * the id being reachable in the meantime is harmless — never as the gate
 * itself, and never for a model that costs real money or is entitlement-earned.
 * Then finish the removal.
 */
export const FREEBUFF_WEB_RETIRED_PICKER_MODEL_IDS = [
  // Muse Spark 1.2, from 2026-09-02, while sessions admitted on it drain. This
  // is the case the bar above was set for: the id being reachable meanwhile
  // is harmless because it costs exactly what its replacement costs, is
  // metered by the same premium pool, and spends the same Contributor-tier
  // budget at Meta. A saved pick is rewritten to 1.3 by `supersededBy`.
  // Finish the removal (row, roots, allowlist entries, this line) once the
  // last 1.2 session is gone — a day is plenty.
  FREEBUFF_MUSE_SPARK_12_CONTRIBUTOR_MODEL_ID,
] as const

/** Whether the Web/Cloud picker should offer `id` as a new selection. False
 *  for retired routes (see FREEBUFF_WEB_RETIRED_PICKER_MODEL_IDS), which the
 *  backend still serves for sessions already on them. */
export function isFreebuffWebSelectableModelId(
  id: string | null | undefined,
): boolean {
  if (!id) return false
  return !FREEBUFF_WEB_RETIRED_PICKER_MODEL_IDS.some(
    (modelId) => modelId === id,
  )
}

/** Models metered by the shared Web/Cloud premium pool. Public rows stay first
 *  for stable response ordering; Web-only rows derive from the same catalog
 *  metadata rather than a second entitlement list. */
export const FREEBUFF_WEB_PREMIUM_MODEL_IDS = Object.freeze([
  ...FREEBUFF_PREMIUM_MODEL_IDS,
  ...FREEBUFF_WEB_ALL_MODELS.filter(
    (model) =>
      model.premium &&
      !FREEBUFF_MODELS.some((publicModel) => publicModel.id === model.id),
  ).map((model) => model.id),
])

/**
 * Full-access models outside the premium and referral pools — i.e. the ones a
 * full-access account may use without a session quota at all, on every
 * surface.
 *
 * Derived alongside the premium list from the same catalog metadata, so every
 * full-access Web/Cloud model lands in exactly one quota class.
 *
 * Named `WEB_STANDARD` until 2026-08-18, when the browser-only session pool it
 * was named after was removed; the list itself is unchanged and is now the
 * catalog invariant several tests assert against.
 */
export const FREEBUFF_STANDARD_MODEL_IDS = Object.freeze(
  FREEBUFF_WEB_ALL_MODELS.filter((model) => !model.premium).map(
    (model) => model.id,
  ),
)

/**
 * What an earned reward session BUYS at the LIMITED access tier.
 *
 * GLM 5.3 Flash since 2026-08-31, replacing GLM 5.2 — a straight upgrade for
 * the people redeeming (a better model on a cheaper lane) and the reason GLM
 * 5.2 could be withdrawn from free mode entirely.
 *
 * LIMITED TIER ONLY, AND THAT IS THE WHOLE SHAPE OF THIS LIST. At full access
 * GLM 5.3 Flash is unmetered — it is in FREEBUFF_STANDARD_MODEL_IDS and is the
 * default pick on every surface — so "unlock GLM 5.3 Flash" would be a reward
 * for something the user already has. The full-access half of the reward is
 * therefore a different thing entirely: one EXTRA session in the shared daily
 * premium pool, resolved by the premium quota config rather than by this list
 * (see PREMIUM_QUOTA_CONFIG in web/src/server/free-session/public-api.ts).
 *
 * Two tiers, two rewards, one earned balance. Referrals, streaks and bounty
 * grants all still pay into the same ledger; what changed is that the ledger
 * no longer names one model for everybody.
 *
 * KEEP THIS AN EXPLICIT ID LIST. It used to hold GLM 5.2 while GLM 5.3 Flash
 * sat next to it as an ordinary catalog row, and every GLM predicate in this
 * file is written against an explicit list precisely so that a prefix match on
 * `z-ai/glm` could never hand one model's entitlement to the other. That
 * hazard has not gone away just because the two swapped places.
 */
export const FREEBUFF_REWARD_MODEL_ID = FREEBUFF_GLM_V53_FLASH_MODEL_ID
export const FREEBUFF_REWARD_MODEL_IDS = [FREEBUFF_REWARD_MODEL_ID] as const

/** What the reward model is CALLED, read off the catalog rather than written
 *  out, so the dozen-odd surfaces that say "you earned an X session" cannot
 *  drift from the model they actually unlock. Every one of them said "GLM 5.2"
 *  as a literal until 2026-08-31, which is why swapping the model meant editing
 *  copy in fourteen files. */
export const FREEBUFF_REWARD_MODEL_DISPLAY_NAME: string =
  SUPPORTED_FREEBUFF_MODELS.find((m) => m.id === FREEBUFF_REWARD_MODEL_ID)
    ?.displayName ?? 'GLM 5.3 Flash'


/** Wire headers for the free-mode session endpoints
 *  (/api/v1/freebuff/session). Shared so the server handlers and every client
 *  (CLI, desktop) agree on the exact strings instead of redefining literals. */
export const FREEBUFF_INSTANCE_HEADER = 'x-freebuff-instance-id'
export const FREEBUFF_MODEL_HEADER = 'x-freebuff-model'
/** Trusted server-to-server header. Only the Codebuff API may honor this when
 *  the request authenticates as the Freebuff Web service account; browser and
 *  normal API callers must not be able to select another user's session row. */
export const FREEBUFF_ACTING_USER_HEADER = 'x-freebuff-acting-user-id'
/** Trusted server-to-server companion to the acting-user header: the Freebuff
 *  Web/Cloud proxy sets it to '1' after verifying, server-side, that the
 *  acting account holds the god/admin role on Freebuff Web. Like the
 *  acting-user header it is honored only when the request authenticates as
 *  the Freebuff Web service account; from any other caller it is ignored, so
 *  forging it buys nothing. */
export const FREEBUFF_PRIVILEGED_USER_HEADER = 'x-freebuff-privileged-user'
/**
 * The house-ad click id (`bfcid`) lifted out of its first-party freebuff.com
 * cookie and carried to the Stripe checkout route on codebuff.com, which
 * stamps it onto the subscription so the webhook can report the conversion.
 *
 * Server-to-server only, and deliberately NOT a trusted header — unlike the
 * two above, forging it buys nothing at all. A bfcid must verify its HMAC at
 * the conversions endpoint before it attributes anything, so an invented value
 * yields `400 invalid_click_id` and a stolen one can only credit the campaign
 * that already earned the click.
 */
export const FREEBUFF_AD_CLICK_ID_HEADER = 'x-freebuff-bfcid'
/** The first-party cookie the hosted conversion tag banks a click id in. Same
 *  name the tag itself writes; read server-side at checkout. */
export const FREEBUFF_AD_CLICK_ID_COOKIE = 'bfcid'
/** Trusted Freebuff Web/Cloud session-proxy hint: also resolve the GLM referral
 * pool, which costs a query of its own. Set by the surfaces that render a GLM
 * row. The name is historical — every other pool is now sent unconditionally —
 * but the string stays as-is so installed clients keep working. */
export const FREEBUFF_INCLUDE_UNUSED_RATE_LIMITS_HEADER =
  'x-freebuff-include-unused-rate-limits'
/** Set by the CLI on its recurring active-session poll. The response keeps the
 *  authoritative session state but omits quota snapshots the CLI already has
 *  and does not need for its countdown. */
export const FREEBUFF_COMPACT_SESSION_HEADER = 'x-freebuff-compact-session'
/** Set to '1' by Freebuff Desktop to opt into multi-session mode (concurrent
 *  per-tab sessions); absent for CLI/web, which keep one session per user. */
export const FREEBUFF_MULTI_SESSION_HEADER = 'x-freebuff-multi-session'
/** Set to '1' on a per-instance GET /session to mark it as a liveness beat: the
 *  client is telling the server this tab is still there. Only a beat writes the
 *  row's `last_seen_at`, and only a row with a `last_seen_at` can give up its
 *  concurrency slot for going quiet — so a client that never beats keeps the
 *  `expires_at`-only rule and is never dropped mid-window. */
export const FREEBUFF_HEARTBEAT_HEADER = 'x-freebuff-heartbeat'
/** How often a beating client re-beats. The server's liveness TTL is a multiple
 *  of this (several missed beats), so a brief network blip never costs a live
 *  tab its slot. */
export const FREEBUFF_SESSION_HEARTBEAT_INTERVAL_MS = 45_000
/** Set on POST /session to the instance id of the single-slot holder the caller
 *  was just told about, meaning "end that tab's session and give me the slot"
 *  (Desktop's "Use it here"). Liveness covers a holder that stopped beating, but
 *  it cannot help when the holder is genuinely alive somewhere the user cannot
 *  reach — another machine, or a window they have no way to close — so this is
 *  the escape hatch that does not depend on us having modelled liveness right.
 *
 *  It names a holder rather than saying "take whatever is there": the server
 *  only honors it when it still matches the holder the rejection identified, so
 *  a click on a stale card can never end a tab the user was never shown. */
export const FREEBUFF_TAKEOVER_INSTANCE_HEADER =
  'x-freebuff-takeover-instance-id'
/** Drain window after a session's `expires_at`: the gate still serves an
 *  in-flight agent run, but no new prompt should start. Shared because the
 *  client has to know it too — a tab keeps beating until its row is past this,
 *  which is what lets the server tell a run that is finishing from a tab that
 *  died. Server-side accessor: `getSessionGraceMs()`. */
export const FREEBUFF_SESSION_GRACE_MS = 30 * 60 * 1000

/** How long a Desktop tab may hold its session with nothing running before the
 *  app gives the slot back.
 *
 *  Sessions are otherwise released only on tab close, sign-out and app exit, so
 *  a tab that ran one turn and was left open held the account's ONLY slot (every
 *  model on the limited tier, the premium bucket on full) for up to an hour with
 *  nothing happening in it — and every other tab's picker read as "you can't
 *  change model here".
 *
 *  Ending early is not a forfeit: the server re-stamps `session_units` to the
 *  fraction actually elapsed (`buildAdmitStampStatement`), so this REFUNDS the
 *  unused window and the next send re-admits on the same instance id. Getting it
 *  wrong costs one extra admission, not a session.
 *
 *  Ten minutes is measured against reading a long answer and typing the next
 *  prompt. Only a turn keeps the clock alive — scrolling and typing are
 *  invisible to the server half — so it is deliberately several times longer
 *  than it would need to be if it could see the user. */
/** Models that accept image input. Used to decide whether uploaded images are
 *  forwarded to the model as real multimodal content. */
export const FREEBUFF_MULTIMODAL_MODEL_IDS = Object.freeze(
  SUPPORTED_FREEBUFF_MODELS.filter((model) => model.multimodal).map(
    (model) => model.id,
  ),
)

export const FREEBUFF_WEB_MULTIMODAL_MODEL_IDS = Object.freeze(
  FREEBUFF_WEB_ALL_MODELS.filter((model) => model.multimodal).map(
    (model) => model.id,
  ),
)

/**
 * Rows that carry the training notice and whose traces we still do NOT keep.
 *
 * The derivation below is machine-readable on purpose, and this list is the one
 * exception to it — kept explicit, and deliberately hard to add to.
 *
 * Muse Spark is here because the reason not to store its traces has nothing to
 * do with which surfaces offer it: Meta trains on these prompts and completions
 * upstream regardless — that IS the Contributor discount — so our own copy buys
 * nothing that the upstream grant has not already given away. That was decided
 * when the row was Web-only, and it survives the row reaching the CLI on
 * 2026-09-04 unchanged. Without this entry the widening would have started
 * retaining users' prompts as a SIDE EFFECT of a catalog edit, which is not a
 * decision a catalog edit should be able to make.
 *
 * Delete an entry here to start tracing that row; that is the whole switch.
 */
const FREEBUFF_UNTRACED_TRAINING_MODEL_IDS: readonly string[] = [
  ...FREEBUFF_MUSE_SPARK_MODEL_IDS,
]

/** Free-mode models whose chat-completion traces we store in our own dataset
 *  (chat_completion_traces). Derived from machine-readable data-use metadata;
 *  UI wording can change without changing retention behavior. */
export const FREEBUFF_TRACED_MODEL_IDS = SUPPORTED_FREEBUFF_MODELS.filter(
  (model: FreebuffModelOption) =>
    model.dataUse === 'training' &&
    !FREEBUFF_UNTRACED_TRAINING_MODEL_IDS.some((id) => id === model.id),
).map((model) => model.id)

export type FreebuffModelId = (typeof FREEBUFF_MODELS)[number]['id']
export type SupportedFreebuffModelId =
  (typeof SUPPORTED_FREEBUFF_MODELS)[number]['id']
export type FreebuffWebModelId = (typeof FREEBUFF_WEB_ALL_MODELS)[number]['id']

/** What new freebuff users see selected in the CLI and Desktop pickers, and the
 *  model their "RECOMMENDED" hero opens on. DeepSeek V4 Flash 07/31 as of
 *  2026-09-02 (unmetered on the Luminal lane; it carries the AI-training
 *  notice, and it is also the limited tier's default). The paragraphs below
 *  were written for the GLM 5.3 Flash default of 2026-08-30 and still hold.
 *
 *  THE FIRST DEFAULT SINCE 2026-08-18 THAT IS NOT PREMIUM, and that is the
 *  substantive change rather than a detail. Every default in between drew on the
 *  shared daily pool, which made a step-down mandatory for anything holding a
 *  live quota — getRecommendedFreebuffModelId's `premiumExhausted`, Desktop's
 *  availableFreebuffDefault — because otherwise the recommended pick became a
 *  model whose next send fails admission. That machinery all still exists and
 *  still serves the limited tier, but it is no longer load-bearing here: this
 *  row is unmetered and uncapped, so a new user's first send cannot fail for
 *  want of quota.
 *
 *  It is also `availability: 'always'` and the cheapest row we serve
 *  (measured per-message, 4.6x under MiMo and 8.9x under V4 Flash). The cost
 *  and availability arguments are therefore both strictly better than the Luna
 *  it replaces. Latency used to be the argument it LOST, while it ran unset on
 *  the wire; since 2026-08-31 it is pinned to `high` (see
 *  GLM_V53_FLASH_REASONING_EFFORTS for why) and that gap is closed.
 *
 *  Still three separate constants: this one, DEFAULT_FREEBUFF_WEB_MODEL_ID and
 *  FALLBACK_FREEBUFF_MODEL_ID (what callers needing a guaranteed-available id
 *  for resolution / auto-fallbacks should use). The first two name the same
 *  model today and have diverged before; the third is genuinely a different
 *  model rather than the same one under two names.
 *
 *  Unlike the Luna and Flash defaults before it, this row carries NO
 *  AI-training notice (`dataUse: 'service'`), so the disclosure a first-time
 *  user sees changes — pickers still render `warning`, there is simply no
 *  longer one to render on the default row. */
export const DEFAULT_FREEBUFF_MODEL_ID: FreebuffModelId =
  FREEBUFF_GLM_V53_FLASH_MODEL_ID

/** The default this one replaced, and the stamp of the one-time move of saved
 *  picks off it (util/freebuff-default-model-migration.ts). Every surface
 *  persists the model a session ran on, so a saved old default is usually
 *  inherited, not chosen. Bump both together at the next flip. */
export const PREVIOUS_DEFAULT_FREEBUFF_MODEL_ID: FreebuffModelId =
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID
export const FREEBUFF_DEFAULT_MODEL_MIGRATION_ID =
  'glm-5.3-flash-2026-09-05'

/** What new Freebuff Web/Cloud users see selected in the browser pickers, and
 *  the model a new Cloud thread starts on. DeepSeek V4 Flash 07/31 as of
 *  2026-09-02, moving with DEFAULT_FREEBUFF_MODEL_ID rather than independently.
 *
 *  The browser surfaces are where this default matters most and where the trade
 *  cuts both ways hardest. A browser build is one long agentic run against a
 *  live sandbox, where a wrong turn early costs the whole first project — and
 *  51% of Web users never come back from a failed one. That argument has always
 *  favoured the deepest row available, and this IS the deep row, which is the
 *  case for it here.
 *
 *  Against that: browser turns re-send their whole prefix every step, so these
 *  surfaces are the most latency-sensitive we have, and preparation already
 *  costs ~6.3s at p50 before a token (docs/freebuff-ttft-deferred-vm.md). The
 *  deep default this comment expected to have to walk back HAS been walked back
 *  — the row was pinned to `high` on 2026-08-31, for looping rather than for
 *  latency (see GLM_V53_FLASH_REASONING_EFFORTS) — so the per-step reasoning
 *  cost this paragraph warned about is already paid down. If first-run
 *  completion still moves the wrong way, the next lever is a different model,
 *  not a lower rung.
 *
 *  The cost half is not close. Cache reads are ~98% of browser tokens, and this
 *  row's list cache-read rate is nearly double Luna's — but measured per
 *  message on the traffic that actually runs it bills an order of magnitude
 *  LESS than Luna (figures in the internal cost notes, not here).
 *
 *  Kept as its own constant from DEFAULT_FREEBUFF_MODEL_ID (CLI/Desktop) so the
 *  browser surfaces can steer independently. They name the same model today and
 *  diverged as recently as 2026-08-04 -> 2026-08-12. */
export const DEFAULT_FREEBUFF_WEB_MODEL_ID: FreebuffWebModelId =
  FREEBUFF_GLM_V53_FLASH_MODEL_ID

/** Premium models the Web/Cloud picker renders small and muted: they are
 *  materially more expensive per token than the recommended default without
 *  being materially better for the browser surfaces' workloads. They stay
 *  fully selectable — this only controls emphasis and ordering (they sort last
 *  within the Premium group).
 *
 *  This tracks the models Flash superseded — costing more per token AND having
 *  lost the quality argument — so muting them is what steers new picks to Flash.
 *  Both halves of that test have to hold: DeepSeek V4 Pro left this list on
 *  2026-08-12 because its 08/13 GA build wins the quality half again.
 *
 *  EMPTY as of 2026-08-12. MiniMax M3 was the last entry, and with Pro gone it
 *  was the only muted row in a list of full-size ones — the compact treatment
 *  folds the tagline up onto the name line, which next to four two-line rows
 *  read as a broken row rather than as a de-emphasized one. M3 keeps its
 *  supersededBy notice, which is the steering that was doing the real work.
 *  Muting only pays for itself on a group of rows, so add entries back in
 *  pairs or not at all.
 *
 *  GPT-5.6 Luna is superseded (by Pro) and deliberately NOT muted. The cost
 *  half of that call used to be genuinely unresolvable; DeepSeek's 16:00 UTC
 *  2026-08-16 repricing resolved it the other way. Per M — Luna read off
 *  OpenRouter 2026-08-12, Pro from DeepSeek's published card:
 *
 *                    fresh input   cache read   output
 *    V4 Pro off-peak    $0.660       $0.022      $1.980
 *    V4 Pro peak        $1.320       $0.044      $3.960
 *    Luna               $0.100       $0.010      $0.600
 *
 *  Pro was 2.76x cheaper than Luna on cache reads — the term that dominates an
 *  agent workload, where re-sent prefixes are ~98% of tokens. It is now 2.2x
 *  dearer off-peak and 4.4x dearer at peak, and it was already dearer on fresh
 *  input and output. So Pro is now dearer than Luna on every term in every
 *  window, and "materially more expensive" is a claim that has moved onto the
 *  OTHER row.
 *
 *  This list is still EMPTY and Pro is still the Web default — muting is a
 *  product-steering decision and the repricing alone should not silently flip
 *  it. But the numbers that justified both no longer say what they said; this
 *  is the note for whoever revisits it. */
export const FREEBUFF_WEB_DEEMPHASIZED_MODEL_IDS: readonly FreebuffModelId[] =
  []

export function isFreebuffWebDeemphasizedModelId(
  id: string | null | undefined,
): boolean {
  if (!id) return false
  return FREEBUFF_WEB_DEEMPHASIZED_MODEL_IDS.some((modelId) =>
    freebuffModelIdMatches(id, modelId),
  )
}

/** Always-available fallback used when the requested model can't be served
 *  right now (unknown id, deployment hours closed, premium pool spent). Kept
 *  distinct from DEFAULT_FREEBUFF_MODEL_ID so a new user's "preferred default"
 *  can be the smartest model without auto-flipping anyone to a closed
 *  serverless model.
 *
 *  MUST BE NON-PREMIUM. This is the id every surface steps down TO when the
 *  daily premium pool runs dry, so a premium value here is a step-down onto a
 *  model that fails admission for exactly the user it was meant to rescue — a
 *  loop, not a fallback. That is why it moved off Flash on 2026-08-18 the same
 *  hour Flash became premium: the two edits are one change, and restoring
 *  either alone re-creates the loop.
 *
 *  MiMo 2.5, the cheapest row we serve, which is what the token-heavy Cloud
 *  planner and build paths reading this want. A separate constant from
 *  LIMITED_FREEBUFF_MODEL_ID (the limited hero) on purpose. */
export const FALLBACK_FREEBUFF_MODEL_ID: FreebuffModelId =
  FREEBUFF_MIMO_V25_MODEL_ID

/** The limited tier's hero, and the model an out-of-tier or stale pick is
 *  coerced to. The same row as the full-access default since 2026-09-02. */
// Since 2026-09-07 this is the COERCION TARGET and no longer the hero: the
// row an out-of-tier or stale pick is rewritten to, and the row a limited
// session is substituted onto. The hero — what the picker leads with and
// Enter lands on — is LIMITED_FREEBUFF_HERO_MODEL_ID below. They were one
// constant until then; splitting them is what lets the limited tier
// recommend GLM 5.3 Flash while keeping a coercion target that is joinable
// with NO meter, NO grant and NO plan.
//
// Why the two differ: at limited access without a plan, OFF the Freebucks
// meter, GLM is metered by the EARNED reward balance, so a limited user who
// has earned nothing has it locked. The meter now covers every account
// (audience `all`, 2026-09-05) and prices GLM at 5 on every tier, which is
// why GLM can be the hero — but the audience knob is also the documented
// rollback for Freebucks, and a rollback must not turn every coerced limited
// pick into a refusal. DeepSeek V4 Flash stays here because it is joinable
// under every configuration this server can be in.
export const LIMITED_FREEBUFF_MODEL_ID: FreebuffModelId =
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID
/** The limited tier's HERO — the row its pickers lead with and recommend —
 *  as distinct from the coercion target above. GLM 5.3 Flash since
 *  2026-09-07: it is the cheapest row we serve (~5x under DeepSeek V4 Flash
 *  per message, and Flash carried 51.6% of a day's cost on 2026-09-06 with
 *  17k users to GLM's 3.5k), it is priced at 5 Freebucks on every tier, and
 *  the limited tier was the last surface still leading with the dear row.
 *  Reachable at limited access because every account is on the meter; if the
 *  meter is ever rolled back, every picker already repairs a locked hero onto
 *  the next joinable row (the CLI's grid repair, Desktop's `canStart` filter),
 *  and the server coerces onto LIMITED_FREEBUFF_MODEL_ID, never onto this. */
export const LIMITED_FREEBUFF_HERO_MODEL_ID: FreebuffModelId =
  FREEBUFF_GLM_V53_FLASH_MODEL_ID
/**
 * The limited tier's catalog, hero first — the ONE owner of which models are
 * limited-tier: the web geo-exempt list, the quota pool, and chat's list all
 * derive from it. The tier is metered by region rather than by model, so a
 * row here widens what those users may pick, not how much they get. Removing a
 * row is not a no-op for installed clients: admission coerces their pick and
 * the chat gate must substitute rather than refuse (#1801).
 */
// Ox Alpha joined the limited tier on 2026-08-24 and LEFT it on 2026-08-27,
// when its host ended the free promotion (FREEBUFF_PAUSED_FREE_MODEL_IDS).
// Limited access is metered by REGION rather than by model, so this narrows
// what those users may pick without changing how much they get.
//
// Removing it here is not what stops it being served — the pause is — but this
// list is mapped over SUPPORTED_FREEBUFF_MODELS to build
// LIMITED_FREEBUFF_MODELS, which reaches the CLI picker, the home FAQ and the
// README. Leaving it would advertise a row nothing may admit.
//
// It left FREEBUFF_WEB_GEO_EXEMPT_MODEL_IDS in the same change, so the two
// limited catalogs still agree for this row.
//
// Solar Pro 4 joined on 2026-09-03. Limited access is still metered by the
// regional pool, so this widens the catalog without making that tier unmetered.
export const LIMITED_FREEBUFF_MODEL_IDS = [
  // Hero first (LIMITED_FREEBUFF_HERO_MODEL_ID). GLM 5.3 Flash since
  // 2026-09-07 — see LIMITED_FREEBUFF_MODEL_ID for why the coercion target
  // is a different row.
  FREEBUFF_GLM_V53_FLASH_MODEL_ID,
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_MIMO_V25_MODEL_ID,
  ...(FREEBUFF_SOLAR_PRO_4_ENTITLEMENT.limitedAccess
    ? [FREEBUFF_SOLAR_PRO_4_ENTITLEMENT.modelId]
    : []),
] as const
export const LIMITED_FREEBUFF_MODELS = LIMITED_FREEBUFF_MODEL_IDS.map(
  (modelId) => SUPPORTED_FREEBUFF_MODELS.find((model) => model.id === modelId)!,
)

/** The `session_model_mismatch` message for a limited-tier caller naming a
 *  model the tier cannot run; derived so it cannot lag the catalog again. */
export const LIMITED_FREEBUFF_MODEL_MISMATCH_MESSAGE = `Limited free access is only available with ${LIMITED_FREEBUFF_MODELS.map(
  (model) => model.displayName,
).join(' or ')}.`

/** Access tier carried in the Freebuff Web Convex JWT. Extends the CLI tier
 *  with 'blocked' (Tor / corroborated anonymous network): the app still
 *  loads, but every agent send is rejected server-side. */
export type FreebuffWebAccessTier = FreebuffAccessTier | 'blocked'

/** How many of a user's projects may have an agent RUNNING at the same time on
 *  Freebuff Web/Cloud. Past the cap the take-over prompt appears, and taking
 *  over stops only the longest-idle run.
 *
 *  STILL 1 — and raising it is a one-line change here ONLY once Freebuff Web is
 *  on the per-tab (multi-session) free-session store. On the single-session
 *  store the web surface uses today, `admitOrTakeOver` rotates
 *  `active_instance_id` on EVERY `requestSession`, including a same-model live
 *  reclaim (web/src/server/free-session/store.ts). So the moment a second
 *  project admitted its session, the first project's in-flight turn would fail
 *  its next completions call with `session_superseded` — concurrency that
 *  silently kills the run the user is watching. Desktop already runs concurrent
 *  per-tab sessions via `requestSession({ multiSession, instanceId })`; wiring
 *  Web to the same path (session request header + `freebuff_multi_session` in
 *  the runner's `codebuff_metadata`) is what unblocks 2.
 *
 *  Everything else is already cap-agnostic: rows are per (user, project) and
 *  only `agent_running` ones count, so opening or reading a second project is
 *  free at any cap — that part shipped 2026-08-12. */
export const FREEBUFF_MAX_CONCURRENT_PROJECTS = 1

/** Abuse backstop on project creation for outer-region (limited-tier) Freebuff
 *  Web users. A project the user still has consumes one slot — creations that
 *  failed and were rolled back do not, so a bad creation never costs quota.
 *  The quota resets at midnight Pacific time.
 *
 *  This was 3 until 2026-08-12, which real users hit on their first session:
 *  every rung of the creation ladder (warm pool → cold Daytona → browser
 *  runtime) mints its own project row, so a couple of failed first builds
 *  locked someone out for the day with nothing to show for it. 10 is high
 *  enough that only automation reaches it. */
/** Per-day cap on new Web projects a user may create, in EVERY region.
 *
 *  Was 10 and limited-region only until 2026-08-19, when the Daytona US quota
 *  saturated (498/500 vCPU, 996/1000 GiB). Measured against a full day of
 *  traffic at the time — 1,893 user-owned creations across 1,484 users, mean
 *  1.3 — a cap of 5 would have blocked 41 creations (2.2%) across 11 users,
 *  and the single heaviest account created 14. So this bounds the worst case
 *  rather than reclaiming capacity; the routing change that moved
 *  limited-region desktops to Nodepod is what actually moved the number.
 *
 *  Override per deployment with FREEBUFF_WEB_PROJECT_DAILY_LIMIT. */
export const FREEBUFF_WEB_PROJECT_DAILY_LIMIT = 5

/** How many of a user's sandboxes may be running at once. A sandbox counts as
 *  open while its project has an agent run in flight or has proven presence
 *  inside Daytona's 10-minute auto-stop window.
 *
 *  Set to the highest concurrency any single account was actually observed
 *  holding on 2026-08-19 (2, across just 12 of ~1,485 daily-active owners), so
 *  it binds nobody today and only stops that number growing.
 *
 *  Override per deployment with FREEBUFF_WEB_MAX_OPEN_SANDBOXES. */
export const FREEBUFF_WEB_MAX_OPEN_SANDBOXES = 2

/** Per-day cap on blank ("plan a custom stack") Cloud projects, which unlike
 *  connect-repo need no GitHub App install and each boot a full-size VM. Same
 *  backstop role — and the same rollback exemption — as the web limit above.
 *  Resets at midnight Pacific time. */
export const FREEBUFF_CLOUD_BLANK_PROJECT_DAILY_LIMIT = 10

/** Per-project ceiling on custom-stack planner turns.
 *
 * The planner is a free premium-model chat that never touches a sandbox, so
 * without a ceiling one blank project is an unbounded free MiniMax M3
 * conversation — the cheapest abuse route into the premium pool, since it skips
 * the VM work every other free surface pays for.
 *
 * Sized well above honest use: the prompt caps discovery at two question
 * rounds, so a real conversation is a seed turn, two answers, and a few stack
 * revisions. Hitting this means the plan is not converging.
 *
 * Only planning turns count. "Start building" is a separate mutation, so a user
 * who exhausts the cap with a finished plan can still build — they just cannot
 * keep chatting. */
export const FREEBUFF_CLOUD_PLANNER_TURN_LIMIT = 12

/**
 * Models available to limited-region Freebuff Web users.
 *
 * **Widened 2026-09-04 to the whole Web free catalog except the rows a plan
 * unlocks at limited access.**
 * It used to alias `LIMITED_FREEBUFF_MODEL_IDS` (Flash, MiMo, Solar), which
 * left limited regions without the CHEAPEST row we serve — GLM 5.3 Flash at 5
 * Freebucks an hour, a third of the Flash price — so the tier that can least
 * afford a session was also the one barred from the cheap one.
 *
 * What makes this safe is that the tier is no longer metered by CATALOG. On
 * the Freebucks meter a limited account holds 25 Freebucks a day under a hard
 * $0.50 daily ceiling, and every row is priced, so widening WHAT they may pick
 * cannot widen HOW MUCH they draw — it only lets them spend the same allowance
 * on a row that goes further. Before the meter, catalog WAS the control, which
 * is why this list was narrow.
 *
 * Luna is the deliberate full-access exception: it stays plan-gated only at
 * the limited tier
 * (`isFreebuffSubscriptionModelIdForAccessTier` admits it only with a live
 * paid plan there), while a full-access account may spend its ordinary premium
 * allowance on it. The Web picker lists it locked at limited access rather
 * than hiding it, so the row is an offer instead of an absence.
 *
 * Its own name, and NOT `LIMITED_FREEBUFF_MODEL_IDS`, because this is a
 * broader browser catalog: CLI/Desktop also offer GLM 5.3 Flash, while
 * the other additions remain browser-only. Note the consequence, since it is not
 * obvious — `isFreebuffSessionModelAllowedForAccessTier` takes the UNION of
 * both limited lists for every surface, so a hand-edited CLI config naming one
 * of these now passes admission where it used to be refused. That is the
 * existing, deliberate shape of that gate (a shared admission path must accept
 * every row any surface may legitimately offer); the rows it newly admits are
 * the cheap ones, and the limited pool meters by tier rather than by model, so
 * it costs no more per session there than Flash already did.
 */
/**
 * Model ids only a PAID session may open.
 *
 * Defined in the CATALOG rather than in freebuff-subscriptions.ts, which is
 * where it is published from as `FREEBUFF_SUBSCRIPTION_PRO_MODEL_IDS` and where
 * its policy is documented. It lives here because this file needs it and
 * cannot import that one — freebuff-subscriptions.ts already imports this
 * module, so the dependency only runs one way.
 *
 * The limited-tier plan-only set below extends this one. Defining the global
 * paid boundary once keeps a future Pro row out of the free limited catalog
 * without making Luna globally Pro-only just because it has the narrower
 * limited-tier restriction.
 */
export const FREEBUFF_PRO_ONLY_CATALOG_MODEL_IDS: readonly string[] =
  Object.freeze([FREEBUFF_GEMINI_38_FLASH_MODEL_ID])

/** Whether the catalog marks `id` openable only on a paid session. Exact match:
 *  the suffix-tolerant public predicate is
 *  `isFreebuffSubscriptionProModelId`. */
export function isFreebuffProOnlyCatalogModelId(id: string): boolean {
  return FREEBUFF_PRO_ONLY_CATALOG_MODEL_IDS.includes(id)
}

/**
 * Rows an unpaid LIMITED-tier account cannot open.
 *
 * Every globally Pro-only row belongs here, plus Luna: Luna is part of the
 * ordinary full-access premium pool, but a paid plan is still what unlocks it
 * at limited access. Keeping this distinction explicit prevents the global Pro
 * gate from accidentally paywalling full-access users just to preserve the
 * limited-tier catalog boundary.
 */
export const FREEBUFF_LIMITED_TIER_PLAN_ONLY_MODEL_IDS: readonly string[] =
  Object.freeze([
    FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
    ...FREEBUFF_PRO_ONLY_CATALOG_MODEL_IDS,
  ])

export function isFreebuffLimitedTierPlanOnlyModelId(id: string): boolean {
  return FREEBUFF_LIMITED_TIER_PLAN_ONLY_MODEL_IDS.includes(id)
}

export const FREEBUFF_WEB_GEO_EXEMPT_MODEL_IDS: readonly string[] = [
  ...new Set<string>([
    ...LIMITED_FREEBUFF_MODEL_IDS,
    ...FREEBUFF_WEB_MODELS.filter(
      (model) =>
        isFreebuffWebSelectableModelId(model.id) &&
        !isFreebuffWebGodOnlyModelId(model.id) &&
        // This is deliberately broader than the global Pro set. Luna is free
        // from the premium pool at full access but still plan-locked here;
        // Gemini 3.8 Flash is plan-only at every tier.
        !isFreebuffLimitedTierPlanOnlyModelId(model.id),
    ).map((model) => model.id),
  ]),
]

export function isFreebuffWebGeoExemptModelId(
  id: string | null | undefined,
): boolean {
  if (!id) return false
  return FREEBUFF_WEB_GEO_EXEMPT_MODEL_IDS.some((modelId) => modelId === id)
}

/** Models a limited-tier Freebuff Web user may select. */
export const FREEBUFF_WEB_LIMITED_MODEL_IDS = [
  ...new Set<string>([
    ...FREEBUFF_WEB_GEO_EXEMPT_MODEL_IDS,
    ...LIMITED_FREEBUFF_MODEL_IDS,
  ]),
]

export function isFreebuffWebModelAllowedForLimitedTier(
  id: string | null | undefined,
  /** See `hasPaidSubscription` on isFreebuffSessionModelAllowedForAccessTier. */
  hasPaidSubscription = false,
): boolean {
  if (!id) return false
  // GLM 5.2 is selectable from a limited region when the user holds a bounty
  // grant — the entitlement gate is the GLM quota pool, not this allowlist
  // (see isRewardModelRedeemableAtLimitedTier). Without this the Web picker coerced a
  // GLM pick straight back to the flash model, so a bounty reward earned in a
  // limited region was unspendable no matter what the server allowed.
  //
  // A paid plan is the same shape of problem and had the same bug: the server
  // widened admission for subscribers (see the predicate above) while this
  // allowlist did not, so the Web picker coerced every plan model straight back
  // to MiMo. A limited-region subscriber paid and could select nothing they
  // had bought.
  return (
    isRewardModelRedeemableAtLimitedTier(id) ||
    FREEBUFF_WEB_LIMITED_MODEL_IDS.some((modelId) => modelId === id) ||
    (hasPaidSubscription && isFreebuffSubscriptionModelIdForAccessTier(id))
  )
}

/** Coerce a limited-tier Freebuff Web selection (premium ids, stale
 * localStorage values) to LIMITED_FREEBUFF_MODEL_ID. */
export function resolveFreebuffWebModelForLimitedTier(
  id: string | null | undefined,
  /** See `hasPaidSubscription` on isFreebuffSessionModelAllowedForAccessTier. */
  hasPaidSubscription = false,
): string {
  return isFreebuffWebModelAllowedForLimitedTier(id, hasPaidSubscription)
    ? (id as string)
    : LIMITED_FREEBUFF_MODEL_ID
}

export function getFreebuffModelsForAccessTier(
  accessTier: FreebuffAccessTier | null | undefined,
  /** See `hasPaidSubscription` on isFreebuffSessionModelAllowedForAccessTier.
   *
   *  Read from the session response's `subscription.tierId` — non-null exactly
   *  when the server resolved an ENTITLING row — rather than from anything the
   *  client decides for itself. A picker that widened on its own belief would
   *  offer rows admission then refuses. */
  hasPaidSubscription = false,
): readonly FreebuffModelOption[] {
  if (accessTier !== 'limited') return FREEBUFF_MODELS
  if (!hasPaidSubscription) return LIMITED_FREEBUFF_MODELS
  // Plan rows are appended rather than merged in catalog order: the limited
  // rows are what this account can still run for free once the plan's windows
  // are spent, so they stay first and keep their picker position.
  const planModels = FREEBUFF_MODELS.filter(
    (model) =>
      isFreebuffSubscriptionModelIdForAccessTier(model.id) &&
      !LIMITED_FREEBUFF_MODELS.some((limited) => limited.id === model.id),
  )
  return [...LIMITED_FREEBUFF_MODELS, ...planModels]
}

/** The model the CLI/Desktop picker highlights as the "recommended" hero so a
 *  new user can start with one Enter press without scanning the full list. Full
 *  access → DEFAULT_FREEBUFF_MODEL_ID (GPT-5.6 Luna); limited →
 *  LIMITED_FREEBUFF_MODEL_ID (MiMo 2.5). Both names are restated here because
 *  this docblock twice outlived the constants it described — it still named V4
 *  Pro and V4 Flash on 2026-08-24, long after neither was returned.
 *
 *  The hero is premium, so ALWAYS pass `premiumExhausted` from the live quota
 *  snapshot: it flips to FALLBACK_FREEBUFF_MODEL_ID once the daily pool runs
 *  out, because the recommended pick has to stay joinable. A caller that omits
 *  it will offer a hero whose next send fails admission. */
export function getRecommendedFreebuffModelId(
  accessTier: FreebuffAccessTier | null | undefined,
  options: { premiumExhausted?: boolean } = {},
): SupportedFreebuffModelId {
  if (accessTier === 'limited') return LIMITED_FREEBUFF_HERO_MODEL_ID
  // The step-down fires only if the default actually DRAWS on the pool that ran
  // dry. It used to fire unconditionally, which was correct for as long as
  // every default was premium (2026-08-18 onwards) and became wrong the moment
  // one was not: an unmetered default is unaffected by a spent premium pool, so
  // stepping off it would move a user from the row they were offered to a
  // different unmetered row for no reason, and tell them their quota caused it.
  if (
    options.premiumExhausted &&
    isFreebuffPremiumModelId(DEFAULT_FREEBUFF_MODEL_ID)
  ) {
    return FALLBACK_FREEBUFF_MODEL_ID
  }
  return DEFAULT_FREEBUFF_MODEL_ID
}

/** The Web/Cloud counterpart of getRecommendedFreebuffModelId: full access →
 *  DEFAULT_FREEBUFF_WEB_MODEL_ID (GPT-5.6 Luna); limited →
 *  LIMITED_FREEBUFF_MODEL_ID. `premiumExhausted` flips the hero to the
 *  unlimited flash model so the recommended pick is always joinable. */
export function getRecommendedFreebuffWebModelId(
  accessTier: FreebuffAccessTier | null | undefined,
  options: { premiumExhausted?: boolean } = {},
): FreebuffWebModelId {
  if (accessTier === 'limited') return LIMITED_FREEBUFF_HERO_MODEL_ID
  // Same condition as getRecommendedFreebuffModelId, and for the same reason —
  // see the comment there. Keyed off the WEB default, since the two constants
  // are allowed to name different models and have done.
  if (
    options.premiumExhausted &&
    isFreebuffPremiumModelId(DEFAULT_FREEBUFF_WEB_MODEL_ID)
  ) {
    return FALLBACK_FREEBUFF_MODEL_ID
  }
  return DEFAULT_FREEBUFF_WEB_MODEL_ID
}

/** Reward ids stay nameable at limited access. Legacy accounts fund them from
 * bounty grants; Freebucks audience accounts use their currency balance.
 * Picker membership and paid-plan access are separate from this quota rule. */
export function isRewardModelRedeemableAtLimitedTier(
  model: string | null | undefined,
): boolean {
  return FREEBUFF_REWARD_MODEL_IDS.some((modelId) => modelId === model)
}

export function isFreebuffModelAllowedForAccessTier(
  model: string | null | undefined,
  accessTier: FreebuffAccessTier | null | undefined,
  /** See `hasPaidSubscription` on isFreebuffSessionModelAllowedForAccessTier.
   *  Defaults false, so a caller that cannot answer keeps today's behaviour. */
  hasPaidSubscription = false,
): boolean {
  if (!model) return false
  if (accessTier !== 'limited') return isFreebuffModelId(model)
  return (
    isRewardModelRedeemableAtLimitedTier(model) ||
    LIMITED_FREEBUFF_MODEL_IDS.some((modelId) => modelId === model) ||
    // A plan reaches limited regions. Gated on isFreebuffModelId as well, so
    // this only ever widens to a row this catalog actually offers.
    (hasPaidSubscription &&
      isFreebuffSubscriptionModelIdForAccessTier(model) &&
      isFreebuffModelId(model))
  )
}

/** Session admission is shared by CLI/Desktop/Web/Cloud. Client pickers use
 *  FREEBUFF_MODELS or FREEBUFF_WEB_MODELS, while the server accepts their union
 *  with temporarily retired models from SUPPORTED_FREEBUFF_MODELS. */
export function isFreebuffSessionModelId(
  id: string | null | undefined,
): id is SupportedFreebuffModelId | FreebuffWebModelId {
  return (
    isSupportedFreebuffModelId(id) ||
    isFreebuffWebModelId(id, {
      includeGodOnly: true,
    })
  )
}

export function isFreebuffSessionModelAllowedForAccessTier(
  model: string | null | undefined,
  accessTier: FreebuffAccessTier | null | undefined,
  /**
   * Whether this account holds a live PAID plan.
   *
   * A limited-region account is normally held to the limited catalog, which
   * contains none of the models a plan meters — so without this a subscriber
   * there would pay and receive nothing at all. A completed card payment is
   * the strongest signal available that an account is a real customer rather
   * than the abuse the tier exists to contain, so it widens WHAT may be
   * picked. It does NOT widen how much: the plan's own windows still meter
   * every session, and the free limited pool is unchanged.
   *
   * Defaults false, so every caller that cannot answer the question keeps
   * today's behaviour.
   */
  hasPaidSubscription = false,
): boolean {
  if (!model) return false
  // A paused model is allowed to NO tier. Checked ahead of everything else
  // because the pause is the whole point: it is still a recognised session id
  // (see FREEBUFF_PAUSED_FREE_MODEL_IDS), so every other branch here would
  // happily admit it.
  if (isFreebuffPausedFreeModelId(model)) return false
  if (accessTier !== 'limited') return isFreebuffSessionModelId(model)
  // See isRewardModelRedeemableAtLimitedTier: GLM's limited-tier gate is the quota
  // pool (bounty grants only), not this allowlist.
  //
  // The UNION of both limited catalogs, for the same reason the full-access
  // branch above takes the union of both full catalogs: session admission is
  // shared by CLI, Desktop, Web and Cloud, so it must accept every row ANY of
  // them may legitimately offer. Reading only the CLI/Desktop list
  // (LIMITED_FREEBUFF_MODEL_IDS) is what it did until Ox Alpha, which was
  // harmless only while the two lists happened to agree — the moment a
  // browser-only row reaches limited regions, that version offers a picker row
  // whose first send fails admission with session_model_mismatch.
  //
  // Widening WHAT a limited user may pick, not how much: the limited pool is
  // keyed on the tier rather than the model.
  return (
    isRewardModelRedeemableAtLimitedTier(model) ||
    FREEBUFF_WEB_LIMITED_MODEL_IDS.some((modelId) => modelId === model) ||
    // Paid plans reach limited regions too — see `hasPaidSubscription`.
    (hasPaidSubscription && isFreebuffSubscriptionModelIdForAccessTier(model))
  )
}

/**
 * The models a plan's pooled allowance may be spent on.
 *
 * Defined HERE and published from `freebuff-subscriptions.ts` as
 * `FREEBUFF_SUBSCRIPTION_MODEL_IDS`, for the reason
 * FREEBUFF_PRO_ONLY_CATALOG_MODEL_IDS gives: that module imports this one, so
 * the dependency can only run this way, and this file needs the set.
 *
 * It was DUPLICATED into a predicate here until 2026-09-04, with a drift test
 * standing in for the missing import. The test worked — it is what caught
 * Gemini 3.8 Flash being added to the plan and not to this list — but a guard
 * that reports drift after the fact is weaker than not being able to drift,
 * and every id added to a plan from now on has one place to be added.
 *
 * A plan can only cover a model admission will actually open. GLM 5.3 Flash
 * sits in the slot DeepSeek V4 Pro held until its withdrawal from free mode on
 * 2026-08-26.
 */
export const FREEBUFF_PLAN_METERED_CATALOG_MODEL_IDS: readonly string[] =
  Object.freeze([
    FREEBUFF_GLM_V53_FLASH_MODEL_ID,
    FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
    FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
    FREEBUFF_KIMI_K3_ECO_MODEL_ID,
    FREEBUFF_GEMINI_38_FLASH_MODEL_ID,
  ])

/**
 * Whether a plan meters this model, as a local predicate.
 *
 * Exported because the limited-tier widening it drives is not one gate but a
 * CHAIN — picker catalog, explicit-pick resolution, session admission, the
 * session row's tier compatibility, and the chat gate's coercion. Every one of
 * them has to agree on the same set of ids or a subscriber sees a row they
 * cannot start, or starts a session that silently runs a different model.
 */
export function isFreebuffSubscriptionModelIdForAccessTier(
  model: string | null | undefined,
): boolean {
  if (!model) return false
  return FREEBUFF_PLAN_METERED_CATALOG_MODEL_IDS.includes(model)
}

export function isFreebuffModelId(
  id: string | null | undefined,
): id is FreebuffModelId {
  if (!id) return false
  return FREEBUFF_MODELS.some((m) => m.id === id)
}

export function isFreebuffWebModelId(
  id: string | null | undefined,
  options: { includeGodOnly?: boolean } = {},
): id is FreebuffWebModelId {
  if (!id) return false
  const models = options.includeGodOnly
    ? FREEBUFF_WEB_ALL_MODELS
    : FREEBUFF_WEB_MODELS
  return models.some((m) => m.id === id)
}

export function isFreebuffWebGodOnlyModelId(
  id: string | null | undefined,
): boolean {
  if (!id) return false
  return FREEBUFF_WEB_GOD_ONLY_MODEL_IDS.some((modelId) => modelId === id)
}

export function resolveFreebuffModel(
  id: string | null | undefined,
): FreebuffModelId {
  return isFreebuffModelId(id) ? id : FALLBACK_FREEBUFF_MODEL_ID
}

export function resolveFreebuffWebModel(
  id: string | null | undefined,
  options: { includeGodOnly?: boolean } = {},
): FreebuffWebModelId {
  return isFreebuffWebModelId(id, options)
    ? id
    : (FALLBACK_FREEBUFF_MODEL_ID as FreebuffWebModelId)
}

/** Resolve an explicit CLI selection for an access tier. The ordinary picker
 * uses `FREEBUFF_MODELS`; a limited-tier user may also hold an earned reward
 * balance for the reward model, and a full-access user may have been told about
 * a limited-offer model this launch. Both live outside what the tier's picker
 * lists, so without these passes an explicit pick of either would be silently
 * rewritten to the fallback model — the user would press Enter on Fable and
 * land on DeepSeek. */
export function resolveFreebuffModelForAccessTier(
  id: string | null | undefined,
  accessTier: FreebuffAccessTier | null | undefined,
  /** See `hasPaidSubscription` on isFreebuffSessionModelAllowedForAccessTier. */
  hasPaidSubscription = false,
): FreebuffModelId | FreebuffLimitedOfferModelId {
  if (accessTier === 'limited') {
    // The reward model survives the coercion at limited tier so an earned
    // session is launchable from any region; the pool decides whether it is
    // joinable. Before 2026-08-31 this named GLM 5.2 explicitly, because that
    // row was in no tier's catalog at all; the reward model is now an ordinary
    // full-access row, so this is the ONLY tier that still needs the pass.
    if (isRewardModelRedeemableAtLimitedTier(id)) return id as FreebuffModelId
    // A plan model survives it for the same reason: the plan's own windows
    // decide whether the session is joinable, not this allowlist.
    return isFreebuffModelAllowedForAccessTier(
      id,
      accessTier,
      hasPaidSubscription,
    )
      ? (id as FreebuffModelId)
      : LIMITED_FREEBUFF_MODEL_ID
  }
  const limitedOffer = FREEBUFF_LIMITED_OFFER_MODEL_IDS.find(
    (modelId) => modelId === id,
  )
  if (limitedOffer) return limitedOffer
  return resolveFreebuffModel(id)
}

export function resolveFreebuffSessionModelForAccessTier(
  id: string | null | undefined,
  accessTier: FreebuffAccessTier | null | undefined,
  options: {
    includeGodOnly?: boolean
    /**
     * See `hasPaidSubscription` on isFreebuffSessionModelAllowedForAccessTier.
     *
     * This is the coercion that made the server-side widening dead code. The
     * chat gate admitted a limited subscriber's plan model, but admission had
     * already resolved their session row to MiMo, so the gate's own
     * substitution ran the turn as MiMo and the user watched the model they
     * paid for answer as the free one — with nothing anywhere reporting an
     * error. Every caller on the admission path has to pass this.
     */
    hasPaidSubscription?: boolean
  } = {},
): SupportedFreebuffModelId | FreebuffWebModelId {
  if (accessTier === 'limited') {
    return isFreebuffSessionModelAllowedForAccessTier(
      id,
      accessTier,
      options.hasPaidSubscription ?? false,
    )
      ? (id as SupportedFreebuffModelId)
      : LIMITED_FREEBUFF_MODEL_ID
  }
  // NOTE: a withdrawn model does NOT resolve here. It used to coerce silently
  // to the fallback, which kept clients running but left a user who picked it
  // watching a different model answer with no explanation. Admission REFUSES it
  // with `model_unavailable` and a message naming the replacement (see
  // freebuffWithdrawnModelMessage). That refusal is deliberately not
  // session-ending, so the client shows the message instead of re-admitting.
  //
  // That last paragraph described an intention rather than the code from
  // 2026-08-20 until 2026-08-27: nothing on either admission path consulted the
  // pause at all — `isFreebuffSessionModelAvailable` reads the availability
  // WINDOW — so a withdrawn pick admitted normally, spent a session unit, took
  // Desktop's single premium slot for the hour, and was then refused by the
  // chat gate on every request against it. `withdrawnModelRefusal` in
  // web/src/server/free-session/public-api.ts is the refusal this names.
  if (isSupportedFreebuffModelId(id)) return id
  return resolveFreebuffWebModel(id, {
    includeGodOnly: options.includeGodOnly ?? true,
  })
}

export function isSupportedFreebuffModelId(
  id: string | null | undefined,
): id is SupportedFreebuffModelId {
  if (!id) return false
  return SUPPORTED_FREEBUFF_MODELS.some((m) => m.id === id)
}

/**
 * Match a model id against a base id, tolerating the dated provider snapshot
 * suffix OpenRouter (and our own routing) appends, e.g.
 * `google/gemini-3.1-pro-preview-20260219` for base `google/gemini-3.1-pro-preview`.
 * Mirrors the suffix logic in `isFreeModeAllowedAgentModel` (free-agents.ts) —
 * the two MUST stay in sync. Only a `-YYYYMMDD`-style suffix matches, so e.g.
 * `mimo-v2.5-pro` never matches the base `mimo-v2.5`.
 */
export function freebuffModelIdMatches(
  candidate: string | null | undefined,
  baseId: string,
): boolean {
  if (!candidate) return false
  if (candidate === baseId) return true
  const prefix = baseId + '-'
  if (!candidate.startsWith(prefix)) return false
  return /^\d{6,8}(?:$|[-:])/.test(candidate.slice(prefix.length))
}

/** Whether the requested model is Gemini Pro, tolerating the dated snapshot
 *  suffix. Use this instead of `=== FREEBUFF_GEMINI_PRO_MODEL_ID` so a caller
 *  can't dodge a Gemini gate by sending the dated id. */
export function isFreebuffGeminiProModelId(
  id: string | null | undefined,
): boolean {
  return freebuffModelIdMatches(id, FREEBUFF_GEMINI_PRO_MODEL_ID)
}

export function isFreebuffPremiumModelId(
  id: string | null | undefined,
): boolean {
  if (!id) return false
  // Suffix-tolerant: a dated variant of a premium id (e.g. a dated Kimi) must
  // still count as premium so it can't dodge the premium daily rate cap.
  return FREEBUFF_PREMIUM_MODEL_IDS.some((modelId) =>
    freebuffModelIdMatches(id, modelId),
  )
}

export function isFreebuffWebPremiumModelId(
  id: string | null | undefined,
): boolean {
  if (!id) return false
  return FREEBUFF_WEB_PREMIUM_MODEL_IDS.some((modelId) =>
    freebuffModelIdMatches(id, modelId),
  )
}

/** True for any Muse Spark Contributor wire id (FREEBUFF_MUSE_SPARK_MODEL_IDS).
 *  Every version shares one team-wide rate limit at Meta, so the queue, the
 *  cooldown and the fallback that key off this predicate treat them as one
 *  model. Suffix-tolerant like the other model predicates so a dated provider
 *  snapshot can't slip past the rate-limit queue (docs/freebuff-muse-spark.md). */
export function isMuseSparkModelId(id: string | null | undefined): boolean {
  if (!id) return false
  return FREEBUFF_MUSE_SPARK_MODEL_IDS.some((modelId) =>
    freebuffModelIdMatches(id, modelId),
  )
}

export function isFreebuffSessionPremiumModelId(
  id: string | null | undefined,
): boolean {
  return isFreebuffWebPremiumModelId(id)
}

/**
 * Whether the requested model is what an earned reward session unlocks,
 * tolerating the dated snapshot suffix.
 *
 * TRUE OF GLM 5.3 FLASH, WHICH IS ALSO AN ORDINARY UNMETERED ROW, so this
 * predicate is only a quota answer WHEN PAIRED WITH THE LIMITED ACCESS TIER.
 * Every caller that routes on it must check the tier too. At full access the
 * same id is in FREEBUFF_STANDARD_MODEL_IDS and must stay unmetered — routing
 * it to the reward pool there would put the product's default model behind an
 * earned balance, which is the one outcome the 2026-08-31 swap had to avoid.
 *
 * Distinct from isFreebuffGlmV53FlashModelId, which asks the same question for
 * a different purpose (the OpenRouter price fence). Same id today, different
 * reason, and they are free to diverge the next time the reward moves.
 */
export function isFreebuffRewardModelId(
  id: string | null | undefined,
): boolean {
  return FREEBUFF_REWARD_MODEL_IDS.some((modelId) =>
    freebuffModelIdMatches(id, modelId),
  )
}

/** Whether the requested model is GLM 5.3 Flash, tolerating the dated snapshot
 *  suffix. Used by the OpenRouter layer to apply this row's price ceiling, so a
 *  dated variant cannot dodge it.
 *
 *  DISTINCT FROM isFreebuffRewardModelId and never a widening of it. The two
 *  share a name and a `z-ai/` prefix and nothing else: 5.2 is the referral
 *  reward metered by its own earned pool, 5.3 Flash is a premium-pool row every
 *  full-access account gets. A predicate that prefix-matched `z-ai/glm` would
 *  hand one model's entitlement to the other — the exact failure that made
 *  `crof/glm-5.2` a quota-bypass route for five days. */
export function isFreebuffGlmV53FlashModelId(
  id: string | null | undefined,
): boolean {
  return freebuffModelIdMatches(id, FREEBUFF_GLM_V53_FLASH_MODEL_ID)
}

/** Whether the requested model is Gemini 3.8 Flash, tolerating the dated
 *  snapshot suffix. Used by the OpenRouter layer to apply this row's endpoint
 *  preference and price ceiling, so a dated variant can dodge neither — and
 *  the ceiling is the only thing standing between it and an endpoint at 3.6x.
 *
 *  DISTINCT from isFreebuffGeminiProModelId, which gates Gemini Pro to the
 *  gemini-thinker subagents. The two must never be merged or prefix-matched on
 *  `google/gemini`: Pro is a subagent-only route with its own agent binding,
 *  this is an ordinary picker row, and a shared predicate would either put Pro
 *  in the picker or refuse this row to every agent that is not a thinker. */
export function isFreebuffGemini38FlashModelId(
  id: string | null | undefined,
): boolean {
  return freebuffModelIdMatches(id, FREEBUFF_GEMINI_38_FLASH_MODEL_ID)
}

/** Whether the requested model is GPT-5.6 Luna, tolerating the dated snapshot
 *  suffix. Used by the OpenRouter layer to apply Luna's pinned routing and
 *  reasoning effort, so a dated variant can't dodge either. */
export function isFreebuffGpt56LunaModelId(
  id: string | null | undefined,
): boolean {
  return freebuffModelIdMatches(id, FREEBUFF_GPT_5_6_LUNA_MODEL_ID)
}

/**
 * Models that may ONLY be served to the Freebuff Web service account — i.e. to
 * turns issued by the Freebuff Web / Cloud runner itself, never to a caller
 * holding an ordinary API key.
 *
 * This is the surface gate with teeth. Every other thing that keeps a model off
 * a surface is a client-side fact: a model absent from FREEBUFF_MODELS is one
 * no shipped CLI build renders, which stops our users and nobody else. A
 * hand-written caller posts whatever agent id and model id it likes, and the
 * free-mode allowlist happily confirms that `base3-free-ox-alpha` may run Ox
 * Alpha — because it may, when WE are the ones asking.
 *
 * The service account is the one claim in a free-mode request that cannot be
 * forged. `codebuff_metadata.surface` is self-reported and is ignored for
 * everyone else precisely because it is (see docs/unified-usage-tracking.md);
 * the API key that authenticates the runner is held server-side. So "Web and
 * Cloud only" is expressed as "authenticated as the runner", which is the same
 * statement made in the only terms an attacker cannot restate.
 *
 * MUSE SPARK IS LISTED (both Contributor versions) as of 2026-09-02. Its
 * premium-pool metering was the reason it was left off while Ox Alpha was
 * the only entry — a third-party caller reaching a metered row spends a quota
 * that runs out — and that argument turned out to be weaker than it read:
 * over 1.2's only production run, 52% of its messages carried a non-browser
 * surface even though no CLI or Desktop build could select it, because the
 * catalogs are a client-side filter and every other gate (agent id, model id,
 * self-reported surface) is text the caller writes. What a proxy spends on
 * this row is not the point either: the row's scarce resource is a team-wide
 * rate limit shared by every real user, and every request a proxy makes is a
 * request a browser turn cannot. So the fence here is the one the model
 * actually needs. Kimi K3 Eco stays off the list: it is god-gated on its own.
 *
 * Enforced in web/src/app/api/v1/chat/completions/_post.ts, next to the
 * free-mode agent+model allowlist. That is where inference is actually spent,
 * so a caller who somehow admits a session still cannot run a single turn on it.
 */
// This list means "served only to the Freebuff Web service account", and it is
// the one real gate that keeps a model on surfaces we can withdraw it from in a
// single deploy. Shipping a row inside a CLI binary is incompatible with that
// promise — keeping the id here would 403 every CLI and Desktop turn — which
// is why Ox Alpha LEFT on 2026-08-24 when it went to the CLI and Desktop, and
// why the list sat empty until Muse Spark 1.3 was staged on Web/Cloud.
//
// So this entry and the CLI/Desktop rollout are mutually exclusive by
// construction. Widening Muse Spark to the CLI and Desktop (the checklist on
// FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID) REQUIRES removing it from here
// in the same change, and the reverse: as long as the row is browser-only, a
// missing entry here means the catalogs are the only gate, and they are not
// one. The remaining defences without it are narrower:
//
//   - the tool-schema check (docs/freebuff-abuse-detection.md), which downgrades
//     third-party clients on every model, but not a caller who has faithfully
//     reproduced our toolset
//   - FREEBUFF_PAUSED_FREE_MODEL_IDS, which is the rollback lever rather than a
//     standing gate
//
// Withdrawing a model entirely is still `FREEBUFF_PAUSED_FREE_MODEL_IDS`, not
// this list: pausing stops admissions on every surface in one deploy, while
// this list leaves a visible picker row that 403s on send.
export const FREEBUFF_SERVICE_ONLY_MODEL_IDS =
  [] as const satisfies readonly string[]
// EMPTIED 2026-09-04, when Muse Spark went to the CLI and Desktop.
//
// This list and a client rollout are MUTUALLY EXCLUSIVE by construction, which
// is the thing to understand before adding to it again: it refuses a model to
// anything not authenticated as the Web runner's own service account, and no
// released binary can make that claim. Leaving Muse Spark here would have 403'd
// every CLI and Desktop turn — exactly as it did for Ox Alpha, whose entry left
// this list for the same reason on 2026-08-24.
//
// What guards the row now is what guards every other picker row: the free-mode
// agent+model allowlist, the premium session pool, and its Freebucks price.
// Understand what that gives up before removing the next entry — this fence was
// the only one that could withdraw a model from every third-party caller in a
// single deploy.

/** Whether `id` may only be served to the Freebuff Web service account. Matches
 *  dated builds for the same reason the price fence does: a variant that slips
 *  past this predicate is the same model with the gate off. */
export function isFreebuffServiceOnlyModelId(
  id: string | null | undefined,
): boolean {
  return FREEBUFF_SERVICE_ONLY_MODEL_IDS.some((modelId) =>
    freebuffModelIdMatches(id, modelId),
  )
}

/** Whether `id` names Ox Alpha, including any dated build of it. Consumed by
 *  the OpenRouter lane, which attaches the zero-price fence to exactly these
 *  requests — a dated variant that slipped past this predicate would be the
 *  same model with no fence on it. */
export function isFreebuffOxAlphaModelId(
  id: string | null | undefined,
): boolean {
  return freebuffModelIdMatches(id, FREEBUFF_OX_ALPHA_MODEL_ID)
}

/** The catalog's reasoning effort for the requested model, tolerating dated
 *  snapshot suffixes like every other id helper. Null for models that carry
 *  none — see FreebuffModelOption.reasoningEffort. */
/** The catalog row for any surface's id, or undefined. Both catalogs, for the
 *  same reason getFreebuffModelReasoningEffort reads both: a Web-only model is
 *  absent from SUPPORTED_FREEBUFF_MODELS by design. */
function findFreebuffModelOption(
  id: string | null | undefined,
): FreebuffModelOption | undefined {
  return (
    SUPPORTED_FREEBUFF_MODELS.find((m) => freebuffModelIdMatches(id, m.id)) ??
    FREEBUFF_WEB_ALL_MODELS.find((m) => freebuffModelIdMatches(id, m.id))
  )
}

/** The ladder a user may pick from for this model, or null when it offers no
 *  choice — which is every model that has not opted in. */
export function getFreebuffModelEfforts(
  id: string | null | undefined,
): readonly ReasoningEffort[] | null {
  const efforts = findFreebuffModelOption(id)?.efforts
  return efforts && efforts.length > 0 ? efforts : null
}

/** Where this model's ladder starts before a user touches it. */
export function getFreebuffModelDefaultEffort(
  id: string | null | undefined,
): ReasoningEffort | null {
  const entry = findFreebuffModelOption(id)
  if (!entry?.efforts?.length) return null
  return entry.defaultEffort ?? entry.efforts[entry.efforts.length - 1]!
}

/**
 * THE authority on what effort a request runs at. Everything a client sends is
 * a request, never a command.
 *
 * Keyed on the model the request will ACTUALLY run — not the one the user
 * picked. Those differ more often than they look: a limited-tier user's premium
 * pick is coerced (resolveFreebuffSessionModelForAccessTier), the cloud build
 * path rewrites it, and a Muse Spark turn can be rerouted to Luna mid-flight.
 * Clamping against the requested model would then let one model's rung reach
 * another's API — `xhigh` landing on DeepSeek maps to `max`, the most expensive
 * rung there is, from a user who never asked for it.
 *
 * Clamp-DOWN (see clampReasoningEffort): a rung above the ceiling becomes the
 * ceiling rather than snapping back to the default, so a rerouted user keeps
 * the closest thing to what they chose. Models with no ladder return null and
 * keep whatever `reasoningEffort` already says.
 */
export function resolveFreebuffReasoningEffort(
  modelId: string | null | undefined,
  requested: unknown,
): ReasoningEffort | null {
  const efforts = getFreebuffModelEfforts(modelId)
  if (!efforts) return null
  const fallback = getFreebuffModelDefaultEffort(modelId)
  if (!fallback) return null
  // Medium was briefly offered for Flash before the 07/31 capability matrix was
  // corrected, and reaches these models from persisted Desktop/Web preferences
  // and from threads that switched model. DeepSeek maps that compatibility
  // spelling to high (medium→high in its own effort table), so honor that rather
  // than letting generic clamp-down turn a stale value into LOW while the UI
  // displays high.
  //
  // Applies to Pro as well as Flash since Pro's 08/13 ladder gained `low`:
  // before that, "everything on offer is above medium" already landed Pro's
  // medium on high, and losing that to the clamp would be a silent downgrade of
  // exactly the model users pick for deliberation.
  if (
    requested === 'medium' &&
    (freebuffModelIdMatches(modelId, FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID) ||
      freebuffModelIdMatches(modelId, FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID))
  ) {
    return 'high'
  }
  return clampReasoningEffort(requested, efforts, fallback)
}

export function getFreebuffModelReasoningEffort(
  id: string | null | undefined,
): NonNullable<FreebuffModelOption['reasoningEffort']> | null {
  // BOTH catalogs, and the Web one is not optional. This used to read
  // SUPPORTED_FREEBUFF_MODELS alone — the CLI/Desktop catalog — which silently
  // excluded every Web-only model. Muse Spark is deliberately absent from that
  // list (its absence IS the Desktop gate), so setting `reasoningEffort` on its
  // row did nothing at all and gave no hint why: the field was present, the
  // lookup simply could not see the row. Any future Web-only model would have
  // hit the same wall.
  const entry: FreebuffModelOption | undefined =
    SUPPORTED_FREEBUFF_MODELS.find((m) => freebuffModelIdMatches(id, m.id)) ??
    FREEBUFF_WEB_ALL_MODELS.find((m) => freebuffModelIdMatches(id, m.id))
  return entry?.reasoningEffort ?? null
}

/**
 * Whether a model may be PINNED as the remembered pick in localStorage.
 *
 * The rule exists for one shape of row: an earned one, whose balance runs out
 * far sooner than the rest of the picker. Pinning such a row strands the user
 * on a model they cannot start — the next new thread, a different app, or a
 * plain page reload would open on it and fail admission. Picking it applies to
 * the surface in front of you; anything that starts fresh falls back to
 * DEFAULT_FREEBUFF_WEB_MODEL_ID.
 *
 * TIER-AWARE SINCE 2026-08-31, and it has to be. The rule used to name GLM 5.2,
 * which was earned at every tier. The reward model is now GLM 5.3 Flash, which
 * is earned ONLY at limited access — at full access it is unmetered and is
 * DEFAULT_FREEBUFF_WEB_MODEL_ID itself. Refusing to remember it there would
 * mean the product's default model is the one pick that never sticks, and a
 * user who deliberately chose it would find it reset on every reload.
 *
 * Defaults to full access so a caller that does not know the tier keeps the
 * permissive answer, which is the correct one for every row but this one at one
 * tier.
 *
 * Every localStorage read AND write of the remembered model must go through
 * this (via resolveRememberedFreebuffWebModel), so a value saved before this
 * rule existed self-heals on the next load instead of persisting forever.
 */
export function isFreebuffWebRememberableModelId(
  id: string | null | undefined,
  accessTier: FreebuffAccessTier | null | undefined = 'full',
): boolean {
  if (accessTier !== 'limited') return true
  return !isFreebuffRewardModelId(id)
}

/**
 * The model a surface should START on, given a remembered (localStorage)
 * selection: the saved model when it is still valid and rememberable, else
 * DEFAULT_FREEBUFF_WEB_MODEL_ID.
 *
 * Distinct from resolveFreebuffWebModel, which resolves a LIVE selection and
 * must leave a just-picked earned row alone.
 */
export function resolveRememberedFreebuffWebModel(
  id: string | null | undefined,
  options: {
    includeGodOnly?: boolean
    /** See isFreebuffWebRememberableModelId — only the limited tier refuses to
     *  remember anything, and only the reward row. */
    accessTier?: FreebuffAccessTier | null
  } = {},
): FreebuffWebModelId {
  const resolved = resolveFreebuffWebModel(id, options)
  return isFreebuffWebRememberableModelId(resolved, options.accessTier)
    ? resolved
    : DEFAULT_FREEBUFF_WEB_MODEL_ID
}

export function isFreebuffMultimodalModelId(
  id: string | null | undefined,
): boolean {
  if (!id) return false
  return FREEBUFF_MULTIMODAL_MODEL_IDS.some((modelId) => modelId === id)
}

/**
 * Return whether a model used by a Freebuff surface accepts image input.
 * Unknown models return undefined so the provider backend does not strip
 * images from newly added or paid models until their capability is known.
 */
export function getFreebuffModelImageSupport(
  id: string | null | undefined,
): boolean | undefined {
  if (!id) return undefined

  // Keep the retired chat wire id text-only during a staggered deployment.
  // It now routes to DeepSeek direct, but has no catalog option of its own.
  if (
    freebuffModelIdMatches(id, FREEBUFF_DEEPSEEK_V4_FLASH_FIREWORKS_MODEL_ID)
  ) {
    return false
  }

  const model =
    SUPPORTED_FREEBUFF_MODELS.find((option) =>
      freebuffModelIdMatches(id, option.id),
    ) ??
    FREEBUFF_WEB_ALL_MODELS.find((option) =>
      freebuffModelIdMatches(id, option.id),
    )
  return model?.multimodal
}

export function isFreebuffWebMultimodalModelId(
  id: string | null | undefined,
): boolean {
  if (!id) return false
  return FREEBUFF_WEB_MULTIMODAL_MODEL_IDS.some((modelId) => modelId === id)
}

/** Whether we store our own chat-completion traces for this free-mode model.
 *  See FREEBUFF_TRACED_MODEL_IDS. */
export function isFreebuffTracedModelId(
  id: string | null | undefined,
): boolean {
  if (!id) return false
  return FREEBUFF_TRACED_MODEL_IDS.some((modelId) => modelId === id)
}

export function resolveSupportedFreebuffModel(
  id: string | null | undefined,
): SupportedFreebuffModelId {
  return isSupportedFreebuffModelId(id) ? id : FALLBACK_FREEBUFF_MODEL_ID
}

export function getFreebuffModel(id: string): FreebuffModelOption {
  return (
    SUPPORTED_FREEBUFF_MODELS.find((m) => m.id === id) ??
    FREEBUFF_MODELS.find((m) => m.id === FALLBACK_FREEBUFF_MODEL_ID)!
  )
}

export function getFreebuffWebModel(id: string): FreebuffModelOption {
  return (
    FREEBUFF_WEB_ALL_MODELS.find((m) => m.id === id) ??
    FREEBUFF_WEB_ALL_MODELS.find((m) => m.id === FALLBACK_FREEBUFF_MODEL_ID)!
  )
}

/** The "a better model exists" notice for `id`, or undefined when the model is
 *  current. Returns nothing when the replacement is not itself selectable on
 *  this surface, so a picker never offers a switch to a model it cannot show. */
export function getFreebuffModelSupersededBy(
  id: string | null | undefined,
  selectableModelIds: readonly string[],
): FreebuffModelOption['supersededBy'] | undefined {
  if (!id) return undefined
  const catalog: readonly FreebuffModelOption[] = [
    ...SUPPORTED_FREEBUFF_MODELS,
    ...FREEBUFF_WEB_ALL_MODELS,
  ]
  const supersededBy = catalog.find(
    (candidate) => candidate.id === id,
  )?.supersededBy
  if (!supersededBy) return undefined
  return selectableModelIds.includes(supersededBy.modelId)
    ? supersededBy
    : undefined
}

/**
 * Why a row cannot be picked right now, in the reader's own clock — or
 * undefined when it can.
 *
 * The pickers had a label for deployment hours and nothing for anything else,
 * so a model closed for any OTHER reason looked completely normal: selectable,
 * checkmarked, and refused only at send time. That is exactly what V4 Pro's
 * peak-hour window did — correctly closed at 2am Pacific and indistinguishable
 * from open.
 *
 * LOCAL TIME is the whole point. DeepSeek publishes its peak in UTC, so the
 * window a user lives in (5pm-3am Pacific) shares no digits with the one we
 * store. "Closed 00:00-10:00 UTC" asks someone at 2am to do timezone
 * arithmetic before they can tell whether the product is broken.
 */
export function getFreebuffModelUnavailableLabel(
  id: string,
  now: Date = new Date(),
  options: LocalTimeFormatOptions = {},
): string | undefined {
  if (isFreebuffSessionModelAvailable(id, now)) return undefined
  const model =
    SUPPORTED_FREEBUFF_MODELS.find((candidate) => candidate.id === id) ??
    getFreebuffWebModel(id)
  if (model.availability === 'off_peak_only') {
    const back = deepSeekExpensiveWindowEndsAt(now)
    // Named, even though this label is only ever built in-app. "In-app" is not
    // the same as "on the reader's clock": a CLI on a remote box renders that
    // BOX's zone, and the human reading it is somewhere else entirely. The zone
    // costs four characters and removes the one question the label exists to
    // answer.
    return `Back at ${formatLocalTime(back, now, options)} ${formatWindowTimeZoneLabel(
      back,
      options.timeZone,
    )}`
  }
  return getFreebuffDeploymentAvailabilityLabel(now, options)
}

/**
 * WHEN a time-gated model is open, in the reader's local clock — the inverse of
 * `getFreebuffModelUnavailableLabel`, which only speaks once the door is
 * already shut.
 *
 * Shown on the row at all hours so a user can plan around the window instead of
 * discovering it by being refused. Returns undefined for models with no time
 * restriction at all, which is most of the catalog.
 */
export function getFreebuffModelAvailabilityWindowLabel(
  id: string,
  now: Date = new Date(),
  options: LocalTimeFormatOptions = {},
): string | undefined {
  const model =
    SUPPORTED_FREEBUFF_MODELS.find((candidate) => candidate.id === id) ??
    getFreebuffWebModel(id)
  if (model.availability === 'off_peak_only') {
    return `Open ${formatDeepSeekOffPeakWindowLocal(now, options.timeZone)}`
  }
  if (model.availability === 'deployment_hours') {
    return getFreebuffDeploymentAvailabilityLabel(now, options)
  }
  return undefined
}

/**
 * The model a saved preference should be steered to, or null to keep it.
 *
 * Applied EVERY time a surface reads its remembered pick, so each new
 * thread/session/launch starts on the replacement. A superseded model stays
 * fully selectable — picking one mid-thread works and sticks for that thread —
 * but it never becomes the model a fresh surface opens on again.
 *
 * This is deliberately aggressive: a saved preference outranks a changed
 * default forever otherwise, which is exactly how users kept landing back on
 * models we no longer recommend. The cost is that a user who wants a
 * superseded model as their standing default cannot have one; the picker's
 * per-row notice is what makes that visible rather than mysterious.
 *
 * Derived from the catalog's own `supersededBy` pointers, so a model marked
 * superseded automatically gets BOTH the picker nudge and this steering —
 * they can never disagree about which models are stale.
 */
export function migrateSupersededFreebuffModelPreference(
  id: string | null | undefined,
  selectableModelIds: readonly string[],
): string | null {
  return getFreebuffModelSupersededBy(id, selectableModelIds)?.modelId ?? null
}

function getNextFreebuffDeploymentStart(now: Date): Date {
  const easternNow = getZonedParts(now, FREEBUFF_EASTERN_TIMEZONE)
  const isBeforeTodayOpen = easternNow.hour < 9

  const offset = isBeforeTodayOpen ? 0 : 1

  return getUtcForZonedTime(
    addDaysToYmd(easternNow.year, easternNow.month, easternNow.day, offset),
    FREEBUFF_EASTERN_TIMEZONE,
    9,
    0,
  )
}

function getCurrentFreebuffDeploymentEnd(now: Date): Date {
  const pacificNow = getZonedParts(now, FREEBUFF_PACIFIC_TIMEZONE)
  return getUtcForZonedTime(pacificNow, FREEBUFF_PACIFIC_TIMEZONE, 17, 0)
}

function isSameLocalDay(left: Date, right: Date, timeZone?: string): boolean {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return formatter.format(left) === formatter.format(right)
}

function formatLocalTime(
  date: Date,
  referenceNow: Date,
  options: LocalTimeFormatOptions = {},
): string {
  const shouldShowWeekday = !isSameLocalDay(
    date,
    referenceNow,
    options.timeZone,
  )
  return new Intl.DateTimeFormat(options.locale, {
    timeZone: options.timeZone,
    weekday: shouldShowWeekday ? 'short' : undefined,
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

export function getFreebuffDeploymentAvailabilityLabel(
  now: Date = new Date(),
  options: LocalTimeFormatOptions = {},
): string {
  if (isFreebuffDeploymentHours(now)) {
    const closesAt = getCurrentFreebuffDeploymentEnd(now)
    return `until ${formatLocalTime(closesAt, now, options)}`
  }

  const opensAt = getNextFreebuffDeploymentStart(now)
  return `opens ${formatLocalTime(opensAt, now, options)}`
}

export function isFreebuffDeploymentHours(now: Date = new Date()): boolean {
  const eastern = getZonedParts(now, FREEBUFF_EASTERN_TIMEZONE)
  const pacific = getZonedParts(now, FREEBUFF_PACIFIC_TIMEZONE)
  return (
    eastern.hour * 60 + eastern.minute >= 9 * 60 &&
    pacific.hour * 60 + pacific.minute < 17 * 60
  )
}

export function isFreebuffModelAvailable(
  id: string,
  now: Date = new Date(),
): boolean {
  const model = SUPPORTED_FREEBUFF_MODELS.find((m) => m.id === id)
  if (!model) return false
  return isAvailableAt(model.availability, now)
}

/**
 * The ONE reading of `availability`, shared by the picker's joinability check
 * and the server's admission check.
 *
 * They were separate, and the picker's copy only knew 'always' and deployment
 * hours — so `off_peak_only` fell through to a window that has nothing to do
 * with it. That was right only by coincidence: DeepSeek's peak and our staffing
 * hours happen to overlap at some times of day and not others, so V4 Pro would
 * have shown as pickable during the expensive window whenever the two disagreed,
 * and been refused on send.
 *
 * A picker that can disagree with admission is worse than one that is simply
 * wrong, because the disagreement only surfaces after the user commits.
 */
function isAvailableAt(
  availability: FreebuffModelOption['availability'],
  now: Date,
): boolean {
  if (availability === 'always') return true
  if (availability === 'off_peak_only') return !isDeepSeekExpensiveWindow(now)
  return isFreebuffDeploymentHours(now)
}

/**
 * The window to quote when `model` is refused for being unavailable.
 *
 * Derived from the model's OWN availability instead of assumed. Both refusal
 * sites in free-session/public-api.ts gate on isFreebuffSessionModelAvailable,
 * which covers `deployment_hours` AND `off_peak_only`, but both hardcoded the
 * deployment-hours label -- so a model closed for DeepSeek's peak window was
 * quoted our staffing hours, a different window entirely.
 */
export function freebuffModelUnavailableWindow(
  id: string,
  now: Date = new Date(),
  /**
   * The zone to quote in. Defaults to UTC and NOT to the runtime's zone,
   * because every caller of this function is the SERVER: it does not know where
   * the reader is, and the container it runs in is not an answer. Left to the
   * runtime it rendered whatever that container happened to be set to and named
   * no zone at all, so a user in Germany was told V4 Flash returned "at 10:00
   * AM" — 10:00 UTC, noon for them — at 10:34 on their own clock.
   *
   * Clients that DO know the reader's zone should render `availableAt` instead
   * (see freebuffModelUnavailableAt); this string is the floor, correct for
   * everyone and local to no one.
   */
  timeZone: string = FALLBACK_WINDOW_TIME_ZONE,
): string {
  const model =
    SUPPORTED_FREEBUFF_MODELS.find((candidate) => candidate.id === id) ??
    getFreebuffWebModel(id)
  return model.availability === 'off_peak_only'
    ? formatDeepSeekExpensiveWindowReturn(now, timeZone)
    : FREEBUFF_DEPLOYMENT_HOURS_LABEL
}

/**
 * The instant `id` comes back, as an ISO string — or undefined when there is no
 * such instant to name.
 *
 * The machine-readable half of the pair above, and the reason a client never
 * has to parse prose to say "12:00" to a reader in Berlin. Only `off_peak_only`
 * has a computable return time: `deployment_hours` is our staffing window and
 * the limited-offer branch is a pool that refills on no schedule, so both
 * return undefined rather than a guess a client would render as fact.
 */
export function freebuffModelUnavailableAt(
  id: string,
  now: Date = new Date(),
): string | undefined {
  const model =
    SUPPORTED_FREEBUFF_MODELS.find((candidate) => candidate.id === id) ??
    getFreebuffWebModel(id)
  if (model.availability !== 'off_peak_only') return undefined
  if (!isDeepSeekExpensiveWindow(now)) return undefined
  return deepSeekExpensiveWindowEndsAt(now).toISOString()
}

/**
 * The one renderer every client uses for a `model_unavailable` refusal.
 *
 * Prefers `availableAt` — an instant, which each surface formats in the zone
 * its own reader lives in — and falls back to the server's UTC prose for a
 * response that carries no instant (an older server, or a closure with no
 * computable return time). Shared rather than reimplemented per surface so the
 * CLI, Desktop and Web cannot drift into three different answers to "when?".
 */
export function formatFreebuffModelUnavailableWindow(
  body: { availableHours: string; availableAt?: string },
  options: LocalTimeFormatOptions & { now?: Date } = {},
): string {
  if (!body.availableAt) return body.availableHours
  const ends = new Date(body.availableAt)
  if (Number.isNaN(ends.getTime())) return body.availableHours
  const now = options.now ?? new Date()
  // The zone is named here too. A reader who sees "again at 12:00 PM" in a
  // desktop app and "again at 10:00 AM UTC" in a support reply has to work out
  // whether those are the same moment; printing GMT+2 beside the first makes
  // that a subtraction rather than a guess.
  return `again at ${formatLocalTime(ends, now, options)} ${formatWindowTimeZoneLabel(
    ends,
    options.timeZone,
  )}`
}

export function isFreebuffSessionModelAvailable(
  id: string,
  now: Date = new Date(),
): boolean {
  const model =
    SUPPORTED_FREEBUFF_MODELS.find((candidate) => candidate.id === id) ??
    getFreebuffWebModel(id)
  // Same reading as the picker's joinability check, deliberately — see
  // isAvailableAt. `off_peak_only` is the ten hours DeepSeek charges double
  // (00:00-10:00 UTC), a different window from `deployment_hours`, which tracks
  // OUR staffing rather than an upstream rate card.
  return isAvailableAt(model.availability, now)
}

export function resolveAvailableFreebuffModel(
  id: string | null | undefined,
  now: Date = new Date(),
): FreebuffModelId {
  const resolved = resolveFreebuffModel(id)
  if (isFreebuffModelAvailable(resolved, now)) return resolved
  // A closed row may name where its traffic should go instead — V4 Flash sends
  // its peak hours to V4 Pro. Checked for availability itself rather than
  // trusted, so a chain of closed rows can never strand a pick; anything
  // unresolvable still lands on the unlimited fallback.
  const declared = (
    SUPPORTED_FREEBUFF_MODELS as readonly FreebuffModelOption[]
  ).find((candidate) => candidate.id === resolved)?.unavailableFallback
  if (
    declared &&
    isFreebuffModelId(declared) &&
    isFreebuffModelAvailable(declared, now)
  ) {
    return declared
  }
  return FALLBACK_FREEBUFF_MODEL_ID
}
