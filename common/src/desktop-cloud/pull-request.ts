export type PullRequestChecks = 'pending' | 'passed' | 'failed' | 'none' | 'unknown'

export interface PullRequestStatus {
  url: string
  number: number
  title: string
  state: 'open' | 'merged' | 'closed'
  draft: boolean
  checks: PullRequestChecks
}

export interface PullRequestSnapshot {
  pullRequest: PullRequestStatus | null
  unavailable?: boolean
}

/** GitHub combines CheckRun and StatusContext entries in statusCheckRollup. */
export function normalizePullRequestChecks(value: unknown): PullRequestChecks {
  if (!Array.isArray(value)) return 'unknown'
  if (!value.length) return 'none'
  const states = value.map((item): PullRequestChecks => {
    if (!item || typeof item !== 'object') return 'unknown'
    const check = item as Record<string, unknown>
    const status = typeof check.status === 'string' ? check.status.toUpperCase() : null
    const raw = check.state ?? (status === 'COMPLETED' ? check.conclusion : status)
    const state = typeof raw === 'string' ? raw.toUpperCase() : null
    if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(String(state))) return 'failed'
    if (['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'PENDING_DEPLOYMENT'].includes(String(state))) return 'pending'
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(String(state))) return 'passed'
    return 'unknown'
  })
  return states.includes('failed') ? 'failed'
    : states.includes('pending') ? 'pending'
    : states.includes('unknown') ? 'unknown'
    : 'passed'
}
