import { sanitizeAdUrl } from '../util/ad-creative-safety'

/**
 * Sponsored proposals — the channel logic, with no surface attached.
 *
 * A proposal is a decision made elsewhere (the async decision path); a surface
 * only renders the record and forwards the user's answer. Everything about
 * WHICH answer is on offer, what it is called, and which of the row's fields
 * are safe to act on is channel logic, not layout — so it lives here rather
 * than inside the web card that happens to be the only surface today.
 *
 * This lives in `common` for the same reason {@link ./inline-ad-layout.ts}
 * does: more than one renderer has to agree on it exactly. The web overlay
 * (`freebuff/web/src/vly/components/project-2/agent-chat/SponsoredProposalPanel.tsx`)
 * is the only one shipping now; a terminal needs the same state machine and
 * cannot reach into `freebuff/web/src`. Deliberately dependency-free apart
 * from the destination gate below — no React, no Convex, no DOM.
 *
 * ## The two gates are the point, not the formatting
 *
 * `pr_url`, `advertiser_cta_url` and `advertiser_logo_token` are the only
 * fields on this record that stop being text and become a capability when
 * rendered: two become an `href`, the other a request path. All come off a
 * row written by the sponsored run or its settlement, so a surface that reads
 * them raw re-inherits a problem this module exists to have already solved.
 * {@link sponsoredProposalViewModel} hands back the sanitized destinations or
 * null, and the shape-checked logo handle or null — a surface never needs the
 * raw field, and reading it anyway is the bug.
 *
 * Note this is the SECOND layer for `pr_url`: `setProposalState` in
 * `freebuff/web/convex/ads/proposals.ts` runs the same gate and drops the
 * field on refusal before it is ever stored. Rows written before that guard
 * existed, dev-seeded rows, and any future write path are why the render side
 * keeps refusing too.
 */

export type SponsoredProposalState =
  | 'offered'
  | 'accepted'
  | 'running'
  // Terminal, and the ordinary success (COD-279): the run committed to its
  // own branch and stopped. `landed` still means a pull request EXISTS, and
  // only the user's own "Create pull request" moves a row there.
  | 'committed'
  // Terminal, and the ordinary success of an IN-PLACE run (the 2026-09-24
  // amendment in `docs/freebuff-sponsored-local-execution.md`): the edits are
  // in the user's working copy. There is no branch, so nothing reaches
  // `landed` or `merged` from here, and the review is the changes panel.
  | 'delivered'
  | 'landed'
  | 'failed'
  | 'merged'

// Plain words for what is happening to the user's project, never our name for
// the mechanism. The "Sponsored" disclosure belongs to each surface's own
// chrome, so the titles do not repeat it.
export const SPONSORED_STATE_TITLE: Record<SponsoredProposalState, string> = {
  offered: 'Sponsored offer',
  accepted: 'Getting started…',
  running: 'Setting it up…',
  // Names the OUTCOME, not a next step. The run is finished and the commits
  // are on a branch; whether that becomes a pull request is the user's call,
  // so the copy must not read as though something is still pending.
  committed: 'Done — committed to its own branch',
  // Says WHERE the work is, because that is the one thing a user needs to
  // know here and it is different from every other terminal: the files in
  // front of them have already changed.
  delivered: 'Done — the changes are in your files',
  landed: 'Done — pull request opened',
  failed: 'Couldn’t finish the setup',
  merged: 'Done — pull request merged',
}

/**
 * Whether a state is the END of the row's life, or somewhere it is passing
 * through.
 *
 * A `Record` rather than a set or a predicate with a `switch` default, so that
 * adding a state to the union above does not compile until this has decided
 * about it. The card's refresh cadence reads it, and a new state defaulting to
 * "terminal" would silently stop watching a run that is still going.
 */
export const SPONSORED_STATE_IS_TERMINAL: Record<
  SponsoredProposalState,
  boolean
> = {
  offered: false,
  accepted: false,
  running: false,
  committed: true,
  delivered: true,
  landed: true,
  failed: true,
  merged: true,
}

