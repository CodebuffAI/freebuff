import type {
  SponsoredProposalRow,
  SponsoredProposalState,
} from '../sponsored-proposal-view'

/**
 * The rows every sponsored-proposal renderer is tested against (COD-376).
 *
 * One row per state, plus the two hostile input sets, shared so that Web,
 * Desktop and CLI render the SAME bytes rather than three hand-written
 * approximations of them. A surface that writes its own fixture rows has not
 * run the conformance matrix — it has run a matrix-shaped test against inputs
 * it chose, which is the failure mode this file exists to close.
 *
 * Deliberately in `common` rather than beside any one surface's tests: the
 * view model already lives here for the same reason
 * ({@link ../sponsored-proposal-view.ts} — "a terminal needs the same state
 * machine and cannot reach into `freebuff/web/src`"), and fixtures that live
 * inside a surface are reachable by exactly one of the three.
 *
 * Values are the ones the existing Web and view-model suites already assert
 * on, lifted verbatim: "Acme Deploys", the one-click-deploys headline, the
 * `11111111-…` logo token. Changing one of them is a change to every surface's
 * expected output, which is the point.
 */

/** The advertiser every fixture row is from. */
export const FIXTURE_ADVERTISER_NAME = 'Acme Deploys'

/**
 * A logo token of the shape the creative-image route actually serves.
 *
 * SHAPE-VALID, NOT RESOLVABLE. Nothing serves these bytes: the route only
 * answers for a token on an approved, active creative whose image is in the
 * blob store, and this value is on no such row anywhere. A surface under test
 * must therefore either not fetch at all (the CLI), assert only on the URL it
 * would request (Web, Desktop), or stub the response (`ui:shots`). Pointing a
 * real browser at this token gets a 404, which the Web card deliberately
 * renders as no image at all — so "the card looks right" can never be the
 * proof that the logo works.
 */
export const VALID_LOGO_TOKEN = '11111111-1111-4111-8111-111111111111'

/** The branch a finished run committed to. */
export const FIXTURE_BRANCH = 'sponsored/acme-deploys'

/** The sponsored thread a run writes into, once one exists. */
export const FIXTURE_THREAD_REF = 'thread-1'

/** The one pull request URL that is allowed to become a destination. */
export const FIXTURE_PR_URL = 'https://github.com/x/y/pull/7'

/**
 * The advertiser CTA as the server projection composes it (COD-512): the
 * campaign landing URL carrying a `bfcid`. Shape-valid, never verifiable --
 * the token here is not signed by any secret, and no surface checks that
 * (only the postback does).
 */
export const FIXTURE_ADVERTISER_CTA_URL =
  'https://acme.example/signup?bfcid=bfc_1.eyJpZCI6ImF0dHJpYnV0aW9uXzEifQ.c2ln'

const BASE: SponsoredProposalRow = {
  state: 'offered',
  advertiser_name: FIXTURE_ADVERTISER_NAME,
  // Present on the BASE, so the with-logo header is what the shared rows
  // exercise by default. It used to be set on no row at all, which left R-16
  // reachable only from a surface that hand-wrote a token and left every
  // screenshot anyone took showing the no-logo header. A logo that fails to
  // load and a logo that was never asked for produce the same picture, so
  // "the fixtures look fine" was never evidence that the token path worked.
  advertiser_logo_token: VALID_LOGO_TOKEN,
  headline: 'Add one-click deploys to this project',
  body: 'A sponsored agent can wire Acme Deploys into your repo on its own branch.',
}

/**
 * Every state, each carrying the fields that state legitimately has.
 *
 * Not one row with a swapped `state`: the states differ in which optional
 * fields are present, and the checks that matter most (R-6, R-8, R-9) are
 * about a surface's behaviour when a field is ABSENT. A uniform row with every
 * field filled in would pass all of them vacuously.
 */
export const SPONSORED_ROW_FIXTURES: Record<
  SponsoredProposalState,
  SponsoredProposalRow
> = {
  offered: { ...BASE },
  accepted: { ...BASE, state: 'accepted', thread_ref: FIXTURE_THREAD_REF },
  running: {
    ...BASE,
    state: 'running',
    thread_ref: FIXTURE_THREAD_REF,
    // One of each step state, so the progress counter reads 1/3 and the
    // todo-dock vocabulary is exercised in full.
    steps: [
      { text: 'Install the SDK', state: 'done' },
      { text: 'Wire the deploy hook', state: 'active' },
      { text: 'Open a pull request', state: 'pending' },
    ],
  },
  committed: {
    ...BASE,
    state: 'committed',
    thread_ref: FIXTURE_THREAD_REF,
    branch: FIXTURE_BRANCH,
  },
  landed: {
    ...BASE,
    state: 'landed',
    thread_ref: FIXTURE_THREAD_REF,
    branch: FIXTURE_BRANCH,
    pr_url: FIXTURE_PR_URL,
  },
  failed: {
    ...BASE,
    state: 'failed',
    // The one row that deliberately carries NO token, so the shared rows keep
    // covering the ordinary no-logo header (VM-19, R-17) rather than only the
    // malformed-token refusal. An absent token is not an error: it is the
    // common case for an advertiser whose creative was never uploaded, and a
    // matrix in which every row has a logo would stop checking that the header
    // still reads correctly without one.
    advertiser_logo_token: undefined,
    failure_reason: 'Budget exceeded',
  },
  merged: {
    ...BASE,
    state: 'merged',
    branch: FIXTURE_BRANCH,
    pr_url: FIXTURE_PR_URL,
  },
}

export const SPONSORED_FIXTURE_STATES = Object.keys(
  SPONSORED_ROW_FIXTURES,
) as SponsoredProposalState[]

/**
 * Every `pr_url` that must never reach an `href`.
 *
 * Lifted out of `sponsored-proposal-view.test.ts` so the render suites on the
 * other two surfaces cannot drift to a shorter list — the DOM suite already
 * carries a six-entry subset of this, which is exactly the drift.
 *
 * The three groups are different failures and all eleven are kept: hostile
 * schemes, a plaintext downgrade of a link the user has every reason to trust,
 * and strings that are not absolute URLs at all and must never be guessed into
 * one.
 */
export const HOSTILE_PR_URLS = [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  // Downgrade: a PR we would send the user to over plaintext.
  'http://github.com/x/y/pull/7',
  // Protocol-relative — no scheme at all, so it is unparseable as an absolute
  // URL and must never be guessed into one.
  '//evil.example/pull/7',
  '/x/y/pull/7',
  'github.com/x/y/pull/7',
  'not a url',
  '',
] as const

/**
 * Logo tokens that must never become a request or a path segment.
 *
 * A token is minted per upload, so a stale one is ordinary rather than
 * exceptional; all four of these have to land on the same no-logo header that
 * an absent token does.
 */
export const MALFORMED_LOGO_TOKENS = [
  '../../etc/passwd',
  'not-a-token',
  '',
  // Right length, wrong charset: 36 characters outside [0-9a-f-].
  'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz',
] as const
