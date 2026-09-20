import {
  formatWindowTimeZoneLabel,
  resolveWindowTimeZone,
} from '../constants/freebuff-peak-hours'
import type { FreebuffFreebucksInfo } from '../types/freebuff-session'
import { discountedSessionPrice } from './freebuff-first-tab-discount'
import { offPeakPriceAt } from './freebuff-price-changes'

/** Presentation only: prices and schedules come from the server, never the
 *  private rate card. */
export function freebucksOffPeakCopy(
  info:
    | Pick<FreebuffFreebucksInfo, 'prices' | 'offPeak' | 'firstTabDiscount'>
    | null
    | undefined,
  modelId: string,
  { now = Date.now(), timeZone }: { now?: number; timeZone?: string } = {},
) {
  const offer = info?.offPeak?.[modelId]
  if (!offer || info?.prices[modelId] === undefined) return undefined

  const { start, end } = offPeakPriceAt(offer, now)
  const zone = resolveWindowTimeZone(timeZone)
  const fmt = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: zone,
  })
  const startZone = formatWindowTimeZoneLabel(start, zone)
  const endZone = formatWindowTimeZoneLabel(end, zone)
  const hours = `${fmt.format(start)}${startZone === endZone ? '' : ` ${startZone}`}–${fmt.format(end)} ${endZone}`
  // The resolved quote owns the badge too; do not run a second pricing clock.
  const active =
    info.prices[modelId] ===
    discountedSessionPrice(
      offer.price,
      info.firstTabDiscount?.available ? info.firstTabDiscount.amount : 0,
    )
  return {
    active,
    badge: 'Off-peak',
    tooltip: `Off-peak: ${offer.price} Freebucks/hour, daily ${hours}.`,
  }
}
