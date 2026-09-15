import type { FreebuffFreebucksInfo } from '../types/freebuff-session'

/** Presence opts into the offer; POST 1 also requires it at purchase time. */
export const FIRST_TAB_DISCOUNT_HEADER = 'x-freebuff-first-tab-discount'
export const FIRST_TAB_DISCOUNT_CHANGED_MESSAGE =
  'Your first-tab discount changed. Review the model menu and choose again. No Freebucks were charged.'

export const discountedSessionPrice = (price: number, discount: number) =>
  Math.max(0, price - discount)

export function applyFirstTabDiscount(
  info: FreebuffFreebucksInfo,
  discount: NonNullable<FreebuffFreebucksInfo['firstTabDiscount']>,
): FreebuffFreebucksInfo {
  return {
    ...info,
    firstTabDiscount: discount,
    prices: Object.fromEntries(
      Object.entries(info.prices).map(([model, price]) => [
        model,
        discountedSessionPrice(price, discount.available ? discount.amount : 0),
      ]),
    ),
  }
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
    ? `First-tab discount: up to ${discount.amount} Freebucks off one session at a time, shared across Desktop and CLI. Prices shown include the discount.`
    : `Your first-tab discount is in use. Parallel sessions pay the regular price. The discount becomes available when that session ends.`
}
