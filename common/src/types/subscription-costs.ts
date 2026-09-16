/** Cost measures for one currently paid subscriber or an aggregate thereof. */
export interface SubscriptionCostMetrics {
  /** Net provider dollars funded by Freebuff, including paid overage. */
  totalCostUsd: number | null
  /** Known lower bound of the portion funded by the subscription. */
  subscriptionCostUsd: number | null
  /** Provider dollars whose funding source could not be attributed. */
  unattributedCostUsd: number | null
  /** Total cost divided by the current paid population. */
  averageCostUsd: number | null
  /** Estimated total provider cost for the next fixed 30-day horizon. */
  totalForecastCost30dUsd: number | null
  /** Estimated subscription-funded provider cost for the next 30 days. */
  subscriptionForecastCost30dUsd: number | null
  /** Subscribers that cannot be estimated from their tier's observed usage. */
  forecastUnestimatedSubscribers: number
  /** Newer subscribers estimated from established users in their tier. */
  forecastTierEstimatedSubscribers: number
  /** False when any provider cost in the window lacks funding attribution. */
  attributionComplete: boolean
}

/** Recent, completed-hour cost report for the paid subscriber cohort. */
export interface SubscriptionCostReport {
  status: 'collecting' | 'ready' | 'unavailable'
  /**
   * Method behind the existing USD forecasts. It remains a daily run-rate
   * extrapolation until a retained admission-to-provider-cost grain supports
   * an allowance-constrained estimate.
   */
  forecastMethod?: 'uncapped_daily_run_rate'
  /**
   * Whether an additional Freebucks-allowance-constrained USD estimate is
   * available. It is separate from the run-rate forecast above.
   */
  allowanceForecastStatus?: 'unavailable'
  /** Why the allowance-constrained forecast is unavailable. */
  allowanceForecastReason?: 'missing_funding_cost_basis'
  /**
   * Freshness of the newest completed cost-rollup hour. This is deliberately
   * independent from `status`: a report can be `collecting` while the
   * collector is current but has not yet completed a full forecast day.
   */
  coverageStatus?: 'current' | 'missing' | 'stale'
  /**
   * Newest completed hour attested by the expanded-cost collector, even when
   * it is too old to use for measured costs. Null means no attested hour.
   */
  latestCoveredHour?: string | null
  windowStart: string | null
  windowEnd: string | null
  /** Completed covered hours, including partial UTC days. */
  observedHours?: number
  completeDays: number
  /** Complete-day basis for forecasts, separate from recent measured hours. */
  forecastObservationStart?: string | null
  forecastObservationEnd?: string | null
  forecastStart: string
  forecastEnd: string
  forecastDays: 30
  asOf: string
  users: Record<string, SubscriptionCostMetrics>
  tiers: Array<SubscriptionCostMetrics & { tier: string; subscribers: number }>
  totals: SubscriptionCostMetrics & { subscribers: number }
}

/**
 * Last known subscription-cost report, returned independently from the
 * subscriber-list scan so an interrupted collector never erases useful data.
 */
export interface SubscriptionCostSnapshot {
  costs: SubscriptionCostReport | null
  savedAt: string | null
  snapshotStatus: 'fresh' | 'stale' | 'empty'
  refreshStatus: 'idle' | 'running' | 'cooldown' | 'failed' | 'unavailable'
  nextRefreshAt: string | null
}
