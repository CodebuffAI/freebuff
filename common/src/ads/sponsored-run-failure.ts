import {
  parseSponsoredRunEvidence,
  type SponsoredBlockerCategory,
} from './sponsored-run-evidence'
import { scrubSponsoredDiagnostic } from './sponsored-run-funnel-builder'

export const SPONSORED_BLOCKER_LABELS: Record<
  SponsoredBlockerCategory,
  string
> = {
  scope_check: 'Changes outside the allowed scope failed verification',
  needs_api_key: 'An API key is still required',
  needs_login: 'Account connection or approval is still required',
  command_failed: 'A verification command failed',
  verification_failed: 'A verification check failed',
}

export type SponsoredFailureFriction = {
  blocking: boolean
  category: string
  detail?: string | null
  step?: number | null
}

/** Historical scope reports have no check id. Interpret the category, never publish their text. */
export function sponsoredFrictionBlocker(
  report: SponsoredFailureFriction,
): SponsoredBlockerCategory | undefined {
  if (!report.blocking) return undefined
  if (
    /scope check|scope-check|file-scope|in-scope.files|out-of-scope/i.test(
      report.detail ?? '',
    )
  )
    return 'scope_check'
  if (report.category === 'needs_api_key') return 'needs_api_key'
  if (
    report.category === 'needs_login' ||
    report.category === 'needs_human_action'
  )
    return 'needs_login'
  if (report.category === 'command_failed') return 'command_failed'
  return undefined
}

/** Never infer that the user deliberately cancelled from a generic closed/interrupted event. */
export function sponsoredFailureExplanation(input: {
  metadata: Record<string, unknown> | null
  friction?: readonly SponsoredFailureFriction[]
  assessedCause?: string | null
}): { label: string; detail: string } {
  const m = input.metadata ?? {}
  const evidence = parseSponsoredRunEvidence(m.run_evidence)
  const diagnostic =
    typeof m.diagnostic_reason === 'string' ? m.diagnostic_reason : ''
  const code = typeof m.failure_code === 'string' ? m.failure_code : ''
  const text = diagnostic.toLowerCase()
  const ending = evidence?.ending
  let ended: string
  if (ending === 'runner_restarted' || text.includes('cloud runner restarted'))
    ended = 'The Cloud runner restarted.'
  else if (text.includes('app-quit') || code.includes('app_quit'))
    ended = 'The app quit.'
  else if (text.includes('provider failed'))
    ended = 'The model provider failed.'
  else if (
    /enotfound|econnreset|econnrefused|network request failed|fetch failed|connection timed out|no data was received/.test(
      text,
    )
  )
    ended = 'The run encountered a network error.'
  else if (
    ending === 'grant_expired' ||
    code === 'grant_expired' ||
    text.startsWith('turn grant-expired')
  )
    ended = 'The compute grant expired.'
  else if (code === 'timed_out')
    ended = 'The run stopped reporting and was marked timed out.'
  else if (ending === 'closed' || text.startsWith('turn closed'))
    ended = 'The session closed.'
  else if (ending === 'stopped' || text.startsWith('turn stopped'))
    ended = 'The run was stopped.'
  else if (ending === 'interrupted' || text.startsWith('turn interrupted'))
    ended = 'The run was interrupted; the initiator was not recorded.'
  else if (ending === 'completed' || text.startsWith('turn completed')) {
    ended =
      code === 'no_edits'
        ? 'The agent turn completed without recorded file edits.'
        : code === 'partial_edits'
          ? 'The agent turn completed, but verification did not pass.'
          : 'The agent turn completed, but delivery could not be verified.'
  } else {
    const legacy = m.failure_reason ?? m.reason
    const reason = diagnostic || (typeof legacy === 'string' ? legacy : '')
    ended =
      scrubSponsoredDiagnostic(reason) ??
      'The run failed; no specific reason was recorded.'
  }
  if (evidence?.verificationPending) {
    return {
      label: 'Verification incomplete',
      detail: `Implementation finished, but user verification is incomplete.${ending === 'completed' ? '' : ` ${ended}`}`,
    }
  }
  const blockers: string[] = []
  const categories = new Set<SponsoredBlockerCategory>()
  for (const check of evidence?.checks ?? []) {
    categories.add(check.category)
    blockers.push(
      `${check.step === 0 ? 'Preflight' : `Step ${check.step}`} (${check.checkId}): ${SPONSORED_BLOCKER_LABELS[check.category]}.`,
    )
  }
  // Structured checks are authoritative where present. Old friction is supporting evidence.
  for (const report of evidence?.checksRecorded ? [] : (input.friction ?? [])) {
    const category = sponsoredFrictionBlocker(report)
    if (!category || categories.has(category)) continue
    categories.add(category)
    blockers.push(`Agent reported: ${SPONSORED_BLOCKER_LABELS[category]}.`)
  }
  if (
    !evidence?.checksRecorded &&
    !categories.size &&
    (input.assessedCause === 'needs_api_key' ||
      input.assessedCause === 'needs_login' ||
      input.assessedCause === 'needs_human_action')
  ) {
    blockers.push(
      `Run assessment: ${SPONSORED_BLOCKER_LABELS[input.assessedCause === 'needs_api_key' ? 'needs_api_key' : 'needs_login']}.`,
    )
  }
  return {
    label:
      categories.has('scope_check') ||
      (code === 'partial_edits' &&
        (ending === 'completed' || text.startsWith('turn completed')))
        ? 'Verification failed'
        : 'Run failed',
    detail: [
      ended,
      ...blockers,
      ...(evidence?.truncated
        ? ['Additional failed checks were omitted.']
        : []),
    ]
      .join('\n')
      .slice(0, 2_000),
  }
}
