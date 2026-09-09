/**
 * The sponsored-proposal conformance matrix, as data (COD-376).
 *
 * One numbered check list that Web, Desktop and CLI all report against, so
 * "the terminal card behaves like the web card" is a claim with a shape rather
 * than an impression. A surface's run produces one result per ID — `pass`,
 * `fail`, or `waived: <reason>` — and a surface with any `fail`, or any waiver
 * this file does not list for it, is not conformant.
 *
 * The IDs are the contract and are STABLE. Renumbering them silently
 * invalidates every report already posted on the issue, so a new check is
 * appended at the end of its layer rather than inserted.
 *
 * This is data, not a runner. It exists so two things can be checked
 * mechanically that otherwise depend on someone remembering: that every
 * render-layer ID has a test case referencing it (see
 * `sponsoredProposalConformance.test.ts` beside the Web panel), and that a
 * report's waivers are ones this document actually accepts.
 *
 * The layers, and why they are separate:
 *
 *   VM — the view model in {@link ./sponsored-proposal-view.ts}. Runs ONCE, in
 *        `common`. No surface re-implements these; a surface that did would be
 *        testing its own copy of the state machine rather than the shared one.
 *   R  — render. Per surface, against the shared fixtures in
 *        {@link ./__fixtures__/sponsored-proposal-rows.ts}.
 *   C  — connected. The renderer bound to its transport, with a fake backend.
 *   V  — viewing a run read-only. Only where the surface has such a view.
 *   B  — the gate and billing isolation, against a loopback backend.
 *   E  — end to end, real backend, real user action.
 */

export type SponsoredConformanceLayer = 'VM' | 'R' | 'C' | 'V' | 'B' | 'E'

export type SponsoredConformanceSurface = 'web' | 'desktop' | 'cli'

export type SponsoredConformanceCheck = {
  /** Stable identifier, e.g. `R-14`. Never renumbered. */
  id: string
  layer: SponsoredConformanceLayer
  /** What passing means, in one sentence. */
  check: string
}

const check = (
  layer: SponsoredConformanceLayer,
  entries: string[],
): SponsoredConformanceCheck[] =>
  entries.map((text, index) => ({
    id: `${layer}-${index + 1}`,
    layer,
    check: text,
  }))

/**
 * VM-1..VM-24 map one-to-one onto the `test(...)` cases of
 * `sponsored-proposal-view.test.ts`, IN FILE ORDER.
 *
 * File order rather than a semantic grouping because that is the only mapping
 * a reader can verify against the file without a lookup table — and because
 * two of these cases are loops over states or over hostile inputs, so a
 * "one ID per assertion" numbering would not be stable against adding an
 * eleventh rejected URL.
 *
 * Note for anyone reconciling this with the plan document: the doc says
 * "VM-1 through VM-26". The file had 24 `test(...)` sites when that was
 * written, and now has 28 — the four the optional Accept added (COD-339). The
 * count is asserted, so the list and the suite cannot drift again.
 */
const VM_CHECKS = check('VM', [
  'every state names its own outcome',
  'committed names the outcome, not a next step',
  'counts the done steps for the progress counter',
  'absent steps are an empty list, not undefined',
  'step labels read in the todo-dock vocabulary',
  'offered leads with accept',
  'accepted and failed offer no answer beyond the decline',
  'dismiss is available in every state and is not destructive',
  'the standing channel controls are available in every state',
  'running offers the live view only once a thread exists',
  'committed offers the PR decision and the read-only view',
  'committed still offers the PR decision with no thread to view',
  'the read-only view survives into landed',
  'merged links the merged PR under its own label',
  'every hostile pr_url is refused, in landed and in merged',
  'a refused link does not cost the rest of the card',
  'an https pull request passes through',
  'a well-formed logo token becomes the creative-image route',
  'no token is the ordinary no-logo case',
  'a malformed logo token never mints a request',
  'why_this falls back to the channel promise',
  'a failed run promises nothing changed even with no reason',
  'an absent branch is null rather than a guess',
  'the channel menu lists every control, in order',
  // VM-25..VM-28: the optional Accept (COD-339). A surface with no room for a
  // primary needs somewhere to put the answer to the offer, and it is passed
  // in rather than derived from the row -- so a surface that cannot RUN a
  // sponsored task simply does not offer it, instead of drawing a control that
  // refuses.
  'the channel menu is unchanged when no accept label is given',
  'an accept label puts the Accept first and changes nothing else',
  'an empty accept label is not an Accept',
  'the standing controls survive an Accept being added above them',
  // VM-29..VM-32: the advertiser CTA (COD-512). The campaign landing URL
  // carrying the signed conversion token, composed by the SERVER projection
  // and gated on render exactly like `pr_url`.
  'committed, landed and merged offer the advertiser CTA under a neutral label',
  'no state before a diff exists offers the advertiser CTA, and failed never does',
  'an absent advertiser CTA renders no action and no placeholder',
  'a hostile advertiser CTA URL never becomes a destination and does not cost the card',
])

