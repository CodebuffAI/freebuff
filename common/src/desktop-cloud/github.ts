/** Public metadata only. GitHub credentials never cross the Cloud API boundary. */
export type GitHubRepository = {
  id: number
  fullName: string
  defaultBranch: string
  private: boolean
}
export type GitHubSource = GitHubRepository & { installationId: number; publicReadOnly?: true }
/** Most locally deleted paths a local-project cloud chat carries; more starts
 * the chat from its uploaded files alone. */
export const CLOUD_LOCAL_GITHUB_DELETED_MAX = 10_000
/** A Desktop local project's GitHub origin, sent with its first cloud run.
 * The server uses it only if the user's GitHub connection can push there. */
export type CloudLocalGitHub = {
  fullName: string
  /** Push target: the upstream branch, else the local one; absent when detached. */
  branch?: string
  /** A commit GitHub has: local HEAD once pushed, else where it forked. */
  commit: string
  /** Files tracked at `commit` that the uploaded folder no longer has. */
  deleted: string[]
}
export type GitHubProjectSelection = {
  repositoryId: number
  fullName: string
  branch: string
}
export type GitHubBranches = {
  repository: GitHubRepository
  branches: string[]
}
export type GitHubStatus = {
  configured: boolean
  connected: boolean
  login?: string
}
/** Freebuff web page that finishes a GitHub connection for the signed-in
 * account; the Cloud API's GitHub callback relays the OAuth code to it. */
export const GITHUB_CONNECT_COMPLETE_PATH = '/cloud/github/callback'
export type GitHubPickerClient = {
  status(): Promise<GitHubStatus>
  authorize(): Promise<{ url: string }>
  repositories(): Promise<{ repositories: GitHubRepository[] }>
  branches(repository: GitHubRepository): Promise<GitHubBranches>
}

/** A branch name, not a revision expression or shell fragment. */
export function validGitHubBranch(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 200 &&
    !/^[.-]|[\s~^:?*\[\\\x00-\x1f\x7f]|\.\.|@\{|\/\/|[/.]$/.test(value) &&
    value !== '@' &&
    !value.startsWith('/') &&
    value
      .split('/')
      .every((part) => !part.startsWith('.') && !part.endsWith('.lock'))
  )
}
