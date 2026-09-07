/**
 * One shared reading of a paid plan's state, so the CLI, Desktop and the web
 * usage dashboard describe the same subscription with the same words and the
 * same arithmetic. Each surface owns its own LAYOUT (a terminal line, a picker
 * footer, a panel), but which window is binding, what it is called, and which
 * reset instant applies are product facts — three copies of that logic is how
 * two surfaces end up naming different resets for the same refusal.
 */
import type {
  FreebuffFreeWindowsInfo,
  FreebuffSubscriptionInfo,
} from '../types/freebuff-session'

export interface FreebuffPlanWindow {
  /** 'today' | 'week' | 'month' — short, surface-agnostic label. */
  label: string
  used: number
  limit: number
}

export interface FreebuffPlanSummary {
  /** The tier's display name ("Starter"), falling back to the raw id. */
  tierName: string
  /** Day, week and month windows, in that order. */
  windows: FreebuffPlanWindow[]
  /**
   * Set when a limit is currently blocking, with the human name of THAT limit
   * and the instant it lifts (absent for the rolling 5-day window, which has
   * no single reset moment). `resetsAt` mirrors the server's rule that the
   * BINDING window is the one worth naming — see `resetAt` in the docs.
   */
  blocked?: { label: string; resetsAt?: string }
  /** ISO instant the daily window resets — the soonest recurring boundary. */
  dayResetAt: string
  /** ISO instant the billing period (monthly caps, spend cap) rolls. */
  periodEndsAt: string
  /** Month-to-date provider spend against the tier ceiling, USD. */
  spend: { usedUsd: number; limitUsd: number }
}

/** Session units, without trailing ".0" noise: 2, 0.5, 1.5. */
export function formatPlanUnits(units: number): string {
  if (!Number.isFinite(units)) return '0'
  const rounded = Math.round(units * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/** "today 1 of 2 · week 3 of 10 · month 11 of 30" — the compact one-liner. */
export function formatPlanWindows(summary: FreebuffPlanSummary): string {
  return summary.windows
    .map((w) => `${w.label} ${formatPlanUnits(w.used)} of ${w.limit}`)
    .join(' · ')
}

const BLOCKED_LABELS: Record<
  NonNullable<FreebuffSubscriptionInfo['blockedBy']>,
  string
> = {
  daily: "today's plan sessions are used",
  five_day: 'weekly limit reached',
  monthly: "this period's sessions are used",
  premium_daily: "today's premium sessions are used",
  monthly_spend: "this period's compute cap is reached",
}

/**
 * The plan summary for a live, usage-bearing subscription, or undefined when
 * there is nothing to summarise (no plan, or a server old enough to omit the
 * usage block). Callers render nothing on undefined — an empty plan line is
 * worse than no line.
 */
export function freebuffPlanSummary(
  info: FreebuffSubscriptionInfo | null | undefined,
): FreebuffPlanSummary | undefined {
  if (!info?.tierId) return undefined
  const usage = info.usage
  if (!usage) return undefined
  const tierName =
    info.tiers.find((tier) => tier.current)?.displayName ?? info.tierId

  const blocked = info.blockedBy
    ? {
        label: BLOCKED_LABELS[info.blockedBy],
        // The rolling weekly window frees capacity continuously, so naming one
        // instant would be wrong for it; everything else has a real boundary.
        ...(info.blockedBy === 'daily' || info.blockedBy === 'premium_daily'
          ? { resetsAt: usage.dayResetAt }
          : info.blockedBy === 'monthly' || info.blockedBy === 'monthly_spend'
            ? { resetsAt: usage.periodEndsAt }
            : {}),
      }
    : undefined

  return {
    tierName,
    windows: [
      { label: 'today', used: usage.dayUsed, limit: usage.dayLimit },
      // The wire field keeps its historical name; the WINDOW is 7 days.
      { label: 'week', used: usage.fiveDayUsed, limit: usage.fiveDayLimit },
      { label: 'month', used: usage.monthUsed, limit: usage.monthLimit },
    ],
    ...(blocked ? { blocked } : {}),
    dayResetAt: usage.dayResetAt,
    periodEndsAt: usage.periodEndsAt,
    spend: {
      usedUsd: usage.monthSpendUsd,
      limitUsd: usage.monthSpendLimitUsd,
    },
  }
}

/**
 * The free tier's three windows in the same shape as a plan's, so a free
 * user's line/rings and a subscriber's are the one layout with different
 * numbers. Undefined when the server sent no block (quota-exempt, limited
 * access, or an older server) — callers fall back to the daily ring alone.
 */
export function freebuffFreeWindowsSummary(
  info: FreebuffFreeWindowsInfo | null | undefined,
): Pick<FreebuffPlanSummary, 'windows' | 'dayResetAt'> | undefined {
  if (!info) return undefined
  return {
    windows: [
      { label: 'today', used: info.dayUsed, limit: info.dayLimit },
      { label: 'week', used: info.weekUsed, limit: info.weekLimit },
      { label: 'month', used: info.monthUsed, limit: info.monthLimit },
    ],
    dayResetAt: info.dayResetAt,
  }
}