const R_CHECKS = check('R', [
  'every state carries the "Sponsored" disclosure, legible at the surface\'s narrowest width',
  'every state exposes exactly one dismiss affordance',
  // Named for the SLOT, not for what it currently says: the two surfaces
  // disclose different things because they bill differently. A Cloud run is
  // metered to the advertiser's campaign; a Desktop run is not — the metering
  // for that is COD-119's and is not built — so it discloses that it uses the
  // user's own session and credits.
  'offered shows body, one primary action labelled from accept.label, and the cost disclosure',
  'accepted shows the state title and no accept affordance',
  'running renders steps in the SPONSORED_STEP_STATE_LABEL vocabulary and the done/total count',
  'running offers the read-only view only with a thread_ref AND a host handler; otherwise nothing, never a dead control',
  'committed shows no spinner and no running copy',
  'committed names the branch, or drops the clause when branch is null; never guesses',
  'committed offers the PR decision and the read-only view; with no host handlers it renders no action controls',
  'committed states nothing was pushed',
  'landed links the PR and names the branch; the view control survives',
  'failed shows failureReason and promises nothing changed',
  'merged is terminal success with the PR link',
  'for landed and merged, each hostile URL renders no link and the rest of the card survives',
  'an https PR URL renders as a real link (or, on CLI, as the sanitized text the user can open)',
  'a valid logo token renders the creative-image route — same-origin on Web, and on Desktop the absolute freebuff.com URL, since the Desktop shell is not served from it; CLI renders the name only and never fetches',
  'no token and an unusable token render byte-identically, and no request is minted for a malformed token',
  'the channel menu lists Why this / Never {advertiser} / Report / Turn off, in sponsoredProposalMenu order, each handler invoked exactly once',
  'the advertiser name is present as text in every state',
])

const C_CHECKS = check('C', [
  'subscribes or polls the active proposal for the current target only',
  'binds accept, dismiss, report, never-advertiser and opt-out',
  'renders nothing while loading, with no row, or with a dismissed row',
  'sends nothing to the backend while hidden',
  'accept sends one accept for this proposal and nothing else; a double activation sends one',
  'a rejected accept surfaces an error and does not retry',
  'dismiss never accepts; a double dismiss sends one',
  'never-advertiser sends the pref write then a dismiss, in that order',
  'create PR is bound as an action returning {success, message, prUrl?}; success:false is shown, not thrown',
  'a closed gate yields no card and no writes',
])

const V_CHECKS = check('V', [
  'the send target is always the user’s own thread, never the watched one',
  'the transcript pane follows the watched thread; composer and every other sender are disabled',
  'the composer stays hidden for a sponsored thread even if it became the pointer',
  'the card opens the VIEW pointer, never the send pointer',
  'the header discloses "Sponsored" on the watched thread',
  'the view pointer is ephemeral client state; a reload discards it',
])

const B_CHECKS = check('B', [
  'freebuff_daily_usage for the user is unchanged across offer, accept and the terminal state',
  'the proposal row carries surface equal to the surface under test',
  'dismiss on a running row is refused with the "still running" message; report on running records without dismissing',
  'a seeded row has no impression_token and no creative_id',
])

const E_CHECKS = check('E', [
  'a seeded offered row with surface set appears on the surface within one poll interval',
  'a second account signed in at the same time sees nothing',
  'accept moves the row to accepted and the surface shows the state title within one poll interval',
  'running to committed follows each transition on the card',
  'failed with a reason renders the reason',
  'never-advertiser and opt-out each remove the card and suppress the matching re-seed; a running row survives both',
  'create PR from committed moves to landed with a link',
])