/**
 * Does this card owe the user a verdict it does not have yet?
 *
 * The question the REFRESH cadence asks, and it is not the same question as
 * "is there a card". A proposal sitting at `offered` is an OFFER: it changes
 * only when the server rotates it, and the ordinary once-a-minute cadence is
 * the right amount of attention to pay that. A row with a RUN behind it is a
 * process mutating the user's own repository, and the card is the only place
 * they can watch it — so it is owed an answer whether or not they are
 * touching the window.
 *
 * `runStarted` is why `offered` appears on both sides. Accept deliberately
 * leaves the card up with the offer still on it and only records the run's
 * thread id (`acceptProposal`), so between the accept and the first poll the
 * row still reads `offered` while a run is very much in flight. Keying purely
 * on the state would therefore stop watching at exactly the moment watching
 * starts to matter, which is the bug this exists to close: a run that failed
 * left the card showing `offered` with a live Accept button
 * on it, and a second Accept aimed at a proposal that was already dead.
 */
export function sponsoredProposalAwaitsVerdict(
  state: SponsoredProposalState,
  runStarted: boolean,
): boolean {
  if (SPONSORED_STATE_IS_TERMINAL[state]) return false
  return runStarted || state !== 'offered'
}

export type SponsoredProposalStepState = 'pending' | 'active' | 'done'

export type SponsoredProposalStep = {
  text: string
  state: SponsoredProposalStepState
}

// Same vocabulary as the agent todo dock — a sponsored run's progress should
// read exactly like the agent progress users already know.
export const SPONSORED_STEP_STATE_LABEL: Record<
  SponsoredProposalStepState,
  string
> = {
  pending: 'Pending',
  active: 'In progress',
  done: 'Done',
}

/**
 * The fields of a proposal the channel depends on.
 *
 * Structural rather than the Convex document type, so `common` does not depend
 * on `freebuff/web`'s generated model — the same trade
 * {@link ./inline-ad-layout.ts} makes for the CLI's `AdResponse`. A surface
 * with a richer row (an `Id`-typed `_id`, an `advertiser_id`) passes it
 * straight through.
 *
 * `dismissed` is a real state on the row and deliberately absent from
 * {@link SponsoredProposalState}: a dismissed proposal is not rendered by
 * anyone, so it never reaches a view model.
 */
export type SponsoredProposalRow = {
  state: SponsoredProposalState
  /** Conversation whose authenticated ad request produced this offer. */
  conversationId?: string
  advertiser_name: string
  // Opaque handle for the advertiser logo. Minted per upload, so an old one is
  // dead by design — absent and stale render the same header.
  advertiser_logo_token?: string
  headline: string
  body: string
  why_this?: string
  steps?: SponsoredProposalStep[]
  /**
   * The sponsored thread, so a terminal card can offer the read-only view
   * (COD-258). Absent before the proposal is accepted.
   */
  thread_ref?: string
  branch?: string
  pr_url?: string
  failure_reason?: string
  /**
   * The advertiser CTA: the campaign's landing URL carrying the signed
   * `bfcid` conversion token (COD-512). DERIVED BY THE SERVER PROJECTION
   * (`sponsoredAdvertiserCtaUrl` in {@link ./sponsored-proposal-cta.ts}) and
   * present only once the Accept settled with a real click behind it. A
   * surface never assembles this from a token; the raw token is not on the
   * row it receives. Gated here exactly like `pr_url` before it becomes an
   * `href`.
   */
  advertiser_cta_url?: string
  /**
   * The execution surface the offer was minted for (`desktop_macos`,
   * `desktop_windows`, ...). A surface refuses to accept a row minted for a
   * different machine than its own (COD-642). Absent on older projections.
   */
  execution_surface?: string
  /**
   * Latest COD-597 verification pointer. Absent on legacy rows and when the
   * gate is off. Never redefines `verified_outcomes`.
   */
  latest_verification?: {
    attempt_id: string
    sequence: number
    overall: string
    user_facing: string
    stale: boolean
    target_revision?: string
    completed_at?: number
    missing?: string[]
  }
  acceptance_criteria_sha256?: string
  /**
   * The user closed this card after accepting it, and its run is still in
   * flight (COD-665). Set only by the server projection, which drops a
   * hidden row once its run has ended; see `sponsoredProposalMinimized`.
   */
  hidden?: true
}

