/**
 * Accepting a sponsored proposal and running it here, in this terminal, on this
 * machine (COD-339).
 *
 * The whole of the CLI's execution half in one object: consent, the accept, the
 * worktree, the turn, every state report that follows, the interrupt, and the
 * two deliberate user actions afterwards (Create pull request, Remove
 * workspace). One file because it is one decision — "run an advertiser's
 * procedure against the user's repository" — and a decision spread across the
 * commands that happen to trigger it is a decision nobody can review.
 *
 * ## What it does NOT own
 *
 * The trust boundary. That is COD-336's, written down in
 * `docs/freebuff-sponsored-local-execution.md` and enforced in
 * `common/src/ads/sponsored-local-execution.ts` plus the SDK broker. This file
 * CONSUMES it: it asks whether this machine can contain a run, refuses when the
 * answer is no, and hands the SDK a run built from the local grant. It never
 * decides what a run may do.
 *
 * ## Consent, and why a terminal draws it differently
 *
 * COD-336 decision item 4 requires per-run consent drawn by the ELECTRON MAIN
 * PROCESS, for the reason `docs/mcp-desktop/02-security.md` gives about
 * spawning: the orchestrator cannot be the authority for a decision about
 * itself. There is no Electron here and no second process to draw a window
 * from, so the terminal equivalent is an in-TUI confirmation naming the
 * advertiser, what the task will do, the target folder and the branch, which
 * the user can refuse.
 *
 * THAT IS AN ADAPTATION OF THE DECISION, NOT A RE-OPENING OF IT. What item 4
 * actually buys is SUPERVISION — §1 of the doc identifies it as the real delta,
 * and §5 D says a consent gate is "necessary, not sufficient" and must ship
 * beside a mechanism rather than instead of one. Both of those hold here: the
 * mechanism is the same SDK broker Desktop uses, and the gate is a thing the
 * user has to answer before any write happens anywhere. What does NOT transfer
 * is the separate-process property, and it is worth being honest that this is
 * weaker: a compromised CLI could draw a consent screen and ignore the answer.
 * A compromised CLI can also just run the procedure, which is why the property
 * was never load-bearing on a single-process surface.
 *
 * ## The order, and why it is that order
 *
 * consent -> accept -> worktree -> turn.
 *
 * Consent comes FIRST, before any network write, because a Decline has to leave
 * the proposal `offered`. Accepting first and then failing the row back would
 * be two writes to undo a decision the user had not made yet, and any crash
 * between them leaves a row saying a user accepted something they refused.
 *
 * The cost of that order is real and is the same cost Desktop pays: the accept
 * response is the only place the full procedure text exists, so the consent
 * cannot show it. It shows what the card already showed — the advertiser, the
 * headline and the body — plus the folder and the branch, which are the two
 * facts the card does NOT carry and the two that say what is about to happen to
 * this machine.
 *
 * ## Reporting is advisory, except where it is not
 *
 * Every `reportState` failure is swallowed. A run that committed to a branch
 * committed to a branch whether or not freebuff.com heard about it, and a user
 * whose review is blocked on a reporting round-trip is a user punished for our
 * network. The one exception is `landed`, which COD-396 gave a refusal a user
 * can be told about: the pull request exists and the row did not move.
 *
 * ## Billing (Owen, 2026-09-03)
 *
 * The run spends the user's own session and credits, like any other task. The
 * advertiser-pays metering (COD-119) has no server-side reader, so the
 * sponsored marker rides every turn awaiting it and the card says plainly what
 * is being spent. `freebuff_daily_usage` is not written by anything in this
 * file; the turn takes the ordinary path.
 */
import {
  SPONSORED_LOCAL_INSTALL_REFUSAL,
  SPONSORED_LOCAL_V1_GRANT,
  commandInstallsDependencies,
  evaluateSponsoredLocalToolCall,
  sponsoredLocalAvailability,
} from '@codebuff/common/ads/sponsored-local-execution'
import { evaluateSponsoredWritePath } from '@codebuff/common/ads/sponsored-capabilities'
import type { SponsoredProcedureRuntimeInputs } from '@codebuff/common/ads/sponsored-procedure-inputs'
import {
  sponsoredAdvertiserCtaHref,
  sponsoredPullRequestHref,
} from '@codebuff/common/ads/sponsored-proposal-view'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'path'

import { applyPatchTool } from '../../../sdk/src/tools/apply-patch'
import { changeFile } from '../../../sdk/src/tools/change-file'
import { codeSearch } from '../../../sdk/src/tools/code-search'
import { glob } from '../../../sdk/src/tools/glob'
import { listDirectory } from '../../../sdk/src/tools/list-directory'
import { getFiles } from '../../../sdk/src/tools/read-files'
import { runTerminalCommand } from '../../../sdk/src/tools/run-terminal-command'
import { createSponsoredRootedFileSystem } from '../../../sdk/src/tools/sponsored-rooted-filesystem'
import { getConfigDir } from './config-dir'
import {
  assertSponsoredReadPath,
  assertSponsoredWritePath,
  createSponsoredCodeSearchBroker,
  sponsoredCodeSearchFlagsRefusal,
  sponsoredContainment,
} from '../../../sdk/src/tools/sponsored-sandbox'
import { getAuthToken } from './auth'
import { getCodebuffClient } from './codebuff-client'
import { IS_FREEBUFF } from './constants'
import { getSystemProcessEnv } from './env'
import { getAgentIdForMode } from './freebuff-agent-selection'
import { logger } from './logger'
import {
  buildSponsoredPrompt,
  sponsoredAgentDefinition,
} from './sponsored-agent'
import {
  acceptSponsoredProposal,
  reportSponsoredRunState,
} from './sponsored-proposal-api'
import {
  bunGitRunner,
  createSponsoredWorktree,
  firstLine,
  gitdirUnmoved,
  isGitRepository,
  removeSponsoredWorktree,
  sponsoredBranchFor,
  sponsoredHead,
  sponsoredRuntimeDir,
  type GitRunner,
  type SponsoredWorktree,
} from './sponsored-worktree'
import { getSelectedFreebuffModel } from '../state/freebuff-model-store'

