import type { FreebuffRedditRetentionMilestoneDays } from '@codebuff/common/util/reddit-freebuff-retention'

export type RedditConversionSurface =
  | 'cli'
  | 'desktop'
  | 'web'
  | 'cloud'
  | 'chat'

export type RedditCapiEventName =
  | 'FirstPrompt'
  | 'Retention1d'
  | 'Retention7d'
  | 'Retention24d'

export const REDDIT_FIRST_PROMPT_EVENT = 'FirstPrompt' as const

export function redditRetentionCapiEventName(
  milestone: FreebuffRedditRetentionMilestoneDays,
): RedditCapiEventName {
  return `Retention${milestone}d`
}

/**
 * The day boundary D1/D7/D24 eligibility is computed in.
 *
 * Anything deciding "have we already done this user's tracking today?" MUST
 * use this same boundary. A memo keyed on a different day (Pacific, say) opens
 * a window where the UTC day has rolled over but the memo has not, and a
 * milestone claim can never be created in it — the conversion is lost, not
 * delayed. Do not reimplement.
 *
 * It lives in this dependency-free module rather than next to its consumer in
 * `packages/internal/src/reddit-conversions.ts`, because that module imports
 * `./db`, which constructs the application connection pool at module scope.
 * A pure date helper must not drag a database pool into everything that needs
 * a day key.
 */
export function utcDateKey(now: Date): string {
  return now.toISOString().slice(0, 10)
}