/**
 * Whether a surface draws this card MINIMIZED instead of in full (COD-665).
 *
 * The X on an accepted card HIDES it and never touches the run: the run
 * state is the executor's and the reporting surface's from Accept onwards.
 * But a live run is not concealed either -- the card is the one place that
 * says something is working on the user's code -- so while the row is
 * `accepted` or `running` a hidden card shrinks to a line the user can
 * reopen, and it leaves the panel only when the server stops returning it
 * (its run ended). A hidden row in any other state is not expected here;
 * it is drawn in full rather than guessed at.
 */
export function sponsoredProposalMinimized(
  row: Pick<SponsoredProposalRow, 'state' | 'hidden'>,
): boolean {
  return (
    row.hidden === true && (row.state === 'accepted' || row.state === 'running')
  )
}

/**
 * Everything a user can answer a proposal with, as a closed set.
 *
 * `create-pull-request` and `open-pull-request` are two different things and
 * cannot be one entry: the first asks the sponsored delivery path to turn the
 * committed branch into a PR, the second is the sanitized `pr_url` rendered as
 * a link once one exists. `view-run` is one action with two labels, because
 * watching a live run and reading a finished one are the same read-only view.
 */
export type SponsoredProposalActionKind =
  | 'accept'
  | 'create-pull-request'
  | 'view-run'
  | 'open-pull-request'
  // The two answers to a `delivered` card, and the reason it needs neither of
  // the PR actions: the work is already in the user's files, so reviewing it
  // is reading the diff and rejecting it is putting the files back.
  | 'review-changes'
  | 'undo-changes'
  // The advertiser's own next step, once there is a diff to take it with
  // (COD-512). Carries the conversion token the advertiser's postback
  // verifies; the label is neutral by design, the advertiser's name is the
  // only string of theirs in it.
  | 'open-advertiser'
  | 'verify-again'
  | 'dismiss'
  | 'never-advertiser'
  | 'report'
  | 'opt-out'

export type SponsoredProposalAction = {
  kind: SponsoredProposalActionKind
  label: string
  /** At most one per state: the answer the card leads with. */
  primary?: boolean
  /** Turns something off for good rather than declining this one offer. */
  destructive?: boolean
  /**
   * Present only on `open-pull-request` and `open-advertiser`, and only past
   * the destination gate.
   */
  href?: string
}

/**
 * The user's standing controls over the sponsored channel, available in every
 * state. Report, never-this-advertiser and the channel opt-out are the only
 * controls the user has over this channel — do not thin them out.
 */
export function sponsoredChannelActions(
  advertiserName: string,
): SponsoredProposalAction[] {
  return [
    {
      kind: 'never-advertiser',
      label: `Never show ${advertiserName}`,
      destructive: true,
    },
    { kind: 'report', label: 'Report this proposal' },
    {
      // Separate from the display-ads opt-out on purpose (A7):
      // this turns off sponsored PROPOSALS only.
      kind: 'opt-out',
      label: 'Turn off sponsored proposals',
      destructive: true,
    },
  ]
}

export type SponsoredProposalMenuKey =
  | 'accept'
  | 'why'
  | 'never-advertiser'
  | 'report'
  | 'opt-out'

/**
 * The overflow menu, in the order it is shown.
 *
 * Split out from {@link sponsoredProposalViewModel} because it needs only the
 * advertiser's name: a surface builds this menu the same way whether or not it
 * has a row in hand, and "Why this?" is a disclosure of copy the view model
 * already carries rather than an answer to the offer.
 *
 * `accept` IS OPTIONAL AND FIRST WHEN PRESENT. A surface with no room for a
 * primary — a terminal at twenty columns has none — needs somewhere to put the
 * answer to the offer, and the only honest place is at the top of the list of
 * answers. It is passed in rather than derived from a row so that a surface
 * which cannot run a sponsored task (Windows, per COD-336 item 3) simply does
 * not offer it, instead of drawing a control that refuses.
 */
export function sponsoredProposalMenu(
  advertiserName: string,
  options: { acceptLabel?: string } = {},
): Array<{
  key: SponsoredProposalMenuKey
  label: string
  separatorBefore?: boolean
}> {
  return [
    ...(options.acceptLabel
      ? [{ key: 'accept' as const, label: options.acceptLabel }]
      : []),
    { key: 'why', label: 'Why this?' },
    ...sponsoredChannelActions(advertiserName).map((action) => ({
      key: action.kind as SponsoredProposalMenuKey,
      label: action.label,
      ...(action.kind === 'opt-out' ? { separatorBefore: true } : {}),
    })),
  ]
}

