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
}
