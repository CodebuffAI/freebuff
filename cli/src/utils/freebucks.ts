/**
 * Freebucks, for the CLI — read entirely off the wire.
 *
 * ## Why this file exists at all
 *
 * Web and Desktop import `@codebuff/common/constants/freebuff-freebucks` for
 * the label, the formatter and the price map. **The CLI cannot.** That module
 * is deleted from the public export (`scripts/public-export-manifest.txt`
 * carries `!common/src/constants/freebuff-freebucks.ts`) because it documents
 * measured per-session provider costs, while `cli/` IS exported — so an import
 * of it here builds fine in this repo and fails to resolve in the public one,
 * with nothing in CI to catch it.
 *
 * That constraint turns out to be the right shape anyway. Everything the
 * picker needs is already on the session response: `prices` is a map of model
 * id to price, and the balances come with it. So the CLI derives nothing and
 * hardcodes no number — repricing a model reaches an installed CLI on its next
 * poll, exactly as it does on the other two surfaces.
 *
 * The one thing that cannot come off the wire is the WORD, so it is duplicated
 * below. If the currency is ever renamed, this is the second place to change.
 */

import { getFreebucksInfo } from '@codebuff/common/types/freebuff-session'

import type {
  FreebuffFreebucksInfo,
  FreebuffSessionServerResponse,
} from '@codebuff/common/types/freebuff-session'

/** Duplicated from `FREEBUCKS_LABEL`; see the header for why it cannot be
 *  imported. Kept as one constant so a rename is one edit here. */
export const FREEBUCKS_LABEL = 'Freebucks'

/** Matches `formatFreebucks` in common: whole units, never negative. */
export function formatFreebucks(amount: number): string {
  return Math.max(0, Math.round(amount)).toLocaleString()
}

/** The caller's meter, or undefined when this account is not on it. Presence
 *  of the block IS the gate on every surface — there is deliberately no
 *  client-side role check that could drift from what is actually charged. */
export function freebucksOf(
  session: { status: string } | null | undefined,
): FreebuffFreebucksInfo | undefined {
  return getFreebucksInfo(
    session as FreebuffSessionServerResponse | null | undefined,
  )
}

/**
 * What an hour of `modelId` costs, or undefined when the row is not metered.
 *
 * Two ways to be unpriced and they are deliberately the same answer: the
 * account is not on the meter, or the price map does not carry the row — which
 * the server treats as falling through to whatever metered it before. The map
 * is the allowlist, so asking it is the only correct way to know.
 */
export function freebucksPriceFor(
  freebucks: FreebuffFreebucksInfo | undefined,
  modelId: string,
): number | undefined {
  return freebucks?.prices[modelId]
}

/**
 * What picking a row costs, and therefore what to ask before it happens.
 *
 * Deliberately identical to Desktop's `freebucksRowIntent` and Web's
 * `rowIntent`: three surfaces selling one currency must not disagree about
 * when it is spent. Ordered by what the case costs the reader —
 *
 * - `paywall` — pool AND wallet together cannot cover it, so nothing else
 *   about the row matters: it cannot start. Refused where the balance is
 *   already on screen rather than after a prompt is typed and thrown away.
 * - `confirm` — affordable, but spends something that does not come back: a
 *   live session, or wallet Freebucks (the daily pool refills at midnight, the
 *   wallet never does).
 * - `allow` — everything else, including every row on an unmetered account.
 *
 * Re-picking the model already running is `allow` on purpose: a question with
 * nothing behind it is one people learn to click through, and then it protects
 * nobody on the picks that matter.
 */
export type FreebucksRowIntent =
  | { kind: 'allow'; price: number | undefined; walletSpend: number }
  | { kind: 'paywall'; price: number; walletSpend: 0 }
  | { kind: 'confirm'; price: number; walletSpend: number }

export function freebucksRowIntent(
  freebucks: FreebuffFreebucksInfo | undefined,
  modelId: string,
  /** The model the live session is bound to, if there is one. */
  activeModelId: string | undefined,
): FreebucksRowIntent {
  const price = freebucksPriceFor(freebucks, modelId)
  if (!freebucks || price === undefined) {
    return { kind: 'allow', price, walletSpend: 0 }
  }
  // `<` not `<=`: a balance that exactly equals the price BUYS the session.
  // `<=` would refuse one the server admits and strand the last Freebucks in
  // the account.
  if (freebucks.balance < price) {
    return { kind: 'paywall', price, walletSpend: 0 }
  }
  const walletSpend = Math.max(0, price - freebucks.daily.remaining)
  const endsSession = activeModelId !== undefined && activeModelId !== modelId
  return endsSession || walletSpend > 0
    ? { kind: 'confirm', price, walletSpend }
    : { kind: 'allow', price, walletSpend }
}