export const SPONSORED_CONFORMANCE_CHECKS: SponsoredConformanceCheck[] = [
  ...VM_CHECKS,
  ...R_CHECKS,
  ...C_CHECKS,
  ...V_CHECKS,
  ...B_CHECKS,
  ...E_CHECKS,
]

/**
 * The layers whose IDs must be REFERENCED by a test case rather than reported
 * by hand.
 *
 * VM, R, C and V are all observable from a test file; B and E need a backend
 * and a human respectively, so their results are reported in the issue comment
 * and cannot be checked by a scan.
 */
export const SPONSORED_CONFORMANCE_REFERENCED_LAYERS: SponsoredConformanceLayer[] =
  ['VM', 'R', 'C', 'V']

export function sponsoredConformanceIds(
  layer?: SponsoredConformanceLayer,
): string[] {
  return SPONSORED_CONFORMANCE_CHECKS.filter(
    (entry) => layer === undefined || entry.layer === layer,
  ).map((entry) => entry.id)
}

export function sponsoredConformanceCheck(
  id: string,
): SponsoredConformanceCheck | null {
  return SPONSORED_CONFORMANCE_CHECKS.find((entry) => entry.id === id) ?? null
}

/**
 * The ONLY waivers a Phase 1 report may carry, per surface.
 *
 * A waiver is a promise about what the surface does NOT do yet, so the reason
 * string is part of the contract: two surfaces waiving the same ID for
 * different reasons are two different gaps, and collapsing them to a shared
 * "not implemented" hides which one Phase 2 has to close.
 *
 * Web is deliberately empty. It is the reference implementation; a waiver
 * there is a regression in the thing every other surface is measured against.
 */
export const SPONSORED_CONFORMANCE_ACCEPTED_WAIVERS: Record<
  SponsoredConformanceSurface,
  Record<string, string>
