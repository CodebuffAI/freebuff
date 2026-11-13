export interface FreebuffStreakResponse {
  streak: number
  todayUsed: boolean
  /** Latest Pacific usage date (`YYYY-MM-DD`), for history copy. */
  lastUsageDate: string | null
  /**
   * The account's daily reset timezone, whose days the streak counts (since
   * 2026-10-01; Pacific before, and still Pacific for an account whose
   * devices have not reported one).
   */
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
   * When the current streak day ends and the next one (and its +15) begins,
   * as an ISO instant: the daily allowance's reset, normally the next
   * midnight in `timeZone`. Since 2026-10-01 the streak day IS the allowance
   * day, so this is the reader's own midnight at home; before, it was the
   * next Pacific midnight (3 PM in Singapore). Clients render it in the
   * reader's zone. Absent from older servers.
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
   * (midnight in the account's reset timezone), as an ISO instant — since
   * 2026-10-01 always equal to `nextResetAt`. Null when that reset has
   * already passed and the bonus is gone (older servers, whose streak day was
   * Pacific). Absent when nothing was granted, and from older servers.
   */
  bonusExpiresAt?: string | null
  /**
   * The days the account was active in the last
   * `FREEBUFF_STREAK_ACTIVITY_WINDOW_DAYS`, as days before today (0 is today),
   * ascending: the activity grid a client draws beside the count. It reaches
   * back past the current run, so a streak that broke still shows where it
   * was. Absent from older servers; a client then draws the current run alone.
   */
  activeDaysAgo?: number[]
  /**
   * Whether the account has ever reached a 7-day streak, which unlocks the
   * Streak Fire theme for good (`STREAK_THEME_PRESET_ID`). Absent from older
   * servers, which clients read as false.
   */
  streakThemeUnlocked?: boolean
  /**
   * Which streak UI to draw, set by freebuff.com's `/api/web/streak` for the
   * `classic` arm of `streak_ui_2026_11` (a split of the display
   * experiment's control): the seven-day flames the activity grid replaced.
   * Absent means the grid. Web and Desktop only.
   */
  ui?: 'classic'
}
