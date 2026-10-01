import type { FreebuffFreebucksInfo } from '../types/freebuff-session'

/**
 * The model pickers' order on the meter: cheapest first.
 *
 * 1. The price this viewer pays now (`prices`). Unpriced rows sort last:
 *    `undefined` is not free.
 * 2. Then the regular price (`listPrices`, present while a discount applies).
 *    The first-tab discount floors several rows at 0, and without this key
 *    those ties fell through to the name, so a 15 sat above a 2 (2026-10-01).
 * 3. Then the display name, so the order is stable.
 *
 * Shared by Desktop, the CLI and Web so the three pickers cannot disagree.
 */
export function compareByFreebucksPrice(
  freebucks: Pick<FreebuffFreebucksInfo, 'prices' | 'listPrices'>,
  a: { id: string; displayName: string },
  b: { id: string; displayName: string },
): number {
  const price = (id: string) => freebucks.prices[id] ?? Number.POSITIVE_INFINITY
  const list = (id: string) =>
    freebucks.listPrices?.[id] ??
    freebucks.prices[id] ??
    Number.POSITIVE_INFINITY
  return (
    orderOf(price(a.id), price(b.id)) ||
    orderOf(list(a.id), list(b.id)) ||
    a.displayName.localeCompare(b.displayName)
  )
}

/** `x - y`, except two unpriced rows (both infinite) compare equal, not NaN. */
function orderOf(x: number, y: number): number {
  return x === y ? 0 : x - y
}
