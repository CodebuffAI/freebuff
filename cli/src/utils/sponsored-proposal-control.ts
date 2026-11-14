import {
  dismissSponsoredProposal,
  reportSponsoredProposal,
  setSponsoredProposalPrefs,
} from './sponsored-proposal-api'
import {
  AdReportReasonSchema,
  type AdReport,
} from '@codebuff/common/ads/ad-report'
import { reportAd } from './ad-report'
import { getAuthToken } from './auth'

export type SponsoredProposalControl =
  | 'dismiss'
  | 'report'
  | 'never-advertiser'
  | 'opt-out'

/**
 * The transport calls a control makes, injected so the ordering below can be
 * tested without a network (docs/testing.md: DI over module mocking).
 */
export interface SponsoredProposalControlDeps {
  getToken: () => string | null | undefined
  notify: (ad: AdReport, authToken: string) => Promise<void>
  report: typeof reportSponsoredProposal
  dismiss: typeof dismissSponsoredProposal
  setPrefs: typeof setSponsoredProposalPrefs
}

const DEFAULT_DEPS: SponsoredProposalControlDeps = {
  getToken: getAuthToken,
  notify: reportAd,
  report: reportSponsoredProposal,
  dismiss: dismissSponsoredProposal,
  setPrefs: setSponsoredProposalPrefs,
}

/**
 * Run one of the card's controls, and answer whether it actually landed
 * (COD-376).
 *
 * TWO RULES, and both are about a failure that used to look like a success.
 *
 * PREFERENCE FIRST, THEN THE DISMISS -- and the preference's RESULT decides
 * whether the dismiss happens at all. The ordering was already here; the
 * result was awaited and thrown away, so a failed preference write was
 * followed by a dismiss that succeeded. That produces the exact combination
 * the ordering exists to prevent: the card gone, the refusal never recorded,
 * and the same advertiser back on the next offer -- with the user believing
 * they had said no.
 *
 * FALSE MEANS NOTHING WAS SAVED, and the caller must leave the card live. The
 * caller used to mark the block `answered` in a `finally`, which stands its
 * controls down permanently: a failed control left a card that looked spent,
 * could not be retried, and had saved nothing.
 *
 * A partial (`never-advertiser` whose preference saved but whose dismiss
 * failed) reports FALSE. The preference is the durable half and it is safe to
 * repeat, so the honest answer is "try again" rather than a success the card
 * cannot demonstrate.
 */
export async function runSponsoredProposalControl(
  control: SponsoredProposalControl,
  proposal: {
    proposalId: string
    advertiserId: string
    reportSnapshot?: AdReport
  },
  authToken: string,
  deps: SponsoredProposalControlDeps = DEFAULT_DEPS,
): Promise<boolean> {
  const { proposalId, advertiserId } = proposal
  if (control === 'report') {
    if (deps.getToken() !== authToken) return false
    // Keep the existing dismissal semantics, but only after notifications land.
    try {
      const reason = AdReportReasonSchema.parse(proposal.reportSnapshot?.reason)
      await deps.notify(
        {
          ...(proposal.reportSnapshot ?? {
            title: 'Sponsored task offer',
            provider: 'first_party',
            surface: 'cli',
            placementId: 'sponsored-proposal',
            proposalId,
          }),
          reason,
        },
        authToken,
      )
    } catch {
      return false
    }
    if (deps.getToken() !== authToken) return false
    return deps.report(proposalId, authToken)
  }
  if (control === 'dismiss') {
    return deps.dismiss(proposalId, authToken)
  }
  const saved = await deps.setPrefs(
    control === 'never-advertiser'
      ? { neverAdvertiserId: advertiserId }
      : { optedOut: true },
    authToken,
  )
  if (!saved) return false
  return deps.dismiss(proposalId, authToken)
}
