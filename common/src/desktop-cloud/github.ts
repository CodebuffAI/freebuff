/** Public metadata only. GitHub credentials never cross the Cloud API boundary. */
export type GitHubRepository = {
  id: number
  fullName: string
  defaultBranch: string
  private: boolean
}
export type GitHubSource = GitHubRepository & { installationId: number }
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