import type {
  SponsoredProposal,
  SponsoredStateUpdate,
} from './sponsored-proposal-api'
import type { SponsoredLocalAvailability } from '@codebuff/common/ads/sponsored-local-execution'
import type { FileReadWindow } from '@codebuff/common/types/contracts/client'

/** The title, and therefore the branch slug. */
export function sponsoredRunTitle(advertiserName: string): string {
  return `Sponsored: ${advertiserName}`
}

/** How much of a turn's error text `diagnostic_reason` carries. */
export const SPONSORED_DIAGNOSTIC_CAUSE_LIMIT = 200

/**
 * The turn's own error, rendered for `diagnostic_reason`.
 *
 * FIRST LINE ONLY, then capped. The two together are the leak control, not a
 * formatting preference: an error's first line is a summary written to be read,
 * while everything after it is a stack trace, a provider payload, or — for a
 * failure raised while reading or writing a file — the surrounding content.
 * `diagnostic_reason` is an operator's field, it is stored server-side, and it
 * is not a place to spill a user's source.
 */
export function diagnosticCause(errorText?: string | null): string {
  const line = (errorText ?? '').split('\n')[0]!.trim()
  if (!line) return ''
  return `: ${
    line.length > SPONSORED_DIAGNOSTIC_CAUSE_LIMIT
      ? `${line.slice(0, SPONSORED_DIAGNOSTIC_CAUSE_LIMIT)}…`
      : line
  }`
}

/** What the consent screen names. Everything on it is known BEFORE the accept. */
export type SponsoredConsent = {
  proposalId: string
  advertiserName: string
  headline: string
  body: string
  /** The checkout the run will be cut from. */
  folder: string
  /** The exact branch that will be created, not "a branch". */
  branch: string
}

export type SponsoredRunPhase =
  | 'idle'
  | 'accepting'
  | 'running'
  | 'committed'
  | 'landed'
  | 'failed'

/** What the transcript and the card read while a run is in flight or over. */
export type SponsoredRunSnapshot = {
  phase: SponsoredRunPhase
  proposalId: string | null
  advertiserName: string | null
  branch: string | null
  worktreePath: string | null
  prUrl: string | null
  failureReason: string | null
}

const IDLE: SponsoredRunSnapshot = {
  phase: 'idle',
  proposalId: null,
  advertiserName: null,
  branch: null,
  worktreePath: null,
  prUrl: null,
  failureReason: null,
}

export type SponsoredRunOutcome =
  | { ok: true }
  | { ok: false; declined: true }
  | { ok: false; message: string }

export type SponsoredDeliveryOutcome =
  | { ok: true; prUrl: string; recorded: boolean }
  | { ok: false; message: string }

/** Injected so every decision below is testable without a network or a checkout. */
export type SponsoredRunDeps = {
  accept: typeof acceptSponsoredProposal
  reportState: typeof reportSponsoredRunState
  getToken: () => string | null | undefined
  git: GitRunner
  /** Is this path on disk? Injected with `git`, for the same reason. */
  exists: (path: string) => boolean
  platform: NodeJS.Platform
  /** The SDK turn. Returns the error text, or null for a clean finish. */
  runTurn: (context: SponsoredTurnContext) => Promise<string | null>
  /** `gh`/`git` for delivery. Separate from `git` so a test can refuse a push. */
  deliver: (
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string | undefined> },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  now: () => number
  terminalReports: {
    read: () => string | null
    write: (value: string) => void
  }
}

type DurableTerminalReport = {
  proposalId: string
  runToken: string
  update: SponsoredStateUpdate
  attempts: number
  nextDueAt: number
  lastError: string | null
  disposition?: 'pending' | 'exhausted' | 'permanent_refusal'
}

function terminalReportPayload(update: SponsoredStateUpdate): string {
  return JSON.stringify({
    state: update.state,
    steps: update.steps,
    branch: update.branch,
    prUrl: update.prUrl,
    failureReason: update.failureReason,
    diagnosticReason: update.diagnosticReason,
    head: update.head,
  })
}

const TERMINAL_REPORT_STATES = new Set(['committed', 'failed', 'landed'])
const TERMINAL_REPORT_RETRY_MAX_MS = 5 * 60_000
const TERMINAL_REPORT_MAX_ATTEMPTS = 8

export type SponsoredTurnContext = {
  prompt: string
  worktree: SponsoredWorktree
  runtimeDir: string
  proposalId: string
  signal: AbortSignal
}

/**
 * A sponsored run, from the Accept to the pull request.
 *
 * ONE AT A TIME, process-wide. A terminal has one project and one user, and two
 * concurrent advertiser procedures in the same repository would race each
 * other's index. It is a field rather than a queue because the honest answer to
 * "accept a second one" is "not while this is running", said out loud.
 */
export class SponsoredRun {
  private snapshot: SponsoredRunSnapshot = IDLE
  private readonly listeners = new Set<(s: SponsoredRunSnapshot) => void>()

  /** Set for the whole life of a run: the accept, the turn, and the report. */
  private active: {
    proposalId: string
    runToken: string
    advertiserName: string
    worktree: SponsoredWorktree | null
    abort: AbortController
    /** True once a terminal state has been reported. Interrupts read it. */
    settled: boolean
  } | null = null

