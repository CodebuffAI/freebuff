/**
 * Hours: the unit users see for Freebucks (2026-10-14, product).
 *
 * One hour is 5 Freebucks, the price of an hour of MiMo v2.6 Flash Slow, the
 * cheapest metered row. Everything underneath stays in Freebucks: the ledger,
 * the prices, admission and refunds. Only display converts,
 * which is why a client released before this keeps showing Freebucks against
 * the same server: the wire still carries Freebucks.
 *
 * A model's price reads as a multiplier of that hour ("2x" is a 10 Freebuck
 * row: an hour on it uses two hours of balance). A free row carries no label;
 * a 1x row reads "1x" since 2026-10-17. Web and the hosted Desktop workspace
 * read the price in hours ("2 hrs") and usage as hours:minutes since
 * 2026-11-11 (`freebuffPriceHoursLabel`, `formatHoursClock`).
 */
export const FREEBUCKS_PER_HOUR = 5

/** The label every balance and allowance uses in place of "Freebucks". */
export const HOURS_LABEL = 'Hours'

/**
 * The one-line explanation of the relabel, for the tooltip or help text beside
 * a balance, an allowance or a price, so a user who knew Freebucks learns what
 * changed where they look. Every surface uses this exact sentence.
 */
export const HOURS_RELABEL_NOTE = `Balances now read in hours instead of Freebucks: 1 hour = ${FREEBUCKS_PER_HOUR} Freebucks, an hour on DeepSeek V4.1 Flash Slow. Nothing was taken from your balance, and a 3x model uses 3 hours per session hour.`

/** Freebucks as hours, unrounded. */
export function freebucksToHours(freebucks: number): number {
  return freebucks / FREEBUCKS_PER_HOUR
}

/**
 * Freebucks as an hour count for display: WHOLE hours, rounded down, so a
 * balance never reads as more than it buys and never shows a fraction of an
 * hour (product, 2026-10-15: "7.4 hours" confused people). Never negative.
 * `1,234` style grouping for large counts.
 */
export function formatHours(freebucks: number): string {
  return Math.floor(
    Math.max(0, freebucks) / FREEBUCKS_PER_HOUR + 1e-9,
  ).toLocaleString('en-US')
}

/** `formatHours` with its unit: "1 hour", "50 hours". */
export function formatHoursWithUnit(freebucks: number): string {
  const text = formatHours(freebucks)
  return `${text} ${text === '1' ? 'hour' : 'hours'}`
}

/** The short form for tight rows: "50 hrs", "1 hr". */
export function formatHoursShort(freebucks: number): string {
  const text = formatHours(freebucks)
  return `${text} ${text === '1' ? 'hr' : 'hrs'}`
}

/** Freebucks as whole minutes of balance, rounded down, never negative: one
 *  Freebuck is 12 minutes. */
export function freebucksToMinutes(freebucks: number): number {
  if (!Number.isFinite(freebucks)) return 0
  return Math.floor((Math.max(0, freebucks) * 60) / FREEBUCKS_PER_HOUR + 1e-9)
}

/** Minutes as hours:minutes, "2:40", "1,250:00". */
export function formatMinutesClock(minutes: number): string {
  const whole = Math.max(0, Math.floor(minutes))
  return `${Math.floor(whole / 60).toLocaleString('en-US')}:${String(whole % 60).padStart(2, '0')}`
}

/**
 * Freebucks as hours and minutes, "2:40" (product, 2026-11-11: usage reads as
 * time left, not a percentage). Rounded down to the minute, so a balance never
 * reads as more than it buys.
 */
export function formatHoursClock(freebucks: number): string {
  return formatMinutesClock(freebucksToMinutes(freebucks))
}

/**
 * A daily-style usage figure as hours:minutes: what is left, what is used and
 * the allowance, from the same rounded minutes so used + left = limit. The
 * remainder is rounded down (it never reads as more than it buys) and the
 * used part takes the rest.
 */
export function hoursClockUsage(usage: { limit: number; remaining: number }): {
  left: string
  used: string
  limit: string
} {
  const limit = freebucksToMinutes(usage.limit)
  const left = Math.min(limit, freebucksToMinutes(usage.remaining))
  return {
    left: formatMinutesClock(left),
    used: formatMinutesClock(limit - left),
    limit: formatMinutesClock(limit),
  }
}

/**
 * A model's price per session hour, in hours of balance (product, 2026-11-11,
 * in place of the multiplier): "3 hrs" for 15 Freebucks, "1 hr" for 5,
 * "0.4 hrs" for 2. Null for a free or unpriced row, which carries no label.
 */
