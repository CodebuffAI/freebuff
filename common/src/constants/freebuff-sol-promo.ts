/**
 * GPT-6.1 Sol's promotion (2026-09-29): a temporary price, and ONE SESSION A
 * DAY for every account, paid plans included.
 *
 * `GPT_61_SOL_PROMOTIONAL` is the catalog row's `promotional` field and the
 * server price notice (`freebucksPricing().priceNotices`) that released CLI
 * and Desktop builds render in place of the tagline. One constant so the two
 * cannot disagree — and it names the daily limit, so nobody meets the limit
 * for the first time as a refusal.
 *
 * A leaf module, like freebuff-solar-promo.ts, because the Freebucks price
 * map, the model catalog and the admission debit all read it and none may
 * import the others.
 */
export const GPT_61_SOL_MODEL_ID = 'openai/gpt-6.1-sol'

export const GPT_61_SOL_PROMOTIONAL = {
  short: 'Promotional · 1 session a day',
  tooltip:
    'Temporary promotional price, limited to one session a day for every account, paid plans included. The price will go up when the promotion ends.',
} as const

/**
 * Models capped at N paid session-hours per Freebucks day, for EVERY account
 * (a plan does not lift it). Enforced by the admission debit under the account
 * lock (`debitAdmission`), counting the day's un-refunded session debits for
 * the model, so it holds on every surface and against parallel starts.
 * Re-entering an hour already paid for never debits, so it is not a second
 * session; a Desktop renewal of a tab's next hour is.
 */
export const FREEBUFF_DAILY_SESSION_LIMITS: Readonly<Record<string, number>> =
  Object.freeze({
    [GPT_61_SOL_MODEL_ID]: 1,
  })