  private accepting = false
  private pushing = false
  private reportRetryTimer: ReturnType<typeof setTimeout> | null = null
  private terminalReportFlushChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly projectRoot: string,
    private readonly deps: SponsoredRunDeps,
  ) {
    void this.flushTerminalReports(false)
  }

  // ------------------------------------------------------------- observation

  get state(): SponsoredRunSnapshot {
    return this.snapshot
  }

  subscribe(listener: (s: SponsoredRunSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<SponsoredRunSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot)
      } catch (error) {
        logger.debug({ error }, '[sponsored-run] listener threw')
      }
    }
  }

  /**
   * Can a sponsored run be contained on this machine?
   *
   * UNLIKE DESKTOP there is no `no-consent-bridge` arm. That reason exists
   * there because the consent window is drawn by a process that may not be
   * running (`dev:web`, a bare orchestrator, the ui-shots harness); the CLI's
   * confirmation is drawn by the same process that would run the task, so it is
   * present exactly when the CLI is.
   *
   * Windows is `unavailable:windows-no-containment` and the copy says so, which
   * is COD-336 item 3 as written: worse product on Windows is the honest trade,
   * because a boundary that holds on one OS is not a boundary.
   */
  availability(): SponsoredLocalAvailability {
    return sponsoredLocalAvailability(sponsoredContainment(this.deps.platform))
  }

  /**
   * What the consent screen will say, or a refusal.
   *
   * Computed BEFORE the accept — every field on it is already on the card or
   * derivable from this checkout — which is what lets a Decline write nothing
   * at all. The branch is minted here and carried into `accept`, so the branch
   * the screen NAMES is the branch that is cut: a screen saying "a branch will
   * be created" without saying which one is not describing the decision it is
   * asking about.
   */
  async consentFor(
    proposal: SponsoredProposal,
  ): Promise<
    | { ok: true; consent: SponsoredConsent; runId: string }
    | { ok: false; message: string }
  > {
    if (this.availability() !== 'available') {
      return {
        ok: false,
        message: 'Sponsored tasks cannot run on this machine.',
      }
    }
    if (this.active) {
      return { ok: false, message: 'A sponsored task is already running here.' }
    }
    // A folder that is not a repository has no worktree to isolate the run in,
    // and the card should never have offered an Accept for it -- the proposal
    // is keyed to a GitHub remote. Checked anyway: the command is reachable
    // without the card.
    if (!(await isGitRepository(this.projectRoot, this.deps.git))) {
      return {
        ok: false,
        message: 'A sponsored task needs a git repository to work in.',
      }
    }
    const runId = crypto.randomUUID()
    return {
      ok: true,
      runId,
      consent: {
        proposalId: proposal._id,
        advertiserName: proposal.advertiser_name,
        headline: proposal.headline,
        body: proposal.body,
        folder: this.projectRoot,
        branch: sponsoredBranchFor(
          sponsoredRunTitle(proposal.advertiser_name),
          runId,
        ),
      },
    }
  }

  /**
   * The user said yes. Accept upstream, cut the worktree, run it.
   *
   * `runId` is the one minted for the consent screen, so the branch that was
   * named is the branch that is cut. Passing a fresh one here would make the
   * screen a description of a different run.
   */
  async accept(
    proposal: SponsoredProposal,
    runId: string,
  ): Promise<SponsoredRunOutcome> {
    if (this.availability() !== 'available') {
      return {
        ok: false,
        message: 'Sponsored tasks cannot run on this machine.',
      }
    }
    // C-5: one accept per proposal. The card's `busy` flag covers the ordinary
    // double press; this covers a second command typed while the first is in
    // flight, which `busy` cannot see because it is set on a different tick.
    if (this.accepting || this.active) {
      return {
        ok: false,
        message: 'A sponsored task is already being started.',
      }
    }
    const authToken = this.deps.getToken()
    if (!authToken) {
      return {
        ok: false,
        message: 'Sign in to Freebuff to accept a sponsored task.',
      }
    }
    this.accepting = true
    this.set({
      phase: 'accepting',
      proposalId: proposal._id,
      advertiserName: proposal.advertiser_name,
      branch: null,
      worktreePath: null,
      prUrl: null,
      failureReason: null,
    })
    try {
      // ACCEPT IS IDEMPOTENT within the run token's TTL (COD-396): a retry from
      // the same caller returns the same payload with the same `runToken`. So
      // `status: 0` -- the deliberate non-status for a request that never
      // became an HTTP exchange at all -- is worth exactly one retry. Without
      // it a dropped connection strands a proposal upstream may already have
      // accepted, with a token nobody holds and no way to ask for it again.
      // ONLY status 0: a 409 or a 422 is an answer, and retrying an answer is
      // how one refusal becomes two.
      let accepted = await this.deps.accept(proposal._id, authToken)
      if (!accepted.ok && accepted.status === 0) {
        accepted = await this.deps.accept(proposal._id, authToken)
      }
      if (!accepted.ok) {
        this.set({ phase: 'idle', proposalId: null, advertiserName: null })
        return { ok: false, message: accepted.message }
      }

      // FROM HERE ON THE ROW IS ACCEPTED UPSTREAM. Anything that throws between
      // the accept and a live run STRANDS it: the card sits on `accepted` with
      // nothing behind it, forever, and no sweep finds it because there is no
      // run to find. So the failure is reported here rather than thrown away.
      const runToken = accepted.accept.runToken
      let worktree: SponsoredWorktree
      try {
        worktree = await createSponsoredWorktree(
          this.projectRoot,
          runId,
          sponsoredRunTitle(proposal.advertiser_name),
          this.deps.git,
        )
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Could not create a workspace.'
        await this.reportWith(
          proposal._id,
          runToken,
          authToken,
          {
            state: 'failed',
            failureReason:
              'The sponsored task could not be started on this machine. Nothing was changed in your project.',
            diagnosticReason: `workspace-failed${diagnosticCause(message)}`,
          },
          runId,
        )
        this.set({ phase: 'failed', failureReason: message })
        return { ok: false, message }
      }

      this.active = {
        proposalId: proposal._id,
        runToken,
        advertiserName:
          accepted.accept.advertiserName || proposal.advertiser_name,
        worktree,
        abort: new AbortController(),
        settled: false,
      }
      this.set({
        phase: 'running',
        branch: worktree.branch,
        worktreePath: worktree.path,
      })
      // `running` is reported when the TURN is about to start, not at the
      // accept: between the two sits worktree creation, and a card that said
      // "running" through a failed create is a card that lied.
      await this.report(authToken, { state: 'running' })

      void this.execute(authToken, accepted.accept.procedure, {
        advertiserLink:
          typeof accepted.accept.advertiserLink === 'string'
            ? sponsoredAdvertiserCtaHref(accepted.accept.advertiserLink)
            : null,
      })
      return { ok: true }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Could not start the sponsored task.'
      this.set({ phase: 'failed', failureReason: message })
      return { ok: false, message }
    } finally {
      this.accepting = false
    }
  }

  /**
   * The turn, and the verdict it earns.
   *
   * COMMITTED IS DECIDED BY GIT, not by watching the run's tool calls. The
   * question the card asks is "is there something for me to review", and the
   * only honest answer to that is whether the branch tip moved off its base. A
   * run that announced a commit it did not make, or made one through a path we
   * were not watching, is answered correctly either way.
   */
  private async execute(
    authToken: string,
    procedure: string,
    runtimeInputs: SponsoredProcedureRuntimeInputs = {},
  ): Promise<void> {
    const active = this.active
    if (!active?.worktree) return
    let errorText: string | null = null
    try {
      errorText = await this.deps.runTurn({
        prompt: buildSponsoredPrompt(procedure, runtimeInputs),
        worktree: active.worktree,
        runtimeDir: sponsoredRuntimeDir(
          this.projectRoot,
          runIdOf(active.worktree),
        ),
        proposalId: active.proposalId,
        signal: active.abort.signal,
      })
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error)
    }
    // An abort has already reported its own terminal state; a turn that
    // unwinds afterwards must not report a second one over it.
    if (active.settled) return
    const aborted = active.abort.signal.aborted
    const head = await sponsoredHead(
      active.worktree.path,
      active.worktree.baseRef,
      this.deps.git,
      this.deps.exists,
    )
    if (
      !aborted &&
      !errorText &&
      head.head &&
      head.head !== active.worktree.baseRef
    ) {
      active.settled = true
      await this.report(authToken, {
        state: 'committed',
        head: head.head,
        branch: active.worktree.branch,
      })
      this.set({ phase: 'committed' })
      return
    }
    active.settled = true
    // THE USER-FACING SENTENCE AND THE OPERATOR'S ARE DIFFERENT SENTENCES.
    // "freebuff.com was unreachable" and "git could not open /dev/null on this
    // Mac" reach the card as the same words and are entirely different bugs;
    // `diagnosticReason` is where they stop being the same row.
    const failureReason = aborted
      ? 'The sponsored task was interrupted before it finished.'
      : errorText
        ? 'The sponsored task failed. Nothing was pushed to your repository.'
        : 'The sponsored task finished without committing anything. Nothing was changed in your project.'
    await this.report(authToken, {
      state: 'failed',
      ...(head.head ? { head: head.head } : {}),
      failureReason,
      diagnosticReason: `turn ${
        aborted ? 'interrupted' : errorText ? 'error' : 'completed'
      }${diagnosticCause(errorText)}; ${head.diagnostic}`,
    })
    this.set({ phase: 'failed', failureReason })
  }

  /**
   * Ctrl-C, a quit, or a signal, mid-run.
   *
   * THE QUESTION WITH NO WEB EQUIVALENT. On Cloud the run is remote and closing
   * the tab leaves it to finish; here it is a process on the user's machine
   * that is going away, and the two things it must not leave behind are a row
   * stuck on `running` forever and a directory the user cannot account for.
   *
   * So: abort the turn, report a TERMINAL state, and hand back a sentence the
   * caller prints saying exactly what is on disk and how to remove it. The
   * worktree is KEPT in every case — it is the user's checkout on the user's
   * disk, and a process ending is not a reason to delete work.
   *
   * `settled` is set BEFORE the report, so the turn unwinding a moment later
   * does not report a second terminal state over this one — which upstream
   * would refuse 409 anyway, but only after the card had flickered.
   */
  async interrupt(
    reason: 'ctrl-c' | 'signal' | 'quit',
  ): Promise<{ interrupted: boolean; notice: string | null }> {
    const active = this.active
    if (!active || active.settled) return { interrupted: false, notice: null }
    active.settled = true
    active.abort.abort()
    const authToken = this.deps.getToken()
    if (authToken) {
      await this.report(authToken, {
        state: 'failed',
        failureReason:
          'The sponsored task was interrupted before it finished. Its workspace is still here.',
        diagnosticReason: `interrupted: ${reason}`,
      })
    }
    this.set({
      phase: 'failed',
      failureReason: 'The sponsored task was interrupted before it finished.',
    })
    const worktree = active.worktree
    this.active = null
    return {
      interrupted: true,
      notice: worktree
        ? [
            `The sponsored task from ${active.advertiserName} was interrupted.`,
            `Its workspace is still on disk at ${worktree.path}, on branch ${worktree.branch}.`,
            'Nothing was pushed. Remove it with /ads:remove-worktree, or keep it and look at what it did.',
          ].join('\n')
        : `The sponsored task from ${active.advertiserName} was interrupted before it created a workspace. Nothing was left behind.`,
    }
  }

  /**
   * The one push in the whole flow, and it happens on an explicit user action.
   *
   * `git push` then `gh pr create`, in that order and both explicit. `gh pr
   * create` will push a missing branch on its own, interactively — which in a
   * TUI is a prompt nobody sees rather than a push.
   *
   * NOT run through the sponsored broker. This is the USER's action with the
   * USER's credentials, which is the entire reason the run itself could not do
   * it: the broker exists to keep the advertiser's procedure away from `~/.ssh`
   * and `gh auth`, and the point of the command is that the user decided to
   * spend exactly one of those.
   */
  async createPullRequest(): Promise<SponsoredDeliveryOutcome> {
    const active = this.active
    if (!active?.worktree) {
      return {
        ok: false,
        message: 'There is no sponsored task to open a pull request for.',
      }
    }
    const { worktree } = active
    if (!this.deps.exists(worktree.path)) {
      return {
        ok: false,
        message:
          'The sponsored task’s workspace is gone, so there is nothing to open a pull request from.',
      }
    }
    // ONE PUSH AT A TIME.
    if (this.pushing) {
      return {
        ok: false,
        message: 'A pull request for this task is already being opened.',
      }
    }
    const authToken = this.deps.getToken()
    if (!authToken) {
      return {
        ok: false,
        message: 'Sign in to Freebuff to open a pull request.',
      }
    }
    this.pushing = true
    try {
      // THE GATE IS HERE, not only on the card. Recomputed the same way the
      // turn's verdict was — by asking git whether the branch tip moved off its
      // base — because a run's own account of itself is not evidence, and
      // because between then and now the user could have removed the workspace.
      const head = await sponsoredHead(
        worktree.path,
        worktree.baseRef,
        this.deps.git,
        this.deps.exists,
      )
      if (!head.head || head.head === worktree.baseRef) {
        return {
          ok: false,
          message:
            'The sponsored task has not committed anything, so there is nothing to open a pull request from.',
        }
      }
      // THE WORKTREE'S GITDIR POINTER IS ADVERTISER-WRITABLE. `<worktree>/.git`
      // is a file inside the worktree saying where the real gitdir is, and the
      // sandbox permits writing anywhere in the worktree — so a run can point it
      // at a repository of its own, with its own remote and its own hooks, and
      // the push below would go there.
      if (
        !(await gitdirUnmoved(this.projectRoot, worktree.path, this.deps.git))
      ) {
        return {
          ok: false,
          message:
            'This workspace no longer points at your repository, so nothing was pushed.',
        }
      }
      const env = noHooksEnv(this.projectRoot)
      const push = await this.deps.deliver(
        'git',
        [
          '-C',
          worktree.path,
          'push',
          '--set-upstream',
          'origin',
          worktree.branch,
        ],
        { cwd: worktree.path, env },
      )
      if (push.exitCode !== 0) {
        return {
          ok: false,
          message: firstLine(push.stderr) || 'Could not push the branch.',
        }
      }
      const create = await this.deps.deliver(
        'gh',
        [
          'pr',
          'create',
          '--head',
          worktree.branch,
          '--base',
          worktree.sourceBranch,
          '--title',
          `${active.advertiserName}: sponsored change`,
          '--body',
          SPONSORED_PR_BODY,
        ],
        { cwd: worktree.path, env },
      )
      const printed = (create.stdout.match(/https:\/\/\S+/) ?? [])[0]
      // Through the SHARED destination gate before it is reported or shown. The
      // state route refuses a `landed` whose `prUrl` does not survive
      // sanitization (422 `invalid_pr_url`) and the card refuses to render one
      // either — so a URL that fails here is one we would report, be refused
      // for, and then have nothing to print. Checking it on this side turns
      // that into one honest failure instead of a round trip.
      const prUrl = printed ? sponsoredPullRequestHref(printed) : null
      if (create.exitCode !== 0 || !prUrl) {
        return {
          ok: false,
          message:
            firstLine(create.stderr) ||
            (printed
              ? 'A pull request was opened, but its address could not be verified.'
              : 'Could not open a pull request.'),
        }
      }
      // ONE retry, and only on a request that never completed. A 422 means
      // upstream looked at this URL and refused it; sending the same URL again
      // gets the same answer.
      let landed = await this.reportResult(authToken, {
        state: 'landed',
        prUrl,
        branch: worktree.branch,
      })
      if (landed && !landed.ok && landed.status === 0) {
        landed = await this.reportResult(authToken, {
          state: 'landed',
          prUrl,
          branch: worktree.branch,
        })
      }
      this.set({ phase: 'landed', prUrl })
      return { ok: true, prUrl, recorded: landed?.ok === true }
    } finally {
      this.pushing = false
    }
  }

  /**
   * Remove the workspace the run left behind.
   *
   * Offered, never automatic. The commits survive it — they are on a branch in
   * the user's shared object store, which is one of the three reasons the clone
   * was rejected (#2725) — but the branch goes with it, so this is the user's
   * call rather than ours.
   */
  async removeWorktree(): Promise<{ ok: boolean; message: string }> {
    const active = this.active
    const worktree = active?.worktree ?? null
    if (!worktree) {
      return {
        ok: false,
        message: 'There is no sponsored workspace to remove.',
      }
    }
    if (this.snapshot.phase === 'running') {
      return {
        ok: false,
        message:
          'The sponsored task is still working. Interrupt it before removing its workspace.',
      }
    }
    try {
      await removeSponsoredWorktree(
        this.projectRoot,
        runIdOf(worktree),
        worktree.branch,
        this.deps.git,
      )
      this.active = null
      this.set({ phase: 'idle', worktreePath: null, branch: null })
      return { ok: true, message: `Removed ${worktree.path} and its branch.` }
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : 'Could not remove the workspace.',
      }
    }
  }

  // ------------------------------------------------------------------ private

  private async report(
    authToken: string,
    update: SponsoredStateUpdate,
  ): Promise<void> {
    const active = this.active
    if (!active) return
    await this.reportWith(
      active.proposalId,
      active.runToken,
      authToken,
      update,
      active.worktree ? runIdOf(active.worktree) : active.proposalId,
    )
  }

  private async reportWith(
    proposalId: string,
    runToken: string,
    authToken: string,
    update: SponsoredStateUpdate,
    runId: string = proposalId,
  ) {
    if (!TERMINAL_REPORT_STATES.has(update.state)) {
      return this.deps
        .reportState(proposalId, runToken, update, authToken)
        .catch((error) => {
          logger.debug({ error, update }, '[sponsored-run] state report failed')
          return { ok: false as const, status: 0, message: String(error) }
        })
    }
    const identified = {
      ...update,
      reportId: crypto.randomUUID(),
      runId,
    }
    const reports = this.readTerminalReports()
    const pending = reports.at(-1)
    if (
      pending?.proposalId === proposalId &&
      pending.update.runId === runId &&
      terminalReportPayload(pending.update) === terminalReportPayload(update)
    ) {
      return this.flushTerminalReports(true)
    }
    reports.push({
      proposalId,
      runToken,
      update: identified,
      attempts: 0,
      nextDueAt: this.deps.now(),
      lastError: null,
      disposition: 'pending',
    })
    // Persist the terminal intent before waiting on any earlier HTTP request.
    this.writeTerminalReports(reports)
    return this.flushTerminalReports(true)
  }

  private async reportResult(authToken: string, update: SponsoredStateUpdate) {
    const active = this.active
    if (!active) return null
    return this.reportWith(
      active.proposalId,
      active.runToken,
      authToken,
      update,
      active.worktree ? runIdOf(active.worktree) : active.proposalId,
    )
  }

  private readTerminalReports(): DurableTerminalReport[] {
    const raw = this.deps.terminalReports.read()
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as DurableTerminalReport[]) : []
    } catch {
      return []
    }
  }

  private writeTerminalReports(reports: DurableTerminalReport[]): void {
    this.deps.terminalReports.write(JSON.stringify(reports))
  }

  private flushTerminalReports(force: boolean) {
    const result = this.terminalReportFlushChain.then(() =>
      this.flushTerminalReportsSerial(force),
    )
    this.terminalReportFlushChain = result.then(
      () => undefined,
      (error) => {
        logger.debug({ error }, '[sponsored-run] terminal report flush failed')
      },
    )
    return result
  }

  private async flushTerminalReportsSerial(force: boolean) {
    let reports = this.readTerminalReports()
    let last = null
    for (const report of reports) {
      if (report.disposition && report.disposition !== 'pending') continue
      if (!force && report.nextDueAt > this.deps.now()) {
        this.scheduleTerminalRetry(report.nextDueAt)
        return last
      }
      const authToken = this.deps.getToken()
      if (!authToken) {
        this.scheduleTerminalRetry(
          this.deps.now() + TERMINAL_REPORT_RETRY_MAX_MS,
        )
        return last
      }
      last = await this.deps
        .reportState(
          report.proposalId,
          report.runToken,
          report.update,
          authToken,
        )
        .catch((error) => ({
          ok: false as const,
          status: 0,
          message: error instanceof Error ? error.message : String(error),
        }))
      // A new terminal intent may have been appended while HTTP was pending.
      // Update or remove only this report from the latest durable snapshot.
      reports = this.readTerminalReports()
      const reportIndex = reports.findIndex(
        (candidate) => candidate.update.reportId === report.update.reportId,
      )
      if (reportIndex < 0) continue
      reports[reportIndex] = report
      if (!last.ok) {
        report.attempts += 1
        report.lastError = last.message
        if (isPermanentReportRefusal(last.status)) {
          report.disposition = 'permanent_refusal'
          this.writeTerminalReports(reports)
          continue
        }
        if (report.attempts >= TERMINAL_REPORT_MAX_ATTEMPTS) {
          report.disposition = 'exhausted'
          this.writeTerminalReports(reports)
          continue
        }
        report.disposition = 'pending'
        report.nextDueAt =
          this.deps.now() +
          Math.min(
            2 ** Math.min(report.attempts, 8) * 1_000,
            TERMINAL_REPORT_RETRY_MAX_MS,
          )
        this.writeTerminalReports(reports)
        this.scheduleTerminalRetry(report.nextDueAt)
        return last
      }
      reports = reports.filter(
        (candidate) => candidate.update.reportId !== report.update.reportId,
      )
      this.writeTerminalReports(reports)
    }
    return last
  }

  private scheduleTerminalRetry(dueAt: number): void {
    if (this.reportRetryTimer) clearTimeout(this.reportRetryTimer)
    this.reportRetryTimer = setTimeout(
      () => {
        this.reportRetryTimer = null
        void this.flushTerminalReports(false)
      },
      Math.max(
        0,
        Math.min(dueAt - this.deps.now(), TERMINAL_REPORT_RETRY_MAX_MS),
      ),
    )
    this.reportRetryTimer.unref?.()
  }
}