export function freebuffPriceHoursLabel(
  priceFreebucks: number | null | undefined,
): string | null {
  if (
    priceFreebucks === null ||
    priceFreebucks === undefined ||
    !Number.isFinite(priceFreebucks) ||
    priceFreebucks <= 0
  )
    return null
  const hours = Math.round((priceFreebucks / FREEBUCKS_PER_HOUR) * 10) / 10
  const text = hours.toLocaleString('en-US', { maximumFractionDigits: 1 })
  return `${text} ${hours === 1 ? 'hr' : 'hrs'}`
}

/**
 * A model's usage multiplier label from its hourly price in Freebucks: "1x"
 * for 5 (MiMo v2.6 Flash Slow, labelled since 2026-10-17), "2x" for 10, "3x"
 * for 15, "0.4x" for 2. Null for a free row (the Unlimited section), which
 * carries no label, and for an unpriced one.
 */
export function freebuffModelMultiplierLabel(
  priceFreebucks: number | null | undefined,
): string | null {
  if (
    priceFreebucks === null ||
    priceFreebucks === undefined ||
    !Number.isFinite(priceFreebucks) ||
    priceFreebucks <= 0
  )
    return null
  const multiplier = Math.round((priceFreebucks / FREEBUCKS_PER_HOUR) * 10) / 10
  return `${multiplier.toLocaleString('en-US', { maximumFractionDigits: 1 })}x`
}

/**
 * How many one-hour sessions of a model the balance buys, for the hourglass's
 * tooltip at limited access (product, 2026-10-27): "2 one-hour sessions left".
 * Whole sessions, rounded down, never a fraction. Undefined for a free or
 * unpriced row, or an unknown balance.
 */
export function freebuffSessionsLeftLabel(
  balance: number | null | undefined,
  priceFreebucks: number | null | undefined,
): string | undefined {
  if (
    balance === null ||
    balance === undefined ||
    !Number.isFinite(balance) ||
    priceFreebucks === null ||
    priceFreebucks === undefined ||
    !(priceFreebucks > 0)
  )
    return undefined
  const sessions = Math.floor(Math.max(0, balance) / priceFreebucks + 1e-9)
  return `${sessions.toLocaleString('en-US')} one-hour ${sessions === 1 ? 'session' : 'sessions'} left`
}

/**
 * A price as multiplier text for sentences, where an empty label would leave
 * a hole: `freebuffModelMultiplierLabel`, else "1x" for a 1x row and "free"
 * for a free one.
 */
export function freebuffMultiplierText(priceFreebucks: number): string {
  return (
    freebuffModelMultiplierLabel(priceFreebucks) ??
    (priceFreebucks > 0 ? '1x' : 'free')
  )
}

/** Why a pool is smaller than the account's own when a device's accounts
 *  share one daily allowance: the server's `daily.note`, and what a client
 *  shows beside a `sharedDevice` refusal. */
export const FREEBUCKS_SHARED_DEVICE_NOTE =
  'The accounts on this device share one daily allowance.'

/**
 * The Freebucks meter's refusal (`freebucksShortfall`), as the one sentence
 * every client leads with. Admission needs a full hour of the chosen model, so
 * an account with hours left is refused a 3x row that a 1x row would still
 * start. The old wording led with "Today's hours come back in…", which read as
 * "you are out for the day" to someone with half a day's hours left (reported
 * 2026-10-25 as "used all my daily sessions").
 *
 * Suggests a lower multiplier only when the balance covers a 1x hour: below
 * that no cheaper metered row can start either, and the caller's reset and
 * plan copy is the answer.
 *
 * `sharedDevice`: the account has spent nothing to explain this, so the line
 * says whose allowance it was.
 */
export function freebucksShortfallLine(params: {
  price: number
  balance: number
  modelName?: string
  sharedDevice?: boolean
}): { line: string; cheaperModelFits: boolean } {
  const model = params.modelName ?? 'this model'
  const cheaperModelFits = params.balance >= FREEBUCKS_PER_HOUR
  if (params.sharedDevice) {
    return {
      line:
        `The accounts on this device share one daily allowance, and what's left today doesn't cover an hour of ${model}.` +
        (cheaperModelFits
          ? ' Pick a model with a lower multiplier to keep going.'
          : ''),
      cheaperModelFits,
    }
  }
  const left = cheaperModelFits
    ? `${formatHoursWithUnit(params.balance)} left`
    : 'less than an hour left'
  return {
    line:
      `An hour of ${model} uses ${formatHoursWithUnit(params.price)}, and you have ${left}.` +
      (cheaperModelFits
        ? ' Pick a model with a lower multiplier to keep going.'
        : ''),
    cheaperModelFits,
  }
}
