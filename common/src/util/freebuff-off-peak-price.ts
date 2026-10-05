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
  const weekend = offer.weekendsOffPeak
    ? `, and all weekend (${beijingWeekendSpan(now, zone)})`
    : ''
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
    tooltip: `Off-peak: ${offer.price} Freebucks/hour, daily ${hours}${weekend}.`,
  }
}

/** The weekend a policy with `weekendsOffPeak` means — Friday 16:00 to Sunday
 *  16:00 UTC, Saturday and Sunday in Beijing — as the reader's own clock shows
 *  it, taken from the most recent such weekend so seasonal time applies. */
function beijingWeekendSpan(now: number, zone: string) {
  const friday = new Date(now)
  friday.setUTCHours(16, 0, 0, 0)
  friday.setUTCDate(friday.getUTCDate() - ((friday.getUTCDay() - 5 + 7) % 7))
  if (+friday > now) friday.setUTCDate(friday.getUTCDate() - 7)
  const sunday = new Date(+friday + 2 * 24 * 60 * 60 * 1000)
  const fmt = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: zone,
  })
  return `${fmt.format(friday)}–${fmt.format(sunday)} ${formatWindowTimeZoneLabel(sunday, zone)}`
}
