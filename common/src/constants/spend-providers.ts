/**
 * The two provider dimensions the spend dashboard slices by, and why there are
 * two rather than one.
 *
 * A model id names its VENDOR — `openai/gpt-5.6-luna`, `z-ai/glm-5.2`. It does
 * not name who sends us the bill. Luna is served through OpenRouter with our
 * own OpenAI key as the last backup (#1767); GLM 5.2 is served by CrofAI; every
 * DeepSeek id runs a cascade across CrofAI, RunInfra, Infron and DeepSeek
 * direct. So on a page about money, `google/gemini-3.1-pro-preview` filed under
 * "Google" is not a rounding error — it credits a company we have no contract
 * with and hides the one we actually pay.
 *
 * Hence:
 *
 *   - {@link modelVendor} — parsed from the id. Always available, including for
 *     rows written before any of this existed. Answers "whose model is this".
 *   - `message.provider` — stamped by the lane that computed the cost, so it is
 *     the billing counterparty by construction rather than by inference.
 *     Answers "who charged us for it". NULL for rows written before the column
 *     shipped; those render as {@link UNATTRIBUTED_PROVIDER} and age out of the
 *     rollup on its own retention window.
 *
 * There is deliberately no model -> provider guess for the NULL rows. The ids
 * whose vendor and biller differ are exactly the ids carrying most of the
 * spend, so a guess would be wrong precisely where it is read.
 *
 * This file is in `common/`, which is published wholesale to the public repo.
 * That is fine here: these are the names of
 * companies we buy inference from, all of them already named in
 * ./provider-routes.ts. Do not add prices, ceilings, or routing preference to
 * this file.
 */

/**
 * Billing counterparties — who invoices us, not who trained the model.
 *
 * One id per lane in `web/src/llm-api/`, because a lane is the unit that holds
 * a credential and computes a cost. `getChatCompletionsProvider` in
 * chat/completions/_post.ts picks the ENTRY lane from these; a cascade can move
 * a request to a different one, which is the whole reason the served lane is
 * recorded per message instead of derived.
 */
export const SPEND_PROVIDER_IDS = [
  'canopywave',
  'cheaper-inference',
  'crof',
  'deepseek',
  'fireworks',
  'infron',
  'luminal',
  // FusionCode: capped Flash front lane, added 2026-08-25.
  'fusioncode',
  // Merge Gateway: a multi-vendor gateway, primary for GLM 5.3 Flash since
  // 2026-08-27. It is the BILLER for every vendor it fronts — the `vendor`
  // field it echoes back (`zai`, `particle`) names who ran the weights, not who
  // invoices us, which is exactly the distinction this file exists to keep.
  'merge',
  'meta',
  'minimax',
  'moonshot',
  'novita',
  'openai',
  'opencode-zen',
  'openrouter',
  'runinfra',
  'siliconflow',
  'xiaomi',
] as const

export type SpendProviderId = (typeof SPEND_PROVIDER_IDS)[number]

/**
 * Stand-in for `message.provider IS NULL`: rows written before the column
 * existed, and any lane that reaches billing without stamping itself.
 *
 * A sentinel rather than a nullable column in the rollup, so a provider chart
 * always sums to the window total — an unattributed slice that is VISIBLE is
 * the thing that makes a missing lane get noticed. Never a valid
 * {@link SpendProviderId}, so a lane can never be mistaken for it.
 */
export const UNATTRIBUTED_PROVIDER = '(unattributed)'

const PROVIDER_ID_SET: ReadonlySet<string> = new Set(SPEND_PROVIDER_IDS)

export function isSpendProviderId(v: unknown): v is SpendProviderId {
  return typeof v === 'string' && PROVIDER_ID_SET.has(v)
}

/**
 * Narrow a value read back out of the database.
 *
 * The column is plain text and rows outlive any deploy, so a value that is no
 * longer a known lane must not crash a dashboard — it becomes unattributed,
 * which is the honest reading of "billed by something this build cannot name".
 */
export function toSpendProvider(
  v: string | null | undefined,
): SpendProviderId | typeof UNATTRIBUTED_PROVIDER {
  return isSpendProviderId(v) ? v : UNATTRIBUTED_PROVIDER
}

/** Display names. Only where casing or branding differs from the id. */
const PROVIDER_LABELS: Partial<Record<SpendProviderId, string>> = {
  'cheaper-inference': 'Cheaper Inference',
  merge: 'Merge Gateway',
  crof: 'CrofAI',
  deepseek: 'DeepSeek',
  luminal: 'Luminal',
  openai: 'OpenAI',
  'opencode-zen': 'OpenCode Zen',
  openrouter: 'OpenRouter',
  runinfra: 'RunInfra',
  siliconflow: 'SiliconFlow',
  novita: 'Novita',
  minimax: 'MiniMax',
  canopywave: 'CanopyWave',
  xiaomi: 'Xiaomi',
}

export function spendProviderLabel(id: string): string {
  if (id === UNATTRIBUTED_PROVIDER) return 'Unattributed'
  return isSpendProviderId(id) ? (PROVIDER_LABELS[id] ?? id) : id
}

/** Sentinel for a model id with no `vendor/` prefix. */
export const UNKNOWN_VENDOR = '(unknown)'

/**
 * The vendor half of a `vendor/model` id.
 *
 * Purely syntactic, and that is the point: it makes no claim about who serves
 * or bills the model, so it stays correct for every row ever written. Use it
 * for "which model families cost us money"; use `message.provider` for "who did
 * we pay".
 */
export function modelVendor(model: string): string {
  const slash = model.indexOf('/')
  if (slash <= 0) return UNKNOWN_VENDOR
  return model.slice(0, slash)
}