> = {
  web: {},
  // THE ARGUMENT THAT CAUGHT THIS, KEPT BECAUSE IT IS STILL THE RULE. An
  // earlier revision of this table reported E-3..E-7 as `pass` for Desktop off
  // `services/sponsored-run.test.ts`, which builds a `fakes()` harness: a fake
  // command runner, a fake proposals client, a fake consent gate. Those tests
  // are good and they pin the logic, but a green fake is the C layer's
  // evidence, not the E layer's — the entire point of E being a separate layer
  // is that the others run against fixtures and this one does not. The CLI
  // block below refuses to report a hand-inserted block as `pass` because that
  // would be "reporting the fixture"; reporting E rows off a fake runner is the
  // same move, and it is harder to notice, because Desktop's fakes are
  // convincing enough that the gap does not announce itself. A row clears here
  // by RUNNING the walk and recording what was observed, never by adding
  // another test.
  //
  // E-3, E-4 and E-7 HAVE NOW BEEN RUN (COD-397, 2026-09-02). A seeded row was
  // accepted on a running Desktop, the consent dialog was drawn, the card
  // walked accepted -> running -> committed with the branch named, the diff
  // appeared in ChangesPanel, and Create pull request opened a real one:
  //
  //   https://github.com/obro79/stormhacks/pull/19  (commit 1b4eb49)
  //
  // `git ls-remote` was empty for the branch before the click and the row
  // reached `landed` with the URL stored server-side, so E-7 is the button's
  // evidence and not the run's.
  //
  // WHAT THAT EVIDENCE IS NOT. One run, on one macOS machine, against a
  // loopback stack, against one repository, on the happy path. It says these
  // three rows are reachable; it does not say they are reliable, and nothing
  // here has been run on Linux or Windows or against production.
  //
  // E-5 STAYS WAIVED, and the distinction is the point of keeping the reason
  // strings honest: the walk did produce `failed` rows, and the reason did
  // render — but incidentally, when earlier attempts broke of their own accord,
  // never by deliberately driving a run to fail and checking what the card
  // said. An observation collected while trying to make something else work is
  // not a measurement of it.
  desktop: {
    'E-5':
      'not deliberately driven: failures were seen incidentally on the local walk, never induced and checked',
  },
  // COD-339 (Phase 2) added the producer and the execution half, so what was
  // waived for "no producer" or "no execution" is gone. Every reason left is
  // specific to this surface rather than to a phase, and two of them are
  // deliberately honest about the difference between a property that HOLDS and
  // a property that has been MEASURED.
  cli: {
    // R-3 is UN-WAIVED. The card offers an Accept, gated on whether this
    // machine can contain a run; on Windows it renders the shared refusal copy
    // instead of a control that cannot work. Both are pinned by checked-in
    // frames at 20, 48 and 60 columns.
    //
    // THE V ROWS ARE STRUCTURALLY INAPPLICABLE HERE, which is not the same as
    // unbuilt. They are about a second, watched THREAD that must never become
    // the send target. The CLI has one transcript and one send target; a
    // sponsored run is not a thread at all and never becomes a pointer, so
    // there is no send target to protect and no view pointer to discard. A
    // `pass` would claim a control that does not exist.
    'V-1':
      'no second thread on this surface: a sponsored run is never a send target',
    'V-2': 'no second thread on this surface',
    'V-3': 'no composer to repoint: the CLI has one',
    'V-4': 'no view pointer on this surface',
    'V-5': 'no watched thread header; the card carries the disclosure instead',
    'V-6': 'no view pointer on this surface',
    'R-6':
      'no read-only view: the run’s transcript is not interleaved with the user’s own',
    'R-9': 'no read-only view',
    // A terminal cannot make a link; it can only print a destination the user
    // may copy. The sanitizing is the part that still has to hold.
    'R-15': 'renders sanitized text, not a link',
    // THE E ROWS ARE NOT MEASURED, and the reason has changed from Phase 1's.
    // A producer polls, an Accept exists and a run executes — but none of it
    // has been driven against a seeded row on a real backend from this branch,
    // and reporting `pass` off a unit test would be reporting the fixture. The
    // harness for exactly this is COD-408.
    'E-1': 'not driven against a seeded row on a real backend (COD-408)',
    'E-2': 'not driven against a seeded row on a real backend (COD-408)',
    'E-3': 'not driven against a seeded row on a real backend (COD-408)',
    'E-4': 'not driven against a seeded row on a real backend (COD-408)',
    'E-5': 'not driven against a seeded row on a real backend (COD-408)',
    'E-6': 'not driven against a seeded row on a real backend (COD-408)',
    'E-7': 'not driven against a seeded row on a real backend (COD-408)',
    // B-1 holds by CONSTRUCTION rather than by measurement: nothing on this
    // path writes `freebuff_daily_usage`, and the turn takes the ordinary
    // billed path deliberately (Owen, 2026-09-03 — a local sponsored run spends
    // the user's own session and credits, which is what the card says). Waived
    // until it is observed across a real run rather than argued from the code.
    'B-1': 'unchanged by construction; not observed across a real run yet',
  },
}

/**
 * E-6 IS NOT WAIVED ON EITHER SURFACE, and the plan document says both things.
 *
 * Its per-surface "applies in Phase 1" list names E-1, E-2 and E-6; its waiver
 * line then says `E-3..E-7`. Only one of those can be true, and E-6 —
 * never-advertiser and opt-out suppressing the next offer — needs no execution
 * at all: it is a preference write and a re-seed. So E-4, E-5 and E-7 are
 * waived by range and E-6 is not — on DESKTOP. Recorded here because the next
 * reader will hit the same contradiction.
 *
 * The contradiction is moot for DESKTOP (COD-397): E-3..E-7 are all observable
 * there, because a run happens, and E-3, E-4 and E-7 have been observed. E-5 is
 * still waived, but for having never been driven rather than for being out of
 * reach.
 *
 * It is moot for the CLI too since COD-339, and for a different reason again.
 * That surface now has a producer AND execution, so every E row is observable
 * — and none has been observed, because nothing on this branch drove one
 * against a seeded row on a real backend. The whole E block is waived on one
 * honest reason rather than seven different ones, and COD-408 is the harness
 * that closes it.
 */
export function sponsoredConformanceWaiverAccepted(
  surface: SponsoredConformanceSurface,
  id: string,
  reason: string,
): boolean {
  return SPONSORED_CONFORMANCE_ACCEPTED_WAIVERS[surface][id] === reason
}