function isPermanentReportRefusal(status: number): boolean {
  return (
    status >= 400 &&
    status < 500 &&
    status !== 401 &&
    status !== 408 &&
    status !== 429
  )
}

/** The run id is the worktree's directory name — one place it is written down. */
function runIdOf(worktree: SponsoredWorktree): string {
  return path.basename(worktree.path)
}

/**
 * The environment the two delivery commands run with.
 *
 * The RUN's commands go through the sandbox broker, which builds its own
 * environment from an allowlist. These do NOT — this is the user's own action
 * with the user's own credentials, which is the entire reason the run could not
 * do it. So the environment is inherited, minus one thing: HOOKS.
 *
 * A `pre-push` hook is a script in a directory the advertiser's run could write,
 * executing on this machine as the user, triggered by a command that says
 * "create a pull request". The run's own commits are already made with hooks
 * disabled (COD-336 item 7); the delivery push was not.
 */
export function noHooksEnv(
  projectRoot: string,
): Record<string, string | undefined> {
  return {
    // Through the CLI's own accessor rather than `process.env` directly, which
    // `scripts/check-env-architecture.ts` refuses in this package. The point of
    // that rule is that every environment read has one seam; this one INHERITS
    // deliberately, and the two lines below are the whole of what it removes.
    ...getSystemProcessEnv(),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    // A directory we never create, under the app's own namespace in the PROJECT
    // root — outside the worktree, and therefore outside everything the sandbox
    // lets the run write. A path in the system temp directory would be
    // creatable by anything else running as this user.
    GIT_CONFIG_VALUE_0: path.join(projectRoot, '.freebuff', 'no-hooks'),
  }
}

