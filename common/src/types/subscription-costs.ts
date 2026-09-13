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