/**
 * The picker's rows, CHEAPEST FIRST — the same order Web and Desktop use.
 *
 * The catalog's own order leads with the recommended row, which is right until
 * every row carries a price: then the menu's subject is cost, and leading with
 * a 15 above a 5 reads as a mistake. Ties break on display name so the order
 * is stable rather than dependent on catalog position.
 *
 * ONLY when metered. An unmetered account has no prices to sort by, and
 * falling back to a name sort there would replace a deliberate catalog order
 * with an alphabetical one — a regression for everyone not yet on the meter.
 * An unpriced row on a metered account sorts LAST: `undefined` is not free.
 */
export function sortModelsByPrice<
  T extends { id: string; displayName: string },
>(
  models: readonly T[],
  freebucks: FreebuffFreebucksInfo | undefined,
): readonly T[] {
  if (!freebucks) return models
  const priceOf = (id: string) =>
    freebucksPriceFor(freebucks, id) ?? Number.POSITIVE_INFINITY
  return [...models].sort(
    (a, b) =>
      priceOf(a.id) - priceOf(b.id) || a.displayName.localeCompare(b.displayName),
  )
}

/**
 * The one-line header for a metered account:
 * `100/100 Freebucks daily · resets in 4h 12m · 20 in wallet · $25 monthly usage left`
 * (the countdown only when a clock is given, the wallet only when there is
 * something in it).
 *
 * The same four figures, in the same order, as the Web and Desktop pickers.
 * Built as a string rather than as components because the CLI's selector
 * measures its own height in ROWS before it renders — a line that can wrap
 * unpredictably breaks the layout budget, so it is composed here where its
 * width can be reasoned about, and truncated by the caller if it must be.
 *
 * The dollar allowance is omitted when the server did not send one (an older
 * server, or a spend read that failed), rather than shown as `$0` — which
 * would tell a user with a full allowance that they had none.
 */
export function freebucksHeaderLine(
  freebucks: FreebuffFreebucksInfo,
  /** When given, the daily figure carries "resets in 4h 12m". */
  nowMs?: number,
): string {
  const parts = [
    `${formatFreebucks(freebucks.daily.remaining)}/${formatFreebucks(
      freebucks.daily.limit,
    )} ${FREEBUCKS_LABEL} daily`,
  ]
  if (nowMs !== undefined) {
    parts.push(`resets in ${freebucksResetCountdown(freebucks.daily.resetAt, nowMs)}`)
  }
  // An empty wallet is the ordinary case for a free account, and "0 wallet"
  // reads as something to worry about. Web and Desktop hide it too.
  if (freebucks.wallet.balance > 0) {
    parts.push(`${formatFreebucks(freebucks.wallet.balance)} in wallet`)
  }
  return parts.join(' · ')
}

/**
 * "$25", "$4.20", "$0" — whole dollars until the figure is small enough that
 * the cents are the story. Mirrors the Web panel's formatter: a ceiling shown
 * as "$25.00" reads as an invoice, and one shown as "$0" while 40 cents remain
 * is the kind of rounding a user discovers by being refused with money
 * apparently still on the counter.
 */
export function formatAllowanceUsd(usd: number): string {
  const safe = Math.max(0, usd)
  if (safe >= 10) return `$${Math.round(safe)}`
  if (safe >= 1) return `$${safe.toFixed(1).replace(/\.0$/, '')}`
  return `$${safe.toFixed(2)}`
}

/** `15/hr` — what a Freebuck buys is an HOUR, and a bare number reads as a
 *  per-message rate, which is the most expensive misreading this menu can
 *  create. */
export function freebucksPriceLabel(price: number): string {
  // Named, not just numbered: a bare `20/hr` reads as dollars to anyone who
  // has not met the currency yet (reported from the first prod screenshot).
  return `${formatFreebucks(price)} ${FREEBUCKS_LABEL}/hr`
}

/**
 * The one-time introduction, in the CLI's own words. The same three points
 * Web and Desktop show (their copy lives in the private constants file the
 * CLI cannot import — see the header of this module); kept in step by hand.
 */
export const FREEBUCKS_INTRO = {
  title: 'Meet Freebucks',
  lead: 'Sessions are now bought with Freebucks instead of counted against weekly and monthly limits.',
  points: [
    'A fresh pool every day — spend it on any model.',
    'No more weekly or monthly session caps.',
    'Each model shows its price per hour; the list runs cheapest first.',
  ],
  dismiss: 'Shown once. Press any key to continue.',
} as const

/** Under the picker on a metered account, in place of the tier notices. */
export const FREEBUCKS_PICKER_NOTICE =
  'Each model is priced in Freebucks per hour of session, charged once when the session starts. Your daily Freebucks refill at midnight Pacific; the wallet keeps what you buy or earn.'

/**
 * "4h 12m", "38m", "2d 5h" — until the daily pool refills. Same shape as the
 * Web and Desktop pickers' countdowns; "now" once it has passed.
 */
export function freebucksResetCountdown(resetAt: string, nowMs: number): string {
  const remainingMs = Date.parse(resetAt) - nowMs
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 'now'
  const totalMinutes = Math.ceil(remainingMs / 60_000)
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}
