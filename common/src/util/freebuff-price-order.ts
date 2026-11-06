import type { FreebuffFreebucksInfo } from '../types/freebuff-session'

/**
 * The model pickers' order on the meter: cheapest first.
 *
 * 1. The price this viewer pays now (`prices`). Unpriced rows sort last:
 *    `undefined` is not free.
 * 2. Then the regular price (`listPrices`, present while a catalog discount
 *    applies), so two rows a discount brought to the same price keep their
 *    regular order instead of falling through to the name.
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

/**
 * The regular price to draw crossed out beside `modelId`'s price, or
 * undefined when there is nothing to cross out: an unpriced row, or one whose
 * list price (a catalog discount's `listPrices`) is not above what it costs.
 */
export function freebucksListPriceFor(
  info: Pick<FreebuffFreebucksInfo, 'prices' | 'listPrices'> | null | undefined,
  modelId: string,
): number | undefined {
  const price = info?.prices[modelId]
  const listPrice = info?.listPrices?.[modelId]
  if (price === undefined || listPrice === undefined || listPrice <= price)
    return undefined
  return listPrice
}

/**
 * A row's drawn price: `quoted` less the solo-session discount, which is what
 * admission charges, and the regular price to cross out beside it (a catalog
 * list price, else `quoted` when the discount moved it). `quoted` is undefined
 * for an unpriced or locked row. Shared by Desktop, the CLI and Web.
 */
export function freebucksRowPrice(
  info:
    | Pick<FreebuffFreebucksInfo, 'prices' | 'listPrices' | 'soloDiscount'>
    | null
    | undefined,
  modelId: string,
  quoted: number | undefined,
): { price: number | undefined; listPrice: number | undefined } {
  if (quoted === undefined) return { price: undefined, listPrice: undefined }
  const price = Math.max(0, quoted - (info?.soloDiscount ?? 0))
  return {
    price,
    listPrice:
      freebucksListPriceFor(info, modelId) ??
      (price < quoted ? quoted : undefined),
  }
}
