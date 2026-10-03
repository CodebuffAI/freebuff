/**
 * Calculates the next quota reset date.
 * If the current reset date is in the past or null, it calculates the next
 * reset date based on the current date. Otherwise, it ensures the next
 * reset date is in the future relative to the provided date.
 *
 * @param referenceDate The user's current `next_quota_reset` date, or the date the cycle ended.
 * @returns The Date object representing the next reset time.
 */
export const getNextQuotaReset = (referenceDate: Date | null): Date => {
  const now = new Date()
  let nextMonth = new Date(referenceDate ?? now)
  while (nextMonth <= now) {
    nextMonth.setMonth(nextMonth.getMonth() + 1)
  }
  return nextMonth
}

export interface FormatTimeUntilOptions {
  /**
   * What to return when the date is in the past or invalid.
   * @default 'now'
   */
  fallback?: string
  /**
   * Whether to include the smaller unit (hours in "Xd Yh", minutes in "Xh Ym").
   * @default true
   */
  includeSubUnit?: boolean
}

/**
 * Format the time until a future date in a human-readable string.
 *
 * @param date - The target date (Date object or ISO string)
 * @param options - Formatting options
 * @returns Human-readable string like "4d 7h", "2h 30m", or "45m"
 *
 * @example
 * // Date 2 days and 5 hours in the future
 * formatTimeUntil(futureDate)  // "2d 5h"
 * formatTimeUntil(futureDate, { includeSubUnit: false })  // "2d"
 *
 * // Date 3 hours and 20 minutes in the future
 * formatTimeUntil(futureDate)  // "3h 20m"
 *
 * // Date in the past
 * formatTimeUntil(pastDate)  // "now"
 * formatTimeUntil(pastDate, { fallback: '0h' })  // "0h"
 */
export const formatTimeUntil = (
  date: Date | string | null,
  options: FormatTimeUntilOptions = {},
): string => {
  const { fallback = 'now', includeSubUnit = true } = options

  if (!date) return fallback

  const target = typeof date === 'string' ? new Date(date) : date
  const diffMs = target.getTime() - Date.now()

  if (Number.isNaN(diffMs) || diffMs <= 0) return fallback

  const diffMins = Math.floor(diffMs / (1000 * 60))
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)
  const remainingHours = diffHours % 24
  const remainingMins = diffMins % 60

  if (diffDays > 0) {
    return includeSubUnit && remainingHours > 0
      ? `${diffDays}d ${remainingHours}h`
      : `${diffDays}d`
  }
  if (diffHours > 0) {
    return includeSubUnit && remainingMins > 0
      ? `${diffHours}h ${remainingMins}m`
      : `${diffHours}h`
  }
  return `${diffMins}m`
}
