import type { ChangesScope, CloudChanges, FileDiffResult } from './changes'
import type { HostedBrowserScope } from './hosted-workspace'
import type { PullRequestStatus } from './pull-request'

/**
 * Where a chat's changes live and where they go: its branch, what "branch changes" compare
 * against, and its pull request. `live` asks Desktop to refresh the PR (one cached `gh` read);
 * without it the answer is what Desktop already saved, which the sidebar reads for every row.
 * Desktop builds before 2026-11 reject the operation; callers treat that as "nothing known".
 */
export interface GitSummary {
  branch: string | null
  /** The branch "Branch changes" diff against; null when the chat has none (a shared checkout). */
  base: string | null
  worktree: boolean
  pullRequest: PullRequestStatus | null
  /** The open PR no longer merges cleanly. */
  conflict: boolean
  /**
   * Where this chat's PR would be on github.com: its `origin` and the branch it owns. Lets the
   * browser read the PR with the account's GitHub connection when `gh` cannot answer (not installed,
   * signed out, another account). Null for a shared checkout; absent from Desktop before 2026-11.
   */
  github?: { repository: string; branch: string } | null
}

/** Git reads are scoped to the native chat, with no renderer-supplied repository path. */
export type HostedGitRequest = HostedBrowserScope & (
  | { operation: 'changes'; scope: ChangesScope }
  | { operation: 'diff'; scope: ChangesScope; path: string; untracked: boolean }
  | { operation: 'summary'; live: boolean }
)
export type HostedGitResponses = { changes: CloudChanges; diff: FileDiffResult; summary: GitSummary }
export type HostedGitHost = {
  request<T extends HostedGitRequest>(input: T): Promise<HostedGitResponses[T['operation']]>
}