/**
 * The PR link, or null if we will not put this string in an `href`.
 *
 * Reuses the ad-serving path's own destination gate (`sanitizeAdUrl`) rather
 * than a second opinion, so a sponsored PROPOSAL's link can never end up
 * looser than a sponsored CREATIVE's: https only, absolute only, terminal
 * escapes stripped. That module throws to refuse; a render must not, so the
 * refusal becomes null here.
 *
 * Null is deliberately the ABSENT-field case, not a reason to hide the
 * proposal. Every neighbouring field degrades the same way (`branch` drops a
 * clause, `failure_reason` falls back to copy), and the states that carry a
 * `pr_url` are exactly the ones reporting that a sponsored thread wrote to the
 * user's code. Losing the link costs a click; losing the card would withhold
 * that.
 */
export function sponsoredPullRequestHref(
  rawPrUrl: string | undefined,
): string | null {
  return sponsoredDestinationHref(rawPrUrl)
}

/**
 * The advertiser CTA, through the same gate as the PR link. The server
 * projection already ran `sanitizeAdUrl` when it composed the URL; this is
 * the render-side second layer, for the same reason `pr_url` has one.
 */
export function sponsoredAdvertiserCtaHref(
  rawCtaUrl: string | undefined,
): string | null {
  return sponsoredDestinationHref(rawCtaUrl)
}

function sponsoredDestinationHref(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    return sanitizeAdUrl(raw)
  } catch {
    return null
  }
}

/**
 * Narrower than the write path's `sanitizeLogoToken` on purpose.
 *
 * That one widens to url-safe base64 so a change of token generator does not
 * silently drop every logo. This one is the shape the serving route actually
 * enforces (`TOKEN` in
 * `server/advertisers/placements/creative-image-preview.ts`), applied before a
 * token becomes a request or a path segment. Loosening it to match the writer
 * would admit values the route then rejects.
 */
const LOGO_TOKEN = /^[0-9a-f-]{36}$/i

export function sponsoredLogoToken(token: string | undefined): string | null {
  if (!token || !LOGO_TOKEN.test(token)) return null
  return token
}

/**
 * The web route for a logo, or null if we will not ask for one.
 *
 * A web path in a surface-agnostic module, kept here anyway: handing each
 * surface the route string back is how the raw token starts getting read
 * directly, which is the leak {@link sponsoredLogoToken} exists to close. A
 * terminal uses the token and ignores this.
 */
export function sponsoredLogoSrc(token: string | undefined): string | null {
  const safe = sponsoredLogoToken(token)
  return safe === null ? null : `/api/ads/first-party/creative-image/${safe}`
}

const DEFAULT_WHY_THIS =
  'Matched to what you are building in this project. Sponsored proposals never read your code without your go-ahead.'
const DEFAULT_FAILURE_REASON =
  'The setup couldn’t finish. Nothing was changed in your project.'

/** Guidance, not activation evidence. A finished run proves only local work;
 * neither a signup link nor a merged PR proves the service works. Keep this
 * separate from execution steps and from the terminal run state/grant.
 */
export type SponsoredSetupGuide = {
  title: string
  eyebrow: string
  heading: string
  description: string
  steps: Array<{ title: string; detail: string }>
  verificationNote: string
}

export const VERIFICATION_USER_FACING_LABEL: Record<string, string> = {
  pending: 'Checking…',
  success: 'Verified',
  failed: 'Verification failed',
  setup_needed: 'Setup needed',
  code_ready: 'Code ready',
  couldnt_verify: "Couldn't verify",
}

export type SponsoredVerificationPanel = {
  userFacing: string
  label: string
  overall: string
  stale: boolean
  completedAt: number | null
  missing: string[]
  canRecheck: boolean
}

