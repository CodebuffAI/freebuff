/** File changes returned by the Cloud worktree and local Desktop Git readers. */
export type ChangesScope = 'all' | 'uncommitted'
export interface ChangedFile {
  path: string
  status: 'added' | 'modified' | 'deleted'
  modifiedAt: number | null
  adds: number | null
  dels: number | null
  binary: boolean
  untracked: boolean
}
export interface FileDiffResult {
  patch?: string
  binary?: boolean
  tooLarge?: boolean
}
export interface CloudChanges {
  scope: ChangesScope
  branch: string | null
  files: ChangedFile[]
  totals: { files: number; adds: number; dels: number }
}
