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
/** An account or organization a new repository can be created under. */
export type GitHubOwner = { login: string; organization: boolean }
export type GitHubOwners = {
  /** The connected GitHub account. */
  login: string
  /** Accounts where the Freebuff GitHub App is installed with write access; the user's own first. */
  owners: GitHubOwner[]
  /** Where the user installs the app on another account. */
  installUrl: string
}
export type GitHubNewRepository = {
  owner: string
  name: string
  private: boolean
}
/** Connect an existing Cloud project to an empty repository by pushing one chat's files. */
export type GitHubProjectConnection = {
  workspaceId: string
  repositoryId: number
  fullName: string
}
export type GitHubProjectConnected = {
  project: { id: string; name: string; github: GitHubRepository }
  url: string
}
/** A GitHub-linked chat's files, committed and pushed to its own branch without a turn. */
export type GitHubChatPushed = {
  repository: string
  branch: string
  commit: string
  /** The branch on github.com, where GitHub offers to open a pull request. */
  url: string
}
/** Committing and pushing a chat's files, after any VM restore. */
export const GITHUB_CONNECT_PUSH_MS = 10 * 60_000
export const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
export const GITHUB_REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/
export function validGitHubRepositoryName(value: string): boolean {
  return (
    GITHUB_REPOSITORY_NAME_PATTERN.test(value) &&
    value !== '.' &&
    value !== '..' &&
    !value.toLowerCase().endsWith('.git')
  )
}
/** A repository name GitHub accepts, from a project name: `My App!` → `My-App`. */
export function suggestGitHubRepositoryName(projectName: string): string {
  const name = projectName
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100)
    .replace(/[-.]+$/g, '')
  return validGitHubRepositoryName(name) ? name : 'my-project'
}
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
