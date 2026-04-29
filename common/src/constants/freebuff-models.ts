/**
 * Models a freebuff user can pick between in the waiting-room model selector.
 *
 * Each model has its own queue (server keys queue position by `model`), so the
 * list here is effectively the set of separate waiting lines. Order is the
 * order shown in the UI.
 */
export interface FreebuffModelOption {
  /** Stable ID used in the wire protocol and DB. Matches the model id passed
   *  to the chat-completions endpoint. */
  id: string
  /** Short label for the selector UI. */
  displayName: string
  /** One-line description shown next to the label. */
  tagline: string
  /** Availability policy for the selector and server-side admission. */
  availability: 'always' | 'deployment_hours'
}

/** Server-facing fallback copy for APIs and provider errors that can't know
 *  the caller's local timezone. The CLI should render
 *  `getFreebuffDeploymentAvailabilityLabel()` instead. */
export const FREEBUFF_DEPLOYMENT_HOURS_LABEL = '9am ET-5pm PT every day'
export const FREEBUFF_KIMI_MODEL_ID = 'moonshotai/kimi-k2.6'
export const FREEBUFF_MINIMAX_MODEL_ID = 'minimax/minimax-m2.7'
const FREEBUFF_EASTERN_TIMEZONE = 'America/New_York'
const FREEBUFF_PACIFIC_TIMEZONE = 'America/Los_Angeles'

interface ZonedDateParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

interface LocalTimeFormatOptions {
  locale?: string
  timeZone?: string
}

export const FREEBUFF_MODELS: readonly FreebuffModelOption[] = [
  {
    id: FREEBUFF_MINIMAX_MODEL_ID,
    displayName: 'MiniMax M2.7',
    tagline: 'Fastest',
    availability: 'always',
  },
  {
    id: FREEBUFF_KIMI_MODEL_ID,
    displayName: 'Kimi K2.6',
    tagline: 'Smartest',
    availability: 'always',
  },
]

export type FreebuffModelId =
  | typeof FREEBUFF_MINIMAX_MODEL_ID
  | typeof FREEBUFF_KIMI_MODEL_ID

/** What new freebuff users see selected in the picker. */
export const DEFAULT_FREEBUFF_MODEL_ID: FreebuffModelId = FREEBUFF_KIMI_MODEL_ID

/** Always-available fallback used when the requested model can't be served
 *  right now (unknown id, deployment hours closed, etc.). Kept distinct from
 *  DEFAULT_FREEBUFF_MODEL_ID so a new user's "preferred default" can be the
 *  smartest model without auto-flipping anyone to a closed serverless model. */
export const FALLBACK_FREEBUFF_MODEL_ID: FreebuffModelId =
  FREEBUFF_MINIMAX_MODEL_ID

export function isFreebuffModelId(
  id: string | null | undefined,
): id is FreebuffModelId {
  if (!id) return false
  return FREEBUFF_MODELS.some((m) => m.id === id)
}

export function resolveFreebuffModel(
  id: string | null | undefined,
): FreebuffModelId {
  return isFreebuffModelId(id) ? id : FALLBACK_FREEBUFF_MODEL_ID
}

export function getFreebuffModel(id: string): FreebuffModelOption {
  return (
    FREEBUFF_MODELS.find((m) => m.id === id) ??
    FREEBUFF_MODELS.find((m) => m.id === FALLBACK_FREEBUFF_MODEL_ID)!
  )
}

function getZonedParts(date: Date, timeZone: string): ZonedDateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value
  const year = Number(value('year') ?? 0)
  const month = Number(value('month') ?? 1)
  const day = Number(value('day') ?? 1)
  const hour = Number(value('hour') ?? 0)
  const minute = Number(value('minute') ?? 0)
  return {
    year,
    month,
    day,
    hour,
    minute,
  }
}

function addDaysToYmd(
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

function getUtcForZonedTime(
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

function getNextFreebuffDeploymentStart(now: Date): Date {
  const easternNow = getZonedParts(now, FREEBUFF_EASTERN_TIMEZONE)
  const isBeforeTodayOpen = easternNow.hour < 9

  const offset = isBeforeTodayOpen ? 0 : 1

  return getUtcForZonedTime(
    addDaysToYmd(easternNow.year, easternNow.month, easternNow.day, offset),
    FREEBUFF_EASTERN_TIMEZONE,
    9,
    0,
  )
}

function getCurrentFreebuffDeploymentEnd(now: Date): Date {
  const pacificNow = getZonedParts(now, FREEBUFF_PACIFIC_TIMEZONE)
  return getUtcForZonedTime(pacificNow, FREEBUFF_PACIFIC_TIMEZONE, 17, 0)
}

function isSameLocalDay(left: Date, right: Date, timeZone?: string): boolean {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return formatter.format(left) === formatter.format(right)
}

function formatLocalTime(
  date: Date,
  referenceNow: Date,
  options: LocalTimeFormatOptions = {},
): string {
  const shouldShowWeekday = !isSameLocalDay(
    date,
    referenceNow,
    options.timeZone,
  )
  return new Intl.DateTimeFormat(options.locale, {
    timeZone: options.timeZone,
    weekday: shouldShowWeekday ? 'short' : undefined,
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

export function getFreebuffDeploymentAvailabilityLabel(
  now: Date = new Date(),
  options: LocalTimeFormatOptions = {},
): string {
  if (isFreebuffDeploymentHours(now)) {
    const closesAt = getCurrentFreebuffDeploymentEnd(now)
    return `until ${formatLocalTime(closesAt, now, options)}`
  }

  const opensAt = getNextFreebuffDeploymentStart(now)
  return `opens ${formatLocalTime(opensAt, now, options)}`
}

export function isFreebuffDeploymentHours(now: Date = new Date()): boolean {
  const eastern = getZonedParts(now, FREEBUFF_EASTERN_TIMEZONE)
  const pacific = getZonedParts(now, FREEBUFF_PACIFIC_TIMEZONE)
  return (
    eastern.hour * 60 + eastern.minute >= 9 * 60 &&
    pacific.hour * 60 + pacific.minute < 17 * 60
  )
}

export function isFreebuffModelAvailable(
  id: string,
  now: Date = new Date(),
): boolean {
  const model = FREEBUFF_MODELS.find((m) => m.id === id)
  if (!model) return false
  return model.availability === 'always' || isFreebuffDeploymentHours(now)
}

export function resolveAvailableFreebuffModel(
  id: string | null | undefined,
  now: Date = new Date(),
): FreebuffModelId {
  const resolved = resolveFreebuffModel(id)
  return isFreebuffModelAvailable(resolved, now)
    ? resolved
    : FALLBACK_FREEBUFF_MODEL_ID
}