const SPONSORED_PR_BODY = [
  'Opened from the Freebuff CLI at the repository owner’s request.',
  '',
  'The commits on this branch were written by a sponsored task an advertiser',
  'authored and the repository owner accepted. They ran in an isolated worktree',
  'with no access to the machine’s credentials, and nothing was pushed until the',
  'owner asked for this pull request.',
].join('\n')

// --------------------------------------------------------------- the SDK turn

/** The one shape a refused tool call takes, so every refusal reads the same. */
function refusal(message: string) {
  return [{ type: 'json' as const, value: { errorMessage: message } }]
}

/**
 * The write-tool guard: worktree bound, symlink resolved, then the path CLASSES
 * the pull request would not show.
 *
 * Two checks rather than one because they answer different questions. The first
 * is "does this land inside the worktree" and is answered against the
 * FILESYSTEM, which is the only thing that can see a symlink. The second is "is
 * this a file whose effect the user's review would never reach" — `.git`
 * internals, CI configuration, credential files — and is a lexical class check,
 * shared verbatim with Cloud and Desktop so all three refuse the same paths.
 *
 * The shell is NOT bounded here; it is bounded by the broker. That split is the
 * whole COD-336 argument: a path table is consulted by three tool names, and
 * `echo x > .git/hooks/pre-commit` is not one of them.
 */
