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
 * The wire still carries Freebucks; users see hours (2026-10-14: one hour is 5
 * Freebucks). Every figure the CLI draws converts through
 * `@codebuff/common/util/freebuff-hours`, which IS exported, and a model's
 * price reads as its multiplier ("2x").
 */

import {
  formatHours,
  formatHoursWithUnit,
  freebuffModelMultiplierLabel,
} from '@codebuff/common/util/freebuff-hours'
import { compareByFreebucksPrice } from '@codebuff/common/util/freebuff-price-order'
import { getFreebucksInfo } from '@codebuff/common/types/freebuff-session'
import {
  FREEBUCKS_REFILL_PENDING_LABEL,
  freebucksRefillPending,
} from '@codebuff/common/util/freebucks-reset'

import type {
  FreebuffFreebucksInfo,
  FreebuffSessionServerResponse,
} from '@codebuff/common/types/freebuff-session'

/** The caller's meter: null when unavailable, undefined when absent. Presence
 *  of the block IS the gate on every surface — there is deliberately no
 *  client-side role check that could drift from what is actually charged. */
export function freebucksOf(
  session: { status: string } | null | undefined,
): FreebuffFreebucksInfo | null | undefined {
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
  freebucks: FreebuffFreebucksInfo | null | undefined,
  modelId: string,
): number | undefined {
  return freebucks?.prices[modelId]
}

export { freebucksRowIntent } from '@codebuff/common/util/freebuff-model-selection'
export type { FreebucksRowIntent } from '@codebuff/common/util/freebuff-model-selection'

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
  freebucks: FreebuffFreebucksInfo | null | undefined,
): readonly T[] {
  if (!freebucks) return models
  // Ties (two rows a catalog discount brought to one price) break on the
  // regular price, then the name — shared with Desktop and Web.
  return [...models].sort((a, b) => compareByFreebucksPrice(freebucks, a, b))
}

/**
 * The one-line header for a metered account:
 * `20/20 hours daily · resets in 4h 12m · 4 hours in wallet`
 * (the countdown only when a clock is given, the wallet only when there is
 * something in it).
 *
 * The same figures, in the same order, as the Web and Desktop pickers.
 * Built as a string rather than as components because the CLI's selector
 * measures its own height in ROWS before it renders — a line that can wrap
 * unpredictably breaks the layout budget, so it is composed here where its
 * width can be reasoned about, and truncated by the caller if it must be.
 */
export function freebucksHeaderLine(
  freebucks: FreebuffFreebucksInfo,
  /** When given, the daily figure carries "resets in 4h 12m". */
  nowMs?: number,
): string {
  const parts = [
    `${formatHours(freebucks.daily.remaining)}/${formatHours(
      freebucks.daily.limit,
    )} hours daily`,
  ]
  if (nowMs !== undefined) {
    parts.push(
      freebucksRefillPending(freebucks.daily.resetAt, nowMs)
        ? FREEBUCKS_REFILL_PENDING_LABEL
        : `resets in ${freebucksResetCountdown(freebucks.daily.resetAt, nowMs)}`,
    )
  }
  // An empty wallet is the ordinary case for a free account, and "0 wallet"
  // reads as something to worry about. Web and Desktop hide it too; so is a
  // wallet too small to show as a whole hour.
  if (formatHours(freebucks.wallet.balance) !== '0') {
    parts.push(`${formatHoursWithUnit(freebucks.wallet.balance)} in wallet`)
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

/**
 * A price that must say SOMETHING, such as the off-peak price a row returns
 * to: its multiplier, or "Free" / "1x" where a row's own label stays blank
 * (`freebuffModelMultiplierLabel`, never "0x").
 */
export function freebucksPriceText(price: number): string {
  return freebuffModelMultiplierLabel(price) ?? (price <= 0 ? 'Free' : '1x')
}

/**
 * "4h 12m", "38m", "2d 5h" — until the daily pool refills. Same shape as the
 * Web and Desktop pickers' countdowns; "now" once it has passed.
 */
export function freebucksResetCountdown(
  resetAt: string,
  nowMs: number,
): string {
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

/**
 * The end-of-session refund receipt, or null when there is nothing to report.
 *
 * Users read the refund as pro-rated by TIME — "I ended 20 minutes early and
 * still lost all 100" — because nothing told them otherwise. It is not: the
 * server returns `charge - final provider cost`, so ending early returns the
 * charge the hour did not spend and never minutes. Every line below therefore
 * names the quantity, and the zero case says so out loud instead of leaving
 * the user to infer that the feature was removed.
 *
 * `0` is a settled receipt: the hour's usage cost as much as its price, the
 * price was one hour (every session keeps one, 2026-10-28), or the day's
 * allowance was already used up. It is the ordinary outcome on a cheap row and
 * the one that gets reported as a bug. An unsettled or dropped receipt is
 * `null` and says nothing.
 */
export function freebucksRefundLine(
  lastRefund: number | null,
  refundPending: boolean,
): string | null {
  if (refundPending) {
    return 'Refund settling: the whole hours of balance this session did not spend come back, less the one hour every session keeps.'
  }
  if (lastRefund === null) return null
  if (lastRefund <= 0) {
    return 'No hours returned: every session keeps at least one hour of its price, and a refund never refills a daily allowance already used up. A refund returns whole hours of balance a session did not spend, never unused time.'
  }
  return `${formatHoursWithUnit(lastRefund)} of balance returned: what the session's price did not spend, not the time left on it.`
}
