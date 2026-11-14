/**
 * One dated repricing (product, 2026-10-22): from `FREEBUFF_REPRICE_AT`,
 * new sessions on these rows cost the prices below; sessions already admitted
 * keep the price they were admitted at.
 *
 *   Gemini 4 Argon             100 -> 250  (its promotional price ends)
 *   GPT-6.1 Sol                250 -> 200
 *   Claude Haiku 5.5 (full)     75 -> 100
 *   Gemini 3.8 Flash            80 -> 100  (added the same day)
 *
 * Until then the rows carry the pills that announce it (Argon's "Ending
 * soon", the full Haiku row's and Gemini 3.8 Flash's "Price change"), and
 * they drop at the same instant. Compiled rows read the price through
 * `freebucksSessionPrice`; the catalog-only Haiku row through its catalog
 * entry, rebuilt with the time on every catalog refresh. A leaf module: the price map and the catalog both
 * read it.
 */
export const FREEBUFF_REPRICE_AT = Date.parse('2026-10-23T00:00:00Z')

export const FREEBUFF_SCHEDULED_PRICES: Readonly<Record<string, number>> =
  Object.freeze({
    'google/gemini-4-argon': 250,
    'openai/gpt-6.1-sol': 200,
    'fbc/claude-haiku-5.5': 100,
    'google/gemini-3.8-flash': 100,
  })

/**
 * THE PLAN RATE CHANGE (product, 2026-10-30): from this instant a new plan buys
 * less: every plan's monthly bonus falls (`FREEBUCKS_PLANS_FROM_RATE_CHANGE`).
 * Daily pools do not change (product, 2026-11-03; limited Starter's was to fall
 * from 105 to 75). An account created from `FREEBUFF_NEW_ACCOUNT_SINCE` is on
 * the reduced bonus already, deadline or not. Anyone subscribed
 * before it keeps today's rates for as long as they stay subscribed
 * (`planRatesLocked`). It falls at midnight Pacific, the end of Sunday,
 * November 8 (moved from November 5 on 2026-11-02, before it shipped).
 * Until then every surface sells the deadline; admission and the ledger read
 * the same instant, so the two cannot disagree.
 */
export const FREEBUFF_PLAN_RATES_CHANGE_AT = Date.parse('2026-11-09T08:00:00Z')

/**
 * Accounts created from this instant are new accounts (product, 2026-11-03,
 * Victor): their plans carry the reduced monthly bonus at once, and they pick
 * from the new-account model catalog
 * (packages/internal/.../new-account-catalog.ts reads this same instant).
 * Rounded up past that change's deploy, so no account made before it moves.
 */
export const FREEBUFF_NEW_ACCOUNT_SINCE = Date.parse('2026-11-03T10:00:00Z')

/** Whether an account created at `createdAt` is a new account. */
export function isFreebuffNewAccount(createdAt: Date | string | number): boolean {
  return new Date(createdAt).getTime() >= FREEBUFF_NEW_ACCOUNT_SINCE
}

/** Whether new plans are on the reduced rates at `now`. */
export function freebuffPlanRatesChanged(now: number = Date.now()): boolean {
  return now >= FREEBUFF_PLAN_RATES_CHANGE_AT
}

/**
 * Whether a subscription row keeps the rates from before the change: its
 * unbroken run of being subscribed began before it, on an account that is not
 * new (`newAccount`, which the caller reads from the account's age). `null` is
 * no subscription. A row with no start date predates the column, so it is such
 * a run. Whether the plan is live is the caller's question.
 */
export function planRatesLocked(
  row: { planStartedAt?: Date | string | null } | null | undefined,
  newAccount = false,
): boolean {
  if (!row || newAccount) return false
  if (row.planStartedAt == null) return true
  return new Date(row.planStartedAt).getTime() < FREEBUFF_PLAN_RATES_CHANGE_AT
}

/** The rate terms a subscription row puts its holder on, for
 *  `freebucksPlan` / `freebucksPlansAt`: locked to the old rates, or a new
 *  account's (always the reduced ones). */
export function planRateTerms(
  row: Parameters<typeof planRatesLocked>[0],
  newAccount = false,
): { ratesLocked: boolean; newAccount: boolean } {
  return { ratesLocked: planRatesLocked(row, newAccount), newAccount }
}

/** The scheduled price of a row at `now`, once the repricing has happened. */
export function scheduledFreebucksPrice(
  modelId: string,
  now: number = Date.now(),
): number | undefined {
  return now >= FREEBUFF_REPRICE_AT
    ? FREEBUFF_SCHEDULED_PRICES[modelId]
    : undefined
}

/** Whether the pills announcing the repricing still show at `now`. */
export function freebuffRepriceAnnounced(now: number = Date.now()): boolean {
  return now < FREEBUFF_REPRICE_AT
}
