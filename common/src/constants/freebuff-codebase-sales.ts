/** Commercial contribution is separate from GitHub access and evaluation capture. */
export type CodebaseSalesOffer = {
  repoId: string
  repoFullName: string
  commitSha: string
  /** Complete advertised branch/tag map, fixed when the offer was displayed. */
  refsHash: string
  termsVersion: string
  termsHash: string
  terms: string
  termsUrl: string | null
  compensation: { summary: string }
}

export type CodebaseSalesSubmission = {
  id: string
  repoId: string
  repoFullName: string
  commitSha: string
  status: string
  statusLabel: string
  createdAt: string
  updatedAt: string
  firstSaleRewardFreebucks: number | null
}
export type CodebaseSalesProject = {
  repoId: string
  repoFullName: string
  canOptIn: boolean
  statusLabel: string
  popupSnoozedUntil: string | null
  latestSubmission?: CodebaseSalesSubmission
}

export type CodebaseSalesState = {
  availability: 'unavailable' | 'connect_required' | 'available' | 'suppressed'
  reason?: string
  offer?: CodebaseSalesOffer
  submissions: CodebaseSalesSubmission[]
  projects?: CodebaseSalesProject[]
  projectsPage?: { nextCursor: string | null; complete: boolean }
}

export type CodebaseSalesRequest =
  | {
      action: 'accept'
      repoId: string
      repoFullName: string
      commitSha: string
      refsHash: string
      termsVersion: string
      termsHash: string
      accepted: true
      requestKey: string
    }
  | {
      action: 'dismiss'
      repoId: string
      repoFullName: string
      termsVersion: string
    }
  | { action: 'withdraw'; submissionId: string }

export type CodebaseSalesResponse =
  | { ok: true; submission?: CodebaseSalesSubmission }
  | { ok: false; error: string }

/** A renderable offer always contains the exact snapshot and finalized terms. */
export function isCodebaseSalesOffer(
  value: unknown,
): value is CodebaseSalesOffer {
  if (!value || typeof value !== 'object') return false
  const offer = value as Partial<CodebaseSalesOffer>
  return (
    typeof offer.repoId === 'string' &&
    /^\d+$/.test(offer.repoId) &&
    typeof offer.repoFullName === 'string' &&
    /^[\w.-]+\/[\w.-]+$/.test(offer.repoFullName) &&
    typeof offer.commitSha === 'string' &&
    /^[0-9a-f]{40}$/.test(offer.commitSha) &&
    typeof offer.refsHash === 'string' &&
    /^[0-9a-f]{64}$/.test(offer.refsHash) &&
    typeof offer.termsVersion === 'string' &&
    offer.termsVersion.length > 0 &&
    typeof offer.termsHash === 'string' &&
    /^[0-9a-f]{64}$/.test(offer.termsHash) &&
    typeof offer.terms === 'string' &&
    offer.terms.trim().length > 0 &&
    (offer.termsUrl === null ||
      (typeof offer.termsUrl === 'string' &&
        /^https:\/\//.test(offer.termsUrl))) &&
    typeof offer.compensation?.summary === 'string' &&
    offer.compensation.summary.trim().length > 0
  )
}

/** Published body is also frozen into each repository's acceptance record. */
export const CODEBASE_CONTRIBUTION_TERMS_VERSION = '2026-10-30-v1'
export const CODEBASE_CONTRIBUTION_TERMS_URL =
  'https://freebuff.com/repository-contribution-terms'
export const CODEBASE_CONTRIBUTION_TERMS_PARAGRAPHS = [
  'You confirm you own or are authorized to contribute the selected repository, its submitted source and reachable Git history, and the included issues and pull requests. Do not contribute secrets, personal data or material you cannot authorize.',
  'You give Freebuff a nonexclusive license to copy, prepare and license this contribution to partners for commercial AI training and evaluation. You keep ownership. A contribution does not guarantee selection or a sale.',
  'If your contribution is included in a first completed paid license, Freebuff will determine and settle a one-time reward manually, of up to 2,000 hours of usage. There is no fixed percentage or currency conversion. Later licenses do not create additional rewards. A reversed or refunded sale is not a completed paid license.',
  "Freebuff may retain and offer the contribution for up to one year after acceptance. You may withdraw before then to stop new licensing and request removal of Freebuff's stored contribution copies. Existing partner licenses and limited consent/payment audit records survive withdrawal; previously licensed data cannot be recalled from partners.",
  'The acceptance record preserves the displayed terms and exact repository snapshot. Collection and preparation run in the background. New snapshots require their own recorded scope; accepting does not authorize automatic ongoing capture.',
] as const
export const CODEBASE_CONTRIBUTION_TERMS_TEXT =
  CODEBASE_CONTRIBUTION_TERMS_PARAGRAPHS.join('\n\n')