export function sponsoredWriteGuard(
  workspaceRoot: string,
  requestedPath: string | null,
): string | null {
  if (!requestedPath)
    return 'Sponsored runs must name the file they are writing.'
  const classified = evaluateSponsoredWritePath(requestedPath, {
    workspaceRoot,
  })
  if (!classified.allowed) return classified.message
  try {
    assertSponsoredWritePath(workspaceRoot, classified.path)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return null
}

/**
 * The read clamp, applied per tool before the tool runs.
 *
 * WHY IT EXISTS AT ALL is the whole of the COD-397 F1 finding: the OS sandbox
 * covers exactly ONE tool. It is a `TerminalCommandBroker`, so it is consulted
 * by `run_terminal_command` and by nothing else. `read_files`, `code_search`,
 * `list_directory` and `glob` execute in the CLI's own process, as the user,
 * with the user's whole environment — and the SDK resolves an absolute path
 * as-is (`sdk/src/tools/path-utils.ts`). So a procedure containing no shell
 * command at all could read the user's private keys and hand them to the
 * granted `read_url`.
 *
 * `glob` is clamped defensively: it is contained by construction today, and the
 * clamp means a future implementation that resolves `cwd` cannot widen the
 * boundary silently.
 */
export function sponsoredReadGuard(
  workspaceRoot: string,
  requestedPath: string | null | undefined,
): string | null {
  if (requestedPath === undefined || requestedPath === null) return null
  if (typeof requestedPath !== 'string' || requestedPath.trim() === '') {
    return 'Sponsored runs must name the path they are reading.'
  }
  try {
    assertSponsoredReadPath(workspaceRoot, requestedPath)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return null
}

/**
 * `overrideTools` for a sponsored turn.
 *
 * Exported so the clamps can be asserted directly rather than only through a
 * live run: every entry here is a boundary, and a boundary that is only
 * exercised end-to-end is a boundary nobody tests.
 */
export function sponsoredOverrideTools(context: SponsoredTurnContext) {
  const workspaceRoot = context.worktree.path
  const processBroker = createSponsoredCodeSearchBroker({
    workspaceRoot,
    runtimeDir: context.runtimeDir,
    linkedWorktree: context.worktree.linked,
  })
  const rootedFs = createSponsoredRootedFileSystem({
    workspaceRoot,
    runtimeDir: context.runtimeDir,
    processBroker,
  })
  return {
    read_files: async (input: {
      filePaths: string[]
      fileWindows?: Record<string, FileReadWindow[]>
    }) => {
      const out: Record<string, string | null> = {}
      const allowed: string[] = []
      for (const filePath of input.filePaths ?? []) {
        const refused = sponsoredReadGuard(workspaceRoot, filePath)
        // A NAMED refusal in the slot the content would occupy. `getFiles`
        // answers a missing file with a status string in exactly this shape, so
        // the run reads a sentence rather than an absence and does not retry
        // the same path three more ways.
        if (refused) out[filePath] = refused
        else allowed.push(filePath)
      }
      if (allowed.length > 0) {
        Object.assign(
          out,
          await getFiles({
            filePaths: allowed,
            cwd: workspaceRoot,
            fs: rootedFs,
            ...(input.fileWindows ? { fileWindows: input.fileWindows } : {}),
          }),
        )
      }
      return out
    },
    code_search: async (input: {
      pattern: string
      flags?: string
      cwd?: string
      max_results?: number
    }) => {
      const refused = sponsoredReadGuard(workspaceRoot, input.cwd)
      if (refused) return refusal(refused)
      const flagsRefused = sponsoredCodeSearchFlagsRefusal(input.flags)
      if (flagsRefused) return refusal(flagsRefused)
      return codeSearch({
        projectPath: workspaceRoot,
        pattern: input.pattern,
        ...(input.flags ? { flags: input.flags } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.max_results !== undefined
          ? { maxResults: input.max_results }
          : {}),
        signal: context.signal,
        processBroker,
      })
    },
    list_directory: async (input: { path: string }) => {
      const refused = sponsoredReadGuard(workspaceRoot, input.path)
      if (refused) return refusal(refused)
      return listDirectory({
        directoryPath: input.path,
        projectPath: workspaceRoot,
        fs: rootedFs,
      })
    },
    glob: async (input: {
      pattern: string
      cwd?: string
      max_results?: number
    }) => {
      const refused = sponsoredReadGuard(workspaceRoot, input.cwd)
      if (refused) return refusal(refused)
      return glob({
        pattern: input.pattern,
        projectPath: workspaceRoot,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.max_results !== undefined
          ? { maxResults: input.max_results }
          : {}),
        fs: rootedFs,
      })
    },
    // The SDK routes both write_file and str_replace through this override.
    write_file: async (input: unknown) => {
      const refused = sponsoredWriteGuard(workspaceRoot, fileToolPath(input))
      if (refused) return refusal(refused)
      return changeFile({
        parameters: input,
        cwd: workspaceRoot,
        fs: rootedFs,
      })
    },
    apply_patch: async (input: unknown) => {
      const refused = sponsoredWriteGuard(workspaceRoot, fileToolPath(input))
      if (refused) return refusal(refused)
      return applyPatchTool({
        parameters: input,
        cwd: workspaceRoot,
        fs: rootedFs,
      })
    },
    run_terminal_command: async (input: {
      command: string
      process_type?: 'SYNC' | 'BACKGROUND'
      cwd?: string
      timeout_seconds?: number
    }) => {
      const decision = evaluateSponsoredLocalToolCall(
        'run_terminal_command',
        SPONSORED_LOCAL_V1_GRANT,
      )
      if (!decision.allowed) return refusal(decision.message)
      // The one refusal here that is a PRODUCT decision rather than a
      // containment one: a postinstall script runs outside the tool loop
      // entirely, so a run that installs is a run whose diff the user cannot
      // review (COD-336 decision item 5).
      if (commandInstallsDependencies(input.command)) {
        return refusal(SPONSORED_LOCAL_INSTALL_REFUSAL)
      }
      return runTerminalCommand({
        command: input.command,
        process_type: input.process_type ?? 'SYNC',
        cwd: path.resolve(workspaceRoot, input.cwd ?? '.'),
        timeout_seconds: input.timeout_seconds ?? 30,
        signal: context.signal,
        // The BROKER is what bounds a sponsored shell. It also discards the
        // environment it is handed and builds its own, which is why no scrubbed
        // `env` is passed alongside: `runTerminalCommand` merges
        // `getSystemProcessEnv()` into every request before a broker sees it,
        // so scrubbing anywhere but inside the broker would be scrubbing
        // something that is put back.
        terminalCommandBroker: processBroker,
      })
    },
  }
}

function fileToolPath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const value = input as { path?: unknown; operation?: { path?: unknown } }
  if (typeof value.path === 'string') return value.path
  return typeof value.operation?.path === 'string' ? value.operation.path : null
}

