/**
 * The two US-or-paid flagship rows: GPT-6.1 Sol (2026-09-29) and Gemini 4
 * Argon (2026-10-13). Both are ONE SESSION A DAY for every account, paid
 * plans included.
 *
 * Argon's promotional price ended at the 2026-10-23 repricing (250), and the
 * row is being retired (2026-10-24, FREEBUFF_LEAVING_SOON). Sol (200 since
 * 2026-10-23) lost its Promotional pill on 2026-10-15 and has it back since
 * 2026-10-28 (product), worded as Terra's (`GPT_61_SOL_PROMOTIONAL`).
 *
 * GPT-6.1 Terra (2026-10-26) is ONE SESSION A DAY too, at a PROMOTIONAL 100
 * with `GPT_61_TERRA_PROMOTIONAL` as its pill and server price notice (one
 * constant, so the two cannot disagree, and it names the daily limit so
 * nobody meets it first as a refusal). Not US-or-paid: it opens on every
 * full-access account and needs a plan only at limited access.
 *
 * A leaf module, like freebuff-solar-promo.ts, because the Freebucks price
 * map, the model catalog and the admission debit all read it and none may
 * import the others.
 */
import { getFreebuffModelPolicyOverlay } from './freebuff-model-policy-overlay'

export const GPT_61_SOL_MODEL_ID = 'openai/gpt-6.1-sol'
export const GEMINI_4_ARGON_MODEL_ID = 'google/gemini-4-argon'
export const GPT_61_TERRA_MODEL_ID = 'openai/gpt-6.1-terra'

/**
 * Terra's promotional label (product, 2026-10-26; "1 per day" since
 * 2026-10-28, from "Promotional · 1 session a day"). The tooltip also says the
 * row is new: Desktop and the Web workspace draw only this pill beside the
 * model name, so its hover text is where that is seen, and that the price is
 * promotional.
 */
export const GPT_61_TERRA_PROMOTIONAL = {
  short: '1 per day',
  tooltip:
    'New. A temporary price that goes up when the promotion ends. Open on full access, a paid plan on limited access. One session a day on every plan.',
} as const

/**
 * Sol's pill (product, 2026-10-28): the same words as Terra's, so the two
 * one-a-day OpenAI rows read alike. Sol stays US-or-paid; the tooltip says so.
 */
export const GPT_61_SOL_PROMOTIONAL = {
  short: '1 per day',
  tooltip:
    'A promotional price that goes up when the promotion ends. Open with a US connection or a paid plan. One session a day on every plan.',
} as const

/**
 * Models capped at N paid session-hours per Freebucks day, for EVERY account
 * (a plan does not lift it). Enforced by the admission debit under the account
 * lock (`debitAdmission`), counting the day's session debits for the model
 * (except failed starts and hours refunded in full), so it holds on every
 * surface and against parallel starts.
 * Re-entering an hour already paid for never debits, so it is not a second
 * session; a Desktop renewal of a tab's next hour is.
 */
export const FREEBUFF_DAILY_SESSION_LIMITS: Readonly<Record<string, number>> =
  Object.freeze({
    [GPT_61_SOL_MODEL_ID]: 1,
    [GEMINI_4_ARGON_MODEL_ID]: 1,
    [GPT_61_TERRA_MODEL_ID]: 1,
  })

/**
 * The daily session limit admission enforces for a model, or undefined for
 * none. The server catalog's value wins (`null` there means "no limit", even
 * for a model with a compiled one).
 */
export function freebuffDailySessionLimit(modelId: string): number | undefined {
  const override = getFreebuffModelPolicyOverlay()?.dailySessionLimit?.(modelId)
  if (override === null) return undefined
  if (override !== undefined) return override
  return FREEBUFF_DAILY_SESSION_LIMITS[modelId]
}