export type SponsoredProposalViewModel = {
  state: SponsoredProposalState
  /** The state's headline copy — what happened, never what to do next. */
  title: string
  advertiserName: string
  headline: string
  body: string
  whyThis: string
  /** Only rendered in `failed`; carries the fallback so a surface cannot skip it. */
  failureReason: string
  /** Null on a run old enough to predate the reconciler recording a branch. */
  branch: string | null
  steps: SponsoredProposalStep[]
  doneStepCount: number
  logoToken: string | null
  logoSrc: string | null
  pullRequestHref: string | null
  /**
   * Null before the run has a diff to take the advertiser's next step with
   * (`committed` onwards), and null whenever the row carries no settled CTA.
   */
  advertiserCtaHref: string | null
  setupExpectation: string
  setupGuide: SponsoredSetupGuide | null
  verification: SponsoredVerificationPanel | null
  actions: SponsoredProposalAction[]
}

/**
 * Turn a proposal row into a rendering-agnostic description of the card.
 *
 * What a surface still owns: whether it can honour an action at all. A host
 * with no read-only view must render nothing rather than a dead affordance, so
 * `view-run` being offered here is a statement about the ROW (the run exists),
 * not a promise that the surface can show it.
 */
export function sponsoredProposalViewModel(
  row: SponsoredProposalRow,
): SponsoredProposalViewModel {
  const steps = row.steps ?? []
  const pullRequestHref = sponsoredPullRequestHref(row.pr_url)
  const logoToken = sponsoredLogoToken(row.advertiser_logo_token)
  // Only once there is a diff to go with it: the CTA is the advertiser's "now
  // set up your account" and before the work exists there is nothing to set it
  // up for. `landed` and `merged` are the same finished run further on, and
  // `delivered` is the same finished run without a commit. Never on `failed`
  // -- the settlement may have charged, but the card is telling the user
  // nothing changed and must not sell beside that.
  const ctaStates: SponsoredProposalState[] = [
    'committed',
    'delivered',
    'landed',
    'merged',
  ]
  const advertiserCtaHref = ctaStates.includes(row.state)
    ? sponsoredAdvertiserCtaHref(row.advertiser_cta_url)
    : null

  const viewRun = (label: string): SponsoredProposalAction[] =>
    row.thread_ref ? [{ kind: 'view-run', label }] : []
  const openPullRequest = (label: string): SponsoredProposalAction[] =>
    pullRequestHref
      ? [{ kind: 'open-pull-request', label, href: pullRequestHref }]
      : []
  // Neutral label; the advertiser contributes the name and nothing else. It
  // is an href on every surface that can make one and sanitized text on the
  // terminal, never markup.
  const openAdvertiser = (): SponsoredProposalAction[] =>
    advertiserCtaHref
      ? [
          {
            kind: 'open-advertiser',
            label: `Set up ${row.advertiser_name}`,
            href: advertiserCtaHref,
          },
        ]
      : []
  const verifyAgain = (): SponsoredProposalAction[] =>
    row.acceptance_criteria_sha256 && ctaStates.includes(row.state)
      ? [{ kind: 'verify-again', label: 'Verify again' }]
      : []
  // No frozen contract means the campaign set no success criteria: nothing
  // was checked, so there is no verdict to show. Labelling it "Couldn't
  // verify" read as a check the run had failed. A `latest_verification` on
  // such a row is only the reducer's no-contract answer (Desktop reports
  // after every committed run, and the contract and its hash are frozen
  // together at Accept), so it is withheld too. "Couldn't verify" stays for
  // a run WITH a contract whose check came back inconclusive; the advertiser
  // rollups still count contract-less runs as no-criteria.
  const verification: SponsoredVerificationPanel | null =
    !row.acceptance_criteria_sha256
      ? null
      : row.latest_verification
        ? {
            userFacing: row.latest_verification.user_facing,
            label:
              VERIFICATION_USER_FACING_LABEL[
                row.latest_verification.user_facing
              ] ?? VERIFICATION_USER_FACING_LABEL.couldnt_verify,
            overall: row.latest_verification.overall,
            stale: row.latest_verification.stale,
            completedAt: row.latest_verification.completed_at ?? null,
            missing: row.latest_verification.missing ?? [],
            canRecheck: true,
          }
        : ctaStates.includes(row.state)
          ? {
              userFacing: 'pending',
              label: VERIFICATION_USER_FACING_LABEL.pending,
              overall: 'inconclusive',
              stale: false,
              completedAt: null,
              missing: ['Verification has not finished.'],
              canRecheck: true,
            }
          : null

  const stateActions: SponsoredProposalAction[] = (() => {
    switch (row.state) {
      // No cost claim here: whether the run is free to the user differs by
      // surface, so each surface's own copy says that.
      case 'offered':
        return [{ kind: 'accept', label: 'Set it up for me', primary: true }]
      case 'running':
        return viewRun('Watch this run')
      case 'committed':
        return [
          {
            kind: 'create-pull-request',
            label: 'Create pull request',
            primary: true,
          },
          ...viewRun('View what it did'),
          ...openAdvertiser(),
          ...verifyAgain(),
        ]
      // REVIEW LEADS, and it is the diff rather than a run transcript: the
      // files in front of the user have changed, so the first thing offered is
      // seeing exactly what changed. Undo is beside it and NOT destructive in
      // the menu sense -- it puts the user's files back, which is the opposite
      // of a control that turns something off for good. No `view-run`: the run
      // happened in this very conversation, so the transcript is already on
      // screen and a link to it would point at itself.
      case 'delivered':
        return [
          { kind: 'review-changes', label: 'Review the changes', primary: true },
          { kind: 'undo-changes', label: 'Undo these changes' },
          ...openAdvertiser(),
          ...verifyAgain(),
        ]
      case 'landed':
        return [
          ...openPullRequest('Review the pull request'),
          // Opening the PR must not take the read-only view away: the
          // transcript is still the only record of what the advertiser's agent
          // actually did.
          ...viewRun('View what it did'),
          ...openAdvertiser(),
          ...verifyAgain(),
        ]
      case 'merged':
        return [
          ...openPullRequest('view on GitHub'),
          ...openAdvertiser(),
          ...verifyAgain(),
        ]
      // `accepted` is a handoff and `failed` is over; neither offers an answer
      // beyond the decline and the standing controls below.
      case 'accepted':
      case 'failed':
        return []
    }
  })()

  return {
    state: row.state,
    title: SPONSORED_STATE_TITLE[row.state],
    advertiserName: row.advertiser_name,
    headline: row.headline,
    body: row.body,
    whyThis: row.why_this ?? DEFAULT_WHY_THIS,
    failureReason: row.failure_reason || DEFAULT_FAILURE_REASON,
    branch: row.branch || null,
    steps,
    doneStepCount: steps.filter((step) => step.state === 'done').length,
    logoToken,
    logoSrc: sponsoredLogoSrc(row.advertiser_logo_token),
    pullRequestHref,
    advertiserCtaHref,
    setupExpectation: 'Account setup may be needed after the code is ready.',
    setupGuide: ctaStates.includes(row.state)
      ? {
          title: 'Finish setup and verify',
          eyebrow:
            row.state === 'merged'
              ? 'Finish setup'
              : // Nothing is merged on an in-place run, so "Before you merge"
                // would name a step that does not exist here.
                row.state === 'delivered'
                ? 'Before you keep it'
                : 'Before you merge',
          heading: `Connect ${row.advertiser_name}`,
          description:
            'Your code is ready. Create an account or sign in, then add your project settings.',
          steps: [
            {
              title: '1. Review the code',
              detail:
                'Review the changes and setup notes. The code is ready for review; the live connection still needs checking.',
            },
            {
              title: '2. Set up your account',
              detail: `Create or sign in to your ${row.advertiser_name} account if needed. Follow the setup notes to connect your project and configure credentials in your environment settings.`,
            },
            {
              title: '3. Verify in your app',
              detail:
                'Run the feature against your connected project using the setup notes. A signup or passing local tests alone does not verify the integration.',
            },
          ],
          verificationNote:
            'Live integration verification is not recorded by this card. These are your next steps; they do not restart the sponsored run.',
        }
      : null,
    verification,
    actions: [
      ...stateActions,
      // Every state declines the same way, and this is the ONLY decline — the
      // terminal states used to carry a second, competing one.
      { kind: 'dismiss', label: 'Dismiss sponsored proposal' },
      ...sponsoredChannelActions(row.advertiser_name),
    ],
  }
}

/** The one action of this kind on offer, or null. */
export function sponsoredProposalAction(
  view: SponsoredProposalViewModel,
  kind: SponsoredProposalActionKind,
): SponsoredProposalAction | null {
  return view.actions.find((action) => action.kind === kind) ?? null
}
