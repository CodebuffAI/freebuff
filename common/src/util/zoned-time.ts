export interface ZonedDateParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

// Building a formatter costs far more than using one, and rollups call this
// once per row. A formatter is immutable, so one per zone is safe to share.
const partsFormatters = new Map<string, Intl.DateTimeFormat>()

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    partsFormatters.set(timeZone, formatter)
  }
  return formatter
}

export function getZonedParts(date: Date, timeZone: string): ZonedDateParts {
  const parts = partsFormatter(timeZone).formatToParts(date)

  const get = (type: string) => {
    const value = parts.find((part) => part.type === type)?.value
    if (!value) throw new Error(`Missing ${type} in ${timeZone} date parts`)
    return Number(value)
  }

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  }
}

/**
 * The calendar day in `timeZone`, as `YYYY-MM-DD`.
 *
 * The day-string counterpart to {@link getZonedDayBounds}, which returns
 * instants. Use this anywhere a day is stored or displayed as a string —
 * `toISOString().slice(0, 10)` is the same expression for UTC only, and
 * silently writes the wrong day for anything west of Greenwich for most of
 * each evening.
 */
export function getZonedYmd(date: Date, timeZone: string): string {
  const { year, month, day } = getZonedParts(date, timeZone)
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function addDaysToYmd(
  year: number,
  month: number,
  day: number,
  days: number,
): Pick<ZonedDateParts, 'year' | 'month' | 'day'> {
  const next = new Date(Date.UTC(year, month - 1, day))
  next.setUTCDate(next.getUTCDate() + days)
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  }
}

export function getUtcForZonedTime(
  parts: Pick<ZonedDateParts, 'year' | 'month' | 'day'>,
  timeZone: string,
  hour: number,
  minute: number,
): Date {
  let guess = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute),
  )

  for (let i = 0; i < 3; i++) {
    const actual = getZonedParts(guess, timeZone)
    const desiredUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      hour,
      minute,
    )
    const actualUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    )
    guess = new Date(guess.getTime() + (desiredUtc - actualUtc))
  }

  return guess
}

export function getZonedDayBounds(
  now: Date,
  timeZone: string,
): { startsAt: Date; resetsAt: Date } {
  const nowParts = getZonedParts(now, timeZone)
  const today = {
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
  }
  const tomorrow = addDaysToYmd(today.year, today.month, today.day, 1)

  return {
    startsAt: getUtcForZonedTime(today, timeZone, 0, 0),
    resetsAt: getUtcForZonedTime(tomorrow, timeZone, 0, 0),
  }
}

/**
 * Bounds of the calendar MONTH containing `now` in `timeZone`: `startsAt` is
 * midnight on the 1st, `resetsAt` midnight on the 1st of the next month. Pure
 * calendar math like the day/week helpers, so DST and year boundaries fall out
 * of `getUtcForZonedTime`. Used for the free tier's monthly window, which has
 * no billing period to align to.
 */
export function getZonedMonthBounds(
  now: Date,
  timeZone: string,
): { startsAt: Date; resetsAt: Date } {
  const nowParts = getZonedParts(now, timeZone)
  const first = { year: nowParts.year, month: nowParts.month, day: 1 }
  const nextFirst =
    nowParts.month === 12
      ? { year: nowParts.year + 1, month: 1, day: 1 }
      : { year: nowParts.year, month: nowParts.month + 1, day: 1 }
  return {
    startsAt: getUtcForZonedTime(first, timeZone, 0, 0),
    resetsAt: getUtcForZonedTime(nextFirst, timeZone, 0, 0),
  }
}

/**
 * Bounds of the calendar week containing `now` in `timeZone`. `startsAt` is
 * midnight at the start of the week, `resetsAt` is midnight 7 days later (the
 * next reset). `weekStartsOn` is 0=Sunday … 6=Saturday; defaults to Monday (1).
 * Pure calendar math via `addDaysToYmd`, so it handles DST and month/year
 * boundaries the same way `getZonedDayBounds` does.
 */
export function getZonedWeekBounds(
  now: Date,
  timeZone: string,
  weekStartsOn: number = 1,
): { startsAt: Date; resetsAt: Date } {
  const nowParts = getZonedParts(now, timeZone)
  // Day-of-week of the zoned calendar date (0=Sunday). Built from a UTC date so
  // the weekday is read off the y/m/d only, independent of the actual offset.
  const dow = new Date(
    Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day),
  ).getUTCDay()
  const daysSinceWeekStart = (dow - weekStartsOn + 7) % 7
  const weekStart = addDaysToYmd(
    nowParts.year,
    nowParts.month,
    nowParts.day,
    -daysSinceWeekStart,
  )
  const nextWeekStart = addDaysToYmd(
    weekStart.year,
    weekStart.month,
    weekStart.day,
    7,
  )

  return {
    startsAt: getUtcForZonedTime(weekStart, timeZone, 0, 0),
    resetsAt: getUtcForZonedTime(nextWeekStart, timeZone, 0, 0),
  }
}
