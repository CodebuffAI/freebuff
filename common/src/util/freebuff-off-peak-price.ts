import {
  formatWindowTimeZoneLabel,
  resolveWindowTimeZone,
} from '../constants/freebuff-peak-hours'
import type { FreebuffFreebucksInfo } from '../types/freebuff-session'
import { offPeakPriceAt, offPeakRuns } from './freebuff-price-changes'

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

  const { nextChangeAt, price } = offPeakPriceAt(offer, now)
  const zone = resolveWindowTimeZone(timeZone)
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
    badge: active ? 'Off-peak' : 'Peak',
    resumes,
    tooltip: scheduleSentence(offer, now, zone),
  }
}

/**
 * One sentence: the EXCEPTION window — whichever price holds for fewer hours
 * a week — named, with its price, its hours on the reader's clock and the
 * server's reason, then the other price. Flash reads "Off-peak: 10
 * Freebucks/hr 3 PM–11 PM PDT, when Freebuff is quiet. 15 otherwise."; fast
 * mode reads "Peak: 50 Freebucks/hr Sun–Thu, …".
 */
function scheduleSentence(
  offer: NonNullable<FreebuffFreebucksInfo['offPeak']>[string],
  now: number,
  zone: string,
) {
  const runs = offPeakRuns(offer, now)
  const hoursOf = (offPeak: boolean) =>
    runs
      .filter((run) => run.offPeak === offPeak)
      .reduce((sum, run) => sum + run.end - run.start, 0)
  const offPeak = hoursOf(true) <= hoursOf(false)
  const exception = runs.filter((run) => run.offPeak === offPeak)
  const [first] = exception
  const [rare, usual] = offPeak
    ? [offer.price, offer.regularPrice]
    : [offer.regularPrice, offer.price]
  if (!first) return `${offer.price} Freebucks/hr.`
  const start = new Date(first.start)
  const end = new Date(first.end)
  const startZone = formatWindowTimeZoneLabel(start, zone)
  const endZone = formatWindowTimeZoneLabel(end, zone)
  const hours = `${formatTime(start, zone)}${startZone === endZone ? '' : ` ${startZone}`}–${formatTime(end, zone)} ${endZone}`
  const days = dayRange(
    exception.map((run) => new Date(run.start)),
    zone,
  )
  const reason = offer.reason ? `, ${offer.reason}` : ''
  return `${offPeak ? 'Off-peak' : 'Peak'}: ${rare} Freebucks/hr ${days ? `${days}, ` : ''}${hours}${reason}. ${usual} otherwise.`
}

/** "3 PM", or "3:30 PM" in a zone off the hour. */
function formatTime(at: Date, zone: string) {
  const minute = new Intl.DateTimeFormat('en-US', {
    minute: '2-digit',
    timeZone: zone,
  }).format(at)
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    ...(Number(minute) === 0 ? {} : { minute: '2-digit' as const }),
    timeZone: zone,
  }).format(at)
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** The local weekdays the runs start on: "" when every day, "Sun–Thu" for a
 *  consecutive span, otherwise a list. */
function dayRange(starts: Date[], zone: string) {
  const index = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    timeZone: zone,
  })
  const label = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    timeZone: zone,
  })
  const byDay = new Map<number, string>()
  for (const at of starts)
    byDay.set(WEEKDAYS.indexOf(index.format(at)), label.format(at))
  if (byDay.size >= 7) return ''
  const first = [...byDay.keys()].find((day) => !byDay.has((day + 6) % 7))!
  const span: number[] = []
  for (let day = first; byDay.has(day); day = (day + 1) % 7) span.push(day)
  if (span.length === byDay.size)
    return span.length === 1
      ? byDay.get(first)!
      : `${byDay.get(first)}–${byDay.get(span[span.length - 1]!)}`
  return [...byDay.keys()]
    .sort((a, b) => a - b)
    .map((day) => byDay.get(day))
    .join(', ')
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
