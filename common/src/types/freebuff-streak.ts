export interface FreebuffStreakResponse {
  streak: number
  todayUsed: boolean
  lastUsageDate: string | null
  timeZone: string
  /**
   * Freebucks a day of a 7+ day streak adds to this account's daily allowance
   * (never the wallet; it expires at the allowance's reset), or null when the
   * account is not on the Freebucks meter and the streak still pays sessions.
   * Absent from older servers, which clients read as null. Server-set so the
   * copy a client draws matches what the meter will do.
   */
  freebucksDailyBonus?: number | null
  /**
   * When the current streak day ends, as an ISO instant: the next midnight in
   * `timeZone` (Pacific). Clients render it in the USER's zone — a streak day
   * that silently ends at 3 PM in Singapore is what made people report the
   * bonus as missing. Absent from older servers.
   */
  nextResetAt?: string
  /**
   * Whether today's streak bonus has been added to the daily allowance. It is
   * granted with the first free-mode message of a streak day, not at sign-in.
   * Null when the account is off the meter or the lookup failed; absent from
   * older servers (which meant "in the wallet").
   */
  todayCredited?: boolean | null
  /**
   * When today's granted bonus leaves the allowance: the allowance's own reset
   * (midnight in the account's reset timezone), as an ISO instant. Null when
   * that reset has already passed and the bonus is gone. Absent when nothing
   * was granted, and from older servers.
   */
  bonusExpiresAt?: string | null
}
