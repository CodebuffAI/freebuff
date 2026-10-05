import {
  formatWindowTimeZoneLabel,
  resolveWindowTimeZone,
} from '../constants/freebuff-peak-hours'
import type { FreebuffFreebucksInfo } from '../types/freebuff-session'
import { offPeakPriceAt } from './freebuff-price-changes'

/** Presentation only: prices and schedules come from the server, never the
 *  private rate card. */
export function freebucksOffPeakCopy(
  info:
    | Pick<FreebuffFreebucksInfo, 'prices' | 'offPeak'>
    | null
    | undefined,
  modelId: string,
  { now = Date.now(), timeZone }: { now?: number; timeZone?: string } = {},
) {
  const offer = info?.offPeak?.[modelId]
  if (!offer || info?.prices[modelId] === undefined) return undefined

  const { start, end, nextChangeAt, price } = offPeakPriceAt(offer, now)
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
  const active = info.prices[modelId] === offer.price
  // At peak, when the off-peak price is back, so a reader can choose to wait.
  // Only when the policy agrees it is peak: a stale quote must not promise a
  // drop at what is really the END of the off-peak window.
  const resumes =
    !active && price !== offer.price
      ? { price: offer.price, at: formatResumeAt(nextChangeAt, now, zone) }
      : undefined
  return {
    active,
    badge: 'Off-peak',
    resumes,
    tooltip: `${resumes ? `Back to ${resumes.price} Freebucks/hour at ${resumes.at}. ` : ''}Off-peak: ${offer.price} Freebucks/hour, daily ${hours}${weekend}.`,
  }
}

/** "3:00 AM PDT" when `at` falls on the reader's today, "Mon 3:00 AM PDT"
 *  otherwise: a peak ending after local midnight must not read as tonight. */
function formatResumeAt(at: number, now: number, zone: string) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: zone })
  const today = day.format(at) === day.format(now)
  const time = new Intl.DateTimeFormat(undefined, {
    ...(today ? {} : { weekday: 'short' as const }),
    hour: 'numeric',
    minute: '2-digit',
    timeZone: zone,
  }).format(at)
  return `${time} ${formatWindowTimeZoneLabel(new Date(at), zone)}`
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