/**
 * The real turn: the CLI's own client, pointed at the worktree, with the
 * narrowed agent and every clamp above.
 *
 * `customToolDefinitions` and `agentDefinitions` are BOTH empty, and neither is
 * redundant. Stripping a custom tool from `toolNames` only stops it being
 * OFFERED — the SDK dispatches a registered custom tool by name ahead of every
 * builtin branch — and a local `.agents/` definition is repository-authored
 * content that a sponsored run has no business loading.
 */
export async function runSponsoredTurn(
  context: SponsoredTurnContext,
): Promise<string | null> {
  const client = await getCodebuffClient()
  if (!client) return 'Not signed in.'
  const agentId = getAgentIdForMode('LITE')
  try {
    await client.run({
      agent: sponsoredAgentDefinition({
        agentId,
        ...(IS_FREEBUFF ? { model: getSelectedFreebuffModel() } : {}),
        isFreebuff: IS_FREEBUFF,
      }),
      prompt: context.prompt,
      cwd: context.worktree.path,
      signal: context.signal,
      agentDefinitions: [],
      customToolDefinitions: [],
      overrideTools: sponsoredOverrideTools(context) as never,
      ...(IS_FREEBUFF ? { costMode: 'free' as const } : {}),
      // The marker says the run is sponsored; where it is BILLED is the
      // server's answer to give. HONEST LIMIT: no server route reads this field
      // today. The metering that would route the cost to the advertiser's
      // campaign is COD-119's and is not built, so a local sponsored run takes
      // the ORDINARY path and the user's own session and credits pay for it —
      // which is the decision (Owen, 2026-09-03), and which is what the card
      // says. Sent regardless, so the day the metering is built there is
      // nothing to remember to add here.
      extraCodebuffMetadata: {
        freebuff_sponsored_proposal_id: context.proposalId,
      },
      // A sponsored run is unattended, so its stream goes to the log rather
      // than into the user's transcript: the card is the surface for it, and
      // interleaving an advertiser's tool calls with the user's own answer is
      // how the two stop being distinguishable.
      handleEvent: () => {},
    } as never)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function terminalReportStore(
  projectRoot: string,
): SponsoredRunDeps['terminalReports'] {
  const canonicalRoot = realpathSync(projectRoot)
  const repoKey = createHash('sha256').update(canonicalRoot).digest('hex')
  const directory = path.join(getConfigDir(), 'sponsored-terminal-reports')
  const target = path.join(directory, `${repoKey}.json`)
  return {
    read: () => {
      try {
        return readFileSync(target, 'utf8')
      } catch {
        return null
      }
    },
    write: (value) => {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const temporary = path.join(directory, `.${repoKey}.${randomUUID()}.tmp`)
      try {
        writeFileSync(temporary, value, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        })
        renameSync(temporary, target)
      } catch (error) {
        try {
          unlinkSync(temporary)
        } catch {}
        throw error
      }
    },
  }
}

export const defaultSponsoredRunDeps = (
  projectRoot: string,
): SponsoredRunDeps => ({
  accept: acceptSponsoredProposal,
  reportState: reportSponsoredRunState,
  getToken: getAuthToken,
  git: bunGitRunner,
  exists: existsSync,
  platform: process.platform,
  runTurn: runSponsoredTurn,
  deliver: async (command, args, options) => {
    try {
      const proc = Bun.spawn([command, ...args], {
        cwd: options.cwd,
        env: options.env as Record<string, string>,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { exitCode, stdout, stderr }
    } catch (error) {
      return {
        exitCode: -1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      }
    }
  },
  now: Date.now,
  terminalReports: terminalReportStore(projectRoot),
})

let instance: SponsoredRun | null = null

/** The process's one sponsored run. Null until a project root exists. */
export function sponsoredRunFor(projectRoot: string): SponsoredRun {
  if (!instance) {
    instance = new SponsoredRun(
      projectRoot,
      defaultSponsoredRunDeps(projectRoot),
    )
  }
  return instance
}

export function currentSponsoredRun(): SponsoredRun | null {
  return instance
}

/** Test-only. */
export function setSponsoredRunInstance(run: SponsoredRun | null): void {
  instance = run
}
