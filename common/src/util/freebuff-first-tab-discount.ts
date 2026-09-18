import type { FreebuffFreebucksInfo } from '../types/freebuff-session'

/** Presence opts into the offer; POST 1 also requires it at purchase time. */
export const FIRST_TAB_DISCOUNT_HEADER = 'x-freebuff-first-tab-discount'
export const FIRST_TAB_DISCOUNT_CHANGED_MESSAGE =
  'Your first-tab discount changed. Review the model menu and choose again. No Freebucks were charged.'

export const discountedSessionPrice = (price: number, discount: number) =>
  Math.max(0, price - discount)

/** Discounts from the LIST prices, so re-applying to an already-discounted
 * quote never stacks, and keeps those list prices on the quote for the
 * crossed-out original beside each discounted row. */
export function applyFirstTabDiscount(
  info: FreebuffFreebucksInfo,
  discount: NonNullable<FreebuffFreebucksInfo['firstTabDiscount']>,
): FreebuffFreebucksInfo {
  const listPrices = info.listPrices ?? info.prices
  return {
    ...info,
    firstTabDiscount: discount,
    listPrices,
    prices: Object.fromEntries(
      Object.entries(listPrices).map(([model, price]) => [
        model,
        discountedSessionPrice(price, discount.available ? discount.amount : 0),
      ]),
    ),
  }
}

/**
 * The list price to draw crossed out beside `modelId`'s discounted price, or
 * undefined when there is nothing to cross out: no offer, the offer in use by
 * another session, an unpriced row, or a row the discount did not move (a row
 * already at 0 is not "0 off 0"). A quote from a server that predates
 * `listPrices` answers undefined for every row rather than guessing —
 * `price + amount` is wrong for every row the zero floor clamped.
 */
export function firstTabListPriceFor(
  info: Pick<FreebuffFreebucksInfo, 'prices' | 'listPrices' | 'firstTabDiscount'>
    | null
    | undefined,
  modelId: string,
): number | undefined {
  if (!info?.firstTabDiscount?.available) return undefined
  const price = info.prices[modelId]
  const listPrice = info.listPrices?.[modelId]
  if (price === undefined || listPrice === undefined || listPrice <= price)
    return undefined
  return listPrice
}

/** Switching the owning session releases its discount before the next purchase.
 * Other tabs, detached purchases and expired sessions keep the account quote. */
export function firstTabQuoteForSession(
  info: FreebuffFreebucksInfo | null | undefined,
  session: { instanceId?: string; expiresAt: string } | undefined,
  surface: 'desktop' | 'single',
  now = Date.now(),
): FreebuffFreebucksInfo | null | undefined {
  const discount = info?.firstTabDiscount
  const holder = discount?.holder
  if (
    !info ||
    !discount ||
    discount.available ||
    !holder ||
    !session?.instanceId ||
    holder.surface !== surface ||
    holder.instanceId !== session.instanceId ||
    Date.parse(session.expiresAt) <= now ||
    Date.parse(holder.expiresAt) <= now
  )
    return info
  return applyFirstTabDiscount(info, { ...discount, available: true })
}

export function firstTabDiscountCopy(
  info: Pick<FreebuffFreebucksInfo, 'firstTabDiscount'>,
): string | undefined {
  const discount = info.firstTabDiscount
  if (!discount) return undefined
  return discount.available
    ? `Limited-time first-tab discount: up to ${discount.amount} Freebucks off one session at a time, shared across Web, Desktop and CLI. Prices shown include the discount; the crossed-out price is the regular one.`
    : `Your first-tab discount is in use. Parallel sessions pay the regular price. The discount becomes available when that session ends.`
}
