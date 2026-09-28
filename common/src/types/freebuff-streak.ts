export interface FreebuffStreakResponse {
  streak: number
  todayUsed: boolean
  lastUsageDate: string | null
  timeZone: string
  /**
   * Freebucks a day of a 7+ day streak credits to this account's wallet, or
   * null when the account is not on the Freebucks meter and the streak still
   * pays sessions. Absent from older servers, which clients read as null.
   * Server-set so the copy a client draws matches what the ledger will do.
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
   * Whether today's Freebucks streak bonus is already in the wallet (the
   * ledger credit `streak_bonus:<today>` exists). The bonus is credited with
   * the first free-mode message of a streak day, not at sign-in. Null when the
   * account is off the meter or the lookup failed; absent from older servers.
   */
  todayCredited?: boolean | null
}
