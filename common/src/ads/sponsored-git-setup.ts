/**
 * The local, pre-paid Git setup handshake used by sponsored Desktop work.
 *
 * These are deliberately plain data contracts: the Desktop process owns the
 * filesystem and Git commands, while clients only render these local paths and
 * send an explicit review selection back for approval.
 */

export type SponsoredGitInspection =
  | { status: 'git_root'; canonicalRoot: string; canInitialize: false }
  | {
      status: 'enclosing_repository'
      canonicalRoot: string
      enclosingRoot: string
      canInitialize: false
    }
  | { status: 'no_repository'; canonicalRoot: string; canInitialize: true }
  | { status: 'unborn_repository'; canonicalRoot: string; canInitialize: true }
  | { status: 'git_unavailable'; canInitialize: false }
  | { status: 'broken_repository'; canonicalRoot: string; canInitialize: false }
  | {
      status: 'permission_denied'
      canonicalRoot?: string
      canInitialize: false
    }
  | { status: 'timed_out'; canonicalRoot?: string; canInitialize: false }
  | { status: 'too_many_files'; canonicalRoot: string; canInitialize: false }
  | { status: 'unsafe_path'; canonicalRoot?: string; canInitialize: false }

export type SponsoredGitSetupFileExclusion =
  | 'secret_or_env'
  | 'generated'
  | 'dependency'
  | 'git_metadata'
  | 'freebuff_metadata'
  | 'ignored'
  | 'symlink'
  | 'unsupported'
  | 'too_large'

/** A relative, locally renderable path. Content is never returned by this contract. */
export type SponsoredGitSetupFile = {
  path: string
  bytes: number
  digest?: string
  executable?: boolean
  selectable: boolean
  exclusion?: SponsoredGitSetupFileExclusion
}

export type SponsoredGitSetupPreview =
  | {
      status: 'ready'
      inspection: Extract<
        SponsoredGitInspection,
        { status: 'no_repository' | 'unborn_repository' }
      >
      token: string
      expiresAt: number
      canonicalRoot: string
      files: SponsoredGitSetupFile[]
    }
  | { status: 'not_needed'; inspection: SponsoredGitInspection }
  | { status: 'unavailable'; inspection: SponsoredGitInspection }

export type SponsoredGitSetupIdentity = { name: string; email: string }

export type SponsoredGitSetupApproval =
  | {
      status: 'initialized'
      canonicalRoot: string
      committedFiles: string[]
      commit: string
    }
  | {
      status:
        | 'stale_preview'
        | 'identity_required'
        | 'invalid_selection'
        | 'unavailable'
      inspection: SponsoredGitInspection
    }
