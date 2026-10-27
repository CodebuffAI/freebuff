import type { ChangesScope, CloudChanges, FileDiffResult } from './changes'
import type { HostedBrowserScope } from './hosted-workspace'

/** Git reads are scoped to the native chat, with no renderer-supplied repository path. */
export type HostedGitRequest = HostedBrowserScope & (
  | { operation: 'changes'; scope: ChangesScope }
  | { operation: 'diff'; scope: ChangesScope; path: string; untracked: boolean }
)
export type HostedGitResponses = { changes: CloudChanges; diff: FileDiffResult }
export type HostedGitHost = {
  request<T extends HostedGitRequest>(input: T): Promise<HostedGitResponses[T['operation']]>
}
