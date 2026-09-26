/**
 * Accepting a sponsored proposal and running it here, IN PLACE, as a turn in
 * this conversation (COD-339, ported to #3989's in-place flow).
 *
 * The whole of the CLI's execution half in one object: consent, the funded
 * Accept, the turn's plan, the verdict, every state report that follows, the
 * interrupt, and the undo. One file because it is one decision -- "run an
 * advertiser's procedure against the user's working copy" -- and a decision
 * spread across the commands that happen to trigger it is a decision nobody
 * can review.
 *
 * ## In place, and what that gave up
 *
 * The run used to get a linked worktree, a branch, a commit and a pull request
 * the user asked for. It now edits the folder the user is in, commits nothing,
 * and is undone by `/ads:undo`. The trade is written down in the 2026-09-24
 * amendment to `docs/freebuff-sponsored-local-execution.md`; this file carries
 * it out: `.git` is read-only to the run (`readOnlyGitDir` on the SDK broker
 * plus the git-subcommand refusal), secret-bearing files are unreadable, and
 * every file-tool write is receipted so the undo can put it back
 * (`sponsored-receipts.ts`).
 *
 * ## What it does NOT own
 *
 * The trust boundary. That is COD-336's, enforced in
 * `common/src/ads/sponsored-local-execution.ts`, `sponsored-capabilities.ts`
 * and the SDK broker. This file CONSUMES it: it asks whether this machine can
 * contain a run, refuses when the answer is no, and hands the SDK a run built
 * from the local grant.
 *
 * Nor does it own the TURN. Chat runs it (`use-send-message.ts`), because only
 * chat can put it in the transcript and hold the user's next message in the
 * queue behind it. This object hands chat a plan (`startTurn`) and is told how
 * it ended (`settleTurn`).
 *
 * ## Consent, and why a terminal draws it differently
 *
 * COD-336 decision item 4 requires per-run consent drawn by the ELECTRON MAIN
 * PROCESS. There is no Electron here and no second process to draw a window
 * from, so the terminal equivalent is an in-TUI confirmation naming the
 * advertiser and what will happen, which the user can refuse. That is an
 * ADAPTATION of the decision, not a re-opening of it: what item 4 buys is
 * SUPERVISION, and the mechanism beside it is the same SDK broker Desktop
 * uses. What does not transfer is the separate-process property, and a
 * compromised CLI could equally just run the procedure, which is why that
 * property was never load-bearing on a single-process surface.
 *
 * ## The order
 *
 * preview -> consent -> accept -> (queue) -> turn -> verdict.
 *
 * The preview is a read, so the consent can show the exact reviewed procedure
 * and bind its SHA-256 without changing any state. The Accept comes AFTER the
 * consent because a Decline has to leave the proposal `offered`.
 *
 * ## Reporting
 *
 * `running` is advisory and swallowed. A TERMINAL report is persisted to a
 * private outbox before it is sent and retried until it is delivered or
 * refused outright: until it lands the row sits on `running` and its compute
 * grant stays live.
 */
import {
  SPONSORED_LOCAL_INSTALL_REFUSAL,
  SPONSORED_LOCAL_V1_GRANT,
  commandInstallsDependencies,
  evaluateSponsoredLocalToolCall,
  sponsoredCommandRefusal,
  sponsoredGitRefusal,
  sponsoredLocalAvailability,
  sponsoredRefusedCommand,
  sponsoredRefusedGitSubcommand,
} from '@codebuff/common/ads/sponsored-local-execution'
import {
  evaluateSponsoredReadPath,
  evaluateSponsoredWritePath,
} from '@codebuff/common/ads/sponsored-capabilities'
import type { SponsoredProcedureRuntimeInputs } from '@codebuff/common/ads/sponsored-procedure-inputs'
import { sponsoredAdvertiserCtaHref } from '@codebuff/common/ads/sponsored-proposal-view'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { createHash, randomUUID } from 'node:crypto'
import { release } from 'node:os'
import path from 'path'

import { applyPatchTool } from '../../../sdk/src/tools/apply-patch'
import { changeFile } from '../../../sdk/src/tools/change-file'
import { codeSearch } from '../../../sdk/src/tools/code-search'
import { glob } from '../../../sdk/src/tools/glob'
import { listDirectory } from '../../../sdk/src/tools/list-directory'
import { getFiles } from '../../../sdk/src/tools/read-files'
import { runTerminalCommand } from '../../../sdk/src/tools/run-terminal-command'
import { createSponsoredRootedFileSystem } from '../../../sdk/src/tools/sponsored-rooted-filesystem'
import {
  assertSponsoredReadPath,
  assertSponsoredWritePath,
  createSponsoredCodeSearchBroker,
  sponsoredCodeSearchFlagsRefusal,
  sponsoredContainment,
} from '../../../sdk/src/tools/sponsored-sandbox'
import { useSponsoredRunStore } from '../state/sponsored-run-store'
import { getAuthToken } from './auth'
import { getConfigDir } from './config-dir'
import { IS_FREEBUFF } from './constants'
import { getAgentIdForMode } from './freebuff-agent-selection'
import { logger } from './logger'
import {
  buildSponsoredPrompt,
  sponsoredAgentDefinition,
} from './sponsored-agent'
import { sponsoredRuntimeDir } from './sponsored-git'
import {
  acceptSponsoredProposal,
  previewSponsoredProposal,
  reportSponsoredRunState,
  sponsoredProcedureSha256,
} from './sponsored-proposal-api'
import { sponsoredProposalLocalTarget } from './sponsored-proposal-target'
import {
  SponsoredEditRecorder,
  SponsoredReceiptRefusal,
  changedReceipts,
  readSponsoredLedger,
  sponsoredOutcomesFromReceipts,
  sponsoredReceiptStore,
  undoSponsoredReceipts,
} from './sponsored-receipts'

import type {
  SponsoredAcceptPreview,
  SponsoredCliExecutionSurface,
  SponsoredProposal,
  SponsoredStateUpdate,
} from './sponsored-proposal-api'
import type { SponsoredReceiptStore } from './sponsored-receipts'
import { sponsoredComputeRunDeadlineMs } from '@codebuff/common/ads/sponsored-compute-contract'
import type { SponsoredComputeGrant } from '@codebuff/common/ads/sponsored-compute-contract'
import type { SponsoredLocalTarget } from '@codebuff/common/ads/sponsored-capability'
import type {
  SponsoredLocalAvailability,
  SponsoredLocalContainment,
} from '@codebuff/common/ads/sponsored-local-execution'
import type { FileReadWindow } from '@codebuff/common/types/contracts/client'
import type { AgentDefinition, OverrideToolHandlers } from '@codebuff/sdk'

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
  /** Exact reviewed procedure returned by the server preview. */
  procedure: string
  /** Whole user messages that established why this offer is relevant. */
  taskContext: readonly string[]
  /** The folder whose files the run will edit, in place. */
  folder: string
}

export type SponsoredRunPhase =
  | 'idle'
  | 'accepting'
  /** Accepted upstream; waiting for the conversation to be free. */
  | 'queued'
  | 'running'
  | 'delivered'
  | 'failed'

/** What the transcript and the dock read while a run is in flight or over. */
export type SponsoredRunSnapshot = {
  phase: SponsoredRunPhase
  proposalId: string | null
  advertiserName: string | null
  runId: string | null
  /** The files the run changed, once it has a verdict. */
  changedFiles: readonly string[]
  failureReason: string | null
  undone: boolean
}

const IDLE: SponsoredRunSnapshot = {
  phase: 'idle',
  proposalId: null,
  advertiserName: null,
  runId: null,
  changedFiles: [],
  failureReason: null,
  undone: false,
}

export type SponsoredRunOutcome =
  | { ok: true }
  | { ok: false; declined: true }
  | {
      ok: false
      message: string
      /**
       * The procedure changed after review. The consent is shown again with
       * the new text rather than the refusal being left on the card.
       */
      reviewAgain?: boolean
    }

/** Everything chat needs to run the sponsored turn. */
export type SponsoredTurnPlan = {
  runId: string
  proposalId: string
  advertiserName: string
  prompt: string
  agent: AgentDefinition
  overrideTools: SponsoredOverrideTools
  extraCodebuffMetadata: Record<string, string>
  /** Aborted by an interrupt or by the grant expiring. Chat links its own to it. */
  signal: AbortSignal
  cwd: string
}

/** How chat says the turn ended. */
export type SponsoredTurnResult = {
  errorText: string | null
  aborted: boolean
}

/** Injected so every decision below is testable without a network or a checkout. */
export type SponsoredRunDeps = {
  preview: typeof previewSponsoredProposal
  accept: typeof acceptSponsoredProposal
  reportState: typeof reportSponsoredRunState
  getToken: () => string | null | undefined
  platform: NodeJS.Platform
  containment: (platform: NodeJS.Platform) => SponsoredLocalContainment
  /** `cli_macos` / `cli_linux` / `cli_wsl`; null where no run can happen. */
  executionSurface: () => SponsoredCliExecutionSurface | null
  now: () => number
  sleep: (ms: number) => Promise<void>
  terminalReports: {
    read: () => string | null
    write: (value: string) => void
  }
  receipts: SponsoredReceiptStore
  /** The last run in this project, so `/ads:undo` survives a restart. */
  lastRun: {
    read: () => string | null
    write: (runId: string) => void
  }
  /** Re-read this rooted identity before the paid accept. */
  target: () => Promise<SponsoredLocalTarget | null>
  /** Builds the tool overrides; injected so a test need not start a sandbox. */
  overrideTools?: (context: SponsoredToolContext) => SponsoredOverrideTools
  agentId?: () => string
}

function sameTarget(
  left: SponsoredLocalTarget,
  right: SponsoredLocalTarget,
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === 'repo'
      ? left.repoFullName ===
        (right as Extract<SponsoredLocalTarget, { kind: 'repo' }>).repoFullName
      : left.workspaceId ===
        (right as Extract<SponsoredLocalTarget, { kind: 'workspace' }>)
          .workspaceId)
  )
}

type DurableTerminalReport = {
  proposalId: string
  runToken: string
  update: SponsoredStateUpdate
  attempts: number
  nextDueAt: number
  lastError: string | null
  /**
   * `exhausted` is only ever READ now: builds before the attempt cap was
   * removed wrote it after eight transient failures and never sent the report
   * again. It is resent like `pending`, because a report that was merely
   * offline is still owed upstream.
   */
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
    outcomes: update.outcomes,
  })
}

const TERMINAL_REPORT_STATES = new Set([
  'delivered',
  'committed',
  'failed',
  'landed',
])
/**
 * The backoff ceiling, and the ONLY limit on a transient retry. There is no
 * attempt cap: a terminal report is what ends the run upstream and revokes its
 * compute grant, so giving up on one leaves the card on `running` forever. A
 * report stops only when it is delivered or refused outright
 * (`isPermanentReportRefusal`) -- the same rule Desktop's outbox keeps.
 */
const TERMINAL_REPORT_RETRY_MAX_MS = 5 * 60_000

/**
 * The funded Accept's retry schedule: Desktop's first four attempts
 * (`freebuff-desktop/src/server/services/sponsored-run.ts`). The Accept is
 * idempotent per run id within the token's TTL, so a retry after a lost
 * response returns the same token rather than charging twice.
 */
export const ACCEPT_RETRY_DELAYS_MS = [1_000, 3_000, 9_000] as const

/** A refusal worth asking again: nothing answered, or upstream was busy. */
function retryableAcceptStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500
}

export type SponsoredTaskEvidence = {
  /** A bounded identity, never sent as telemetry. */
  identity: string
  messages: readonly string[]
}

const SPONSORED_TASK_MESSAGES_MAX = 8
const SPONSORED_TASK_CONTEXT_MAX = 8_192

/**
 * Retain whole user messages only. This is the context the terminal consent
 * actually reviewed, and it is re-read before the paid acceptance.
 */
export function sponsoredTaskEvidence(
  messages: readonly { variant: string; content: string }[],
): SponsoredTaskEvidence | null {
  const selected = messages
    .filter((message) => message.variant === 'user')
    .map((message) => message.content.trim())
    .filter(Boolean)
    .slice(-SPONSORED_TASK_MESSAGES_MAX)
  if (
    !selected.length ||
    selected.at(-1)!.length > SPONSORED_TASK_CONTEXT_MAX
  ) {
    return null
  }
  const whole: string[] = []
  let size = 0
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const message = selected[index]!
    if (size + message.length > SPONSORED_TASK_CONTEXT_MAX) break
    whole.unshift(message)
    size += message.length
  }
  if (!whole.length) return null
  return { messages: whole, identity: JSON.stringify(whole) }
}

/**
 * The note the conversation's OWN agent is handed on its next turn.
 *
 * The sponsored turn ran with fresh memory and wrote none back, so the agent
 * the user is talking to has no idea these files moved. Mirrors Desktop's
 * `sponsoredChangesBrief` (`freebuff-desktop/src/server/services/briefs.ts`).
 */
export function sponsoredChangesBrief(
  advertiserName: string,
  changedFiles: readonly string[],
): string {
  const shown = changedFiles.slice(0, SPONSORED_BRIEF_MAX_FILES)
  const rest = changedFiles.length - shown.length
  return [
    '<sponsored_changes>',
    `A sponsored task from ${advertiserName}, which the user accepted in this conversation, has just edited these files in the working copy. It ran with its own context; you did not see it happen.`,
    'Read any of them before relying on what you remember about them. The user may keep or undo these changes.',
    '',
    ...shown.map((file) => `- ${file}`),
    ...(rest > 0 ? [`- …and ${rest} more`] : []),
    '</sponsored_changes>',
  ].join('\n')
}

/** And the note after an undo, so the agent does not rely on the edits. */
export function sponsoredUndoBrief(
  advertiserName: string,
  restored: readonly string[],
): string {
  const shown = restored.slice(0, SPONSORED_BRIEF_MAX_FILES)
  const rest = restored.length - shown.length
  return [
    '<sponsored_changes>',
    `The user undid the sponsored task from ${advertiserName}. These files were put back to what they were before it ran:`,
    '',
    ...shown.map((file) => `- ${file}`),
    ...(rest > 0 ? [`- …and ${rest} more`] : []),
    '</sponsored_changes>',
  ].join('\n')
}

const SPONSORED_BRIEF_MAX_FILES = 20

/** How many changed paths the transcript names before summarising the rest. */
const SPONSORED_NOTICE_MAX_FILES = 6

/**
 * The transcript line that closes a sponsored turn: what it changed and how to
 * take it back, or why nothing changed. Written for the user, from the same
 * snapshot the dock draws.
 */
export function sponsoredVerdictNotice(snapshot: SponsoredRunSnapshot): string {
  const who = snapshot.advertiserName ?? 'The sponsor'
  if (snapshot.phase === 'delivered') {
    const files = snapshot.changedFiles
    const shown = files.slice(0, SPONSORED_NOTICE_MAX_FILES)
    const rest = files.length - shown.length
    return [
      `${who} changed ${files.length === 1 ? '1 file' : `${files.length} files`} in this folder: ${shown.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}.`,
      'Nothing was committed. Review the changes with `git diff`, and undo them with /ads:undo.',
    ].join('\n')
  }
  return snapshot.failureReason ?? 'The sponsored task did not finish.'
}

/**
 * A sponsored run, from the Accept to its verdict and undo.
 *
 * ONE AT A TIME, process-wide. A terminal has one project and one user, and two
 * concurrent advertiser procedures in the same working copy would race each
 * other's edits. It is a field rather than a queue because the honest answer
 * to "accept a second one" is "not while this is running", said out loud.
 */
export class SponsoredRun {
  private snapshot: SponsoredRunSnapshot = IDLE
  private readonly listeners = new Set<(s: SponsoredRunSnapshot) => void>()

  /** Set from the Accept until the verdict is reported. */
  private active: {
    proposalId: string
    runId: string
    runToken: string
    computeGrant: SponsoredComputeGrant
    advertiserName: string
    procedure: string
    taskContext: readonly string[]
    runtimeInputs: SponsoredProcedureRuntimeInputs
    recorder: SponsoredEditRecorder
    abort: AbortController
    expiryTimer: ReturnType<typeof setTimeout> | null
    /** True once a terminal state has been reported. Interrupts read it. */
    settled: boolean
  } | null = null

  private accepting = false
  private prepared: {
    proposalId: string
    runId: string
    preview: SponsoredAcceptPreview
    task: SponsoredTaskEvidence
    target: SponsoredLocalTarget
  } | null = null
  private reportRetryTimer: ReturnType<typeof setTimeout> | null = null
  private terminalReportFlushChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly projectRoot: string,
    private readonly deps: SponsoredRunDeps,
  ) {
    void this.flushTerminalReports(false)
  }

  /**
   * Send whatever an earlier process left in the outbox for this project.
   *
   * The constructor already does this, but the run is built lazily -- at the
   * first Accept -- so a report a crashed or signed-out CLI could not deliver
   * used to wait for the user's NEXT sponsored task in this folder, which may
   * never come. Chat calls this on every signed-in mount instead: at launch,
   * and again after a sign-in, since the chat surface only mounts once there
   * is a session. Due-time respecting, so a mount inside a backoff window
   * sends nothing early.
   */
  flushPendingReports(): void {
    void this.flushTerminalReports(false)
  }

  /** The project this run was built for. */
  get root(): string {
    return this.projectRoot
  }

  /** Nothing being accepted, queued or running: safe to replace for another root. */
  get idle(): boolean {
    return !this.accepting && (this.active === null || this.active.settled)
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
   * UNLIKE DESKTOP there is no `no-consent-bridge` arm: the CLI's confirmation
   * is drawn by the same process that would run the task, so it is present
   * exactly when the CLI is. Windows is `unavailable:windows-no-containment`;
   * the COD-642 floor is Desktop's arm and is never offered here.
   */
  availability(): SponsoredLocalAvailability {
    return sponsoredLocalAvailability(this.deps.containment(this.deps.platform))
  }

  /**
   * What the consent screen will say, or a refusal.
   *
   * Reads the exact reviewed procedure through the preview route -- a read, so
   * a Decline afterwards writes nothing -- and binds its SHA-256 to a run id
   * minted here and carried into `accept`.
   *
   * NO GIT PRECONDITION. The worktree flow required a clean tree and a
   * committed HEAD, because it needed a clean BASELINE to cut a branch from.
   * An in-place run edits the folder as the user left it, uncommitted edits
   * included; the undo is what replaces the baseline.
   */
  async consentFor(
    proposal: SponsoredProposal,
    task = sponsoredTaskEvidence([
      { variant: 'user', content: 'Review this sponsored task.' },
    ]),
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
    if (this.active && !this.active.settled) {
      return { ok: false, message: 'A sponsored task is already running here.' }
    }
    if (!task) {
      return { ok: false, message: 'There is no task context to review.' }
    }
    const authToken = this.deps.getToken()
    if (!authToken) {
      return {
        ok: false,
        message: 'Sign in to Freebuff to review this sponsored task.',
      }
    }
    const surface = this.deps.executionSurface()
    if (!surface) {
      return {
        ok: false,
        message: 'Sponsored tasks cannot run on this machine.',
      }
    }
    const target = await this.deps.target()
    if (!target) {
      return {
        ok: false,
        message:
          'This project no longer has a stable sponsored-workspace identity.',
      }
    }
    const preview = await this.deps.preview(
      proposal._id,
      authToken,
      target,
      surface,
    )
    if (!preview.ok) return { ok: false, message: preview.message }
    if (preview.preview.target && !sameTarget(preview.preview.target, target)) {
      return {
        ok: false,
        message:
          'This sponsored task belongs to a different project. Review it again.',
      }
    }
    // THE SAME RUN ID for a re-review of the same proposal and procedure. An
    // Accept that timed out may already be durable upstream under the earlier
    // id, and a fresh one would be refused as `accept_binding_changed` instead
    // of replaying the first.
    const reuse =
      this.prepared?.proposalId === proposal._id &&
      this.prepared.preview.procedureSha256 === preview.preview.procedureSha256
    const runId = reuse ? this.prepared!.runId : randomUUID()
    this.prepared = {
      proposalId: proposal._id,
      runId,
      preview: preview.preview,
      task,
      target,
    }
    return {
      ok: true,
      runId,
      consent: {
        proposalId: proposal._id,
        advertiserName: proposal.advertiser_name,
        headline: proposal.headline,
        body: proposal.body,
        procedure: preview.preview.procedure,
        taskContext: task.messages,
        folder: this.projectRoot,
      },
    }
  }

  /**
   * The user said yes. Accept upstream, then wait for the conversation.
   *
   * The turn is NOT started here: chat starts it through `startTurn` once no
   * other turn is running, so the user's own work is never interleaved with
   * the advertiser's.
   */
  async accept(
    proposal: SponsoredProposal,
    runId: string,
    task?: SponsoredTaskEvidence | null,
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
    if (this.accepting || (this.active && !this.active.settled)) {
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
    const prepared = this.prepared
    if (
      !prepared ||
      prepared.proposalId !== proposal._id ||
      prepared.runId !== runId
    ) {
      return {
        ok: false,
        message: 'Review this sponsored task again before accepting it.',
      }
    }
    const surface = this.deps.executionSurface()
    if (!surface) {
      return {
        ok: false,
        message: 'Sponsored tasks cannot run on this machine.',
      }
    }
    this.accepting = true
    // The context must still be available and exactly what the user reviewed.
    if (!task || task.identity !== prepared.task.identity) {
      this.prepared = null
      this.accepting = false
      return {
        ok: false,
        message:
          'The task context changed after review. Review the sponsored task again.',
      }
    }
    // Caught here rather than left to the caller: `accepting` is already set,
    // and a throw past it would refuse every later Accept in this process.
    const target = await this.deps.target().catch(() => null)
    if (!target || !sameTarget(target, prepared.target)) {
      this.prepared = null
      this.accepting = false
      return {
        ok: false,
        message:
          'Your project identity changed after review. Review the sponsored task again.',
      }
    }
    this.set({
      ...IDLE,
      phase: 'accepting',
      proposalId: proposal._id,
      advertiserName: proposal.advertiser_name,
      runId,
    })
    try {
      const binding = {
        runId,
        procedureSha256: prepared.preview.procedureSha256,
        target,
        clientExecutionSurface: surface,
      }
      let accepted = await this.deps.accept(proposal._id, authToken, binding)
      for (const delay of ACCEPT_RETRY_DELAYS_MS) {
        if (accepted.ok || !retryableAcceptStatus(accepted.status)) break
        await this.deps.sleep(delay)
        accepted = await this.deps.accept(proposal._id, authToken, binding)
      }
      if (!accepted.ok) {
        this.set({ ...IDLE })
        if (accepted.code === 'procedure_changed') {
          this.prepared = null
          return { ok: false, message: accepted.message, reviewAgain: true }
        }
        // A transport failure KEEPS the binding: the Accept may be durable
        // upstream, and re-running `/ads:accept-proposal` replays it under the
        // same run id rather than being refused as a different approval.
        if (!retryableAcceptStatus(accepted.status)) this.prepared = null
        return { ok: false, message: accepted.message }
      }

      if (
        sponsoredProcedureSha256(accepted.accept.procedure) !==
        prepared.preview.procedureSha256
      ) {
        this.set({ ...IDLE })
        this.prepared = null
        return {
          ok: false,
          message: 'Freebuff returned a task different from the reviewed task.',
        }
      }

      const advertiserName =
        accepted.accept.advertiserName || proposal.advertiser_name
      this.active = {
        proposalId: proposal._id,
        runId,
        runToken: accepted.accept.runToken,
        computeGrant: accepted.accept.computeGrant,
        advertiserName,
        procedure: accepted.accept.procedure,
        taskContext: prepared.task.messages,
        runtimeInputs: {
          advertiserLink:
            typeof accepted.accept.advertiserLink === 'string'
              ? sponsoredAdvertiserCtaHref(accepted.accept.advertiserLink)
              : null,
        },
        recorder: new SponsoredEditRecorder(
          {
            runId,
            proposalId: proposal._id,
            advertiserName,
            projectRoot: this.projectRoot,
          },
          this.deps.receipts,
        ),
        abort: new AbortController(),
        expiryTimer: null,
        settled: false,
      }
      this.deps.lastRun.write(runId)
      this.prepared = null
      this.set({ phase: 'queued', advertiserName })
      return { ok: true }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Could not start the sponsored task.'
      this.set({ ...IDLE, phase: 'failed', failureReason: message })
      return { ok: false, message }
    } finally {
      this.accepting = false
    }
  }

  /**
   * The plan for the turn, and the moment `running` becomes true.
   *
   * Called by chat once the conversation is free. Null when there is nothing
   * queued, or when the grant can no longer pay for a run -- in which case the
   * run is failed here, since no turn will ever settle it.
   */
  async startTurn(): Promise<SponsoredTurnPlan | null> {
    const active = this.active
    if (!active || active.settled || this.snapshot.phase !== 'queued') {
      return null
    }
    const grant = active.computeGrant
    if (
      grant.proposalId !== active.proposalId ||
      grant.runId !== active.runId ||
      !/^[a-f0-9]{64}$/.test(grant.procedureSha256) ||
      grant.procedureSha256 !== sponsoredProcedureSha256(active.procedure) ||
      grant.expiresAtMs <= this.deps.now()
    ) {
      await this.settle({
        errorText:
          'The sponsored compute authorization is missing or expired. Nothing was started.',
        aborted: false,
      })
      return null
    }
    const authToken = this.deps.getToken()
    this.set({ phase: 'running' })
    // `running` is reported when the TURN is about to start, not at the
    // accept: between the two sits the wait for the conversation, and a card
    // that said "running" through that wait is a card that lied.
    if (authToken) await this.report(authToken, { state: 'running' })
    // The grant stops paying at its expiry, and a run that outlives it would
    // be billed to nobody. Aborted rather than left to fail request by request.
    // Its HOUR starts now, not at Accept (COD-665): the grant arrives with only
    // its start deadline, and the server brings it in to an hour from this
    // turn's first call -- a moment after this, so the local cutoff is never
    // the later of the two.
    const runDeadlineMs = sponsoredComputeRunDeadlineMs(
      grant.expiresAtMs,
      this.deps.now(),
    )
    active.expiryTimer = setTimeout(
      () => active.abort.abort('grant-expired'),
      Math.max(0, runDeadlineMs - this.deps.now()),
    )
    active.expiryTimer.unref?.()
    const context: SponsoredToolContext = {
      workspaceRoot: this.projectRoot,
      runtimeDir: sponsoredRuntimeDir(this.projectRoot, active.runId),
      signal: active.abort.signal,
      recorder: active.recorder,
    }
    const agentId = (this.deps.agentId ?? (() => getAgentIdForMode('LITE')))()
    return {
      runId: active.runId,
      proposalId: active.proposalId,
      advertiserName: active.advertiserName,
      prompt: buildSponsoredPrompt(
        active.procedure,
        active.taskContext,
        active.runtimeInputs,
      ),
      agent: sponsoredAgentDefinition({
        agentId,
        model: grant.modelId,
        isFreebuff: IS_FREEBUFF,
      }),
      overrideTools: (this.deps.overrideTools ?? sponsoredOverrideTools)(
        context,
      ),
      // A signed one-run grant is the only route through sponsored metering.
      // No Freebuff session id rides beside it: the run is not the user's to
      // pay for, so it must not fall back to their free session when absent.
      extraCodebuffMetadata: {
        freebuff_sponsored_proposal_id: active.proposalId,
        freebuff_sponsored_run_id: grant.runId,
        freebuff_sponsored_procedure_sha256: grant.procedureSha256,
        freebuff_sponsored_compute_token: grant.token,
        freebuff_sponsored_surface: 'cli',
      },
      signal: active.abort.signal,
      cwd: this.projectRoot,
    }
  }

  /**
   * The verdict, read off the run's own edit receipts.
   *
   * `delivered` when at least one file changed, `failed` when none did -- and
   * an INTERRUPTED turn that still wrote something is delivered too: the files
   * are in the user's project either way, and calling that a failure would tell
   * them nothing changed while their editor says otherwise.
   *
   * Returns the brief for the conversation's own agent, or null.
   */
  async settleTurn(result: SponsoredTurnResult): Promise<string | null> {
    return this.settle(result)
  }

  private async settle(result: SponsoredTurnResult): Promise<string | null> {
    const active = this.active
    if (!active || active.settled) return null
    active.settled = true
    if (active.expiryTimer) clearTimeout(active.expiryTimer)
    const changed = active.recorder.changed()
    const files = changed.map((receipt) => receipt.path)
    const expired = active.abort.signal.reason === 'grant-expired'
    const how = `turn ${
      expired
        ? 'grant-expired'
        : result.aborted
          ? 'interrupted'
          : result.errorText
            ? 'error'
            : 'completed'
    }${diagnosticCause(result.errorText)}`
    const authToken = this.deps.getToken()
    if (files.length > 0) {
      const outcomes = sponsoredOutcomesFromReceipts(active.procedure, changed)
      this.set({ phase: 'delivered', changedFiles: files })
      if (authToken) {
        await this.report(authToken, {
          state: 'delivered',
          ...outcomes,
          ...(result.aborted || result.errorText
            ? { diagnosticReason: `${how}; changes were left in the workspace` }
            : {}),
        })
      }
      return sponsoredChangesBrief(active.advertiserName, files)
    }
    const failureReason = result.aborted
      ? 'The sponsored task was interrupted before it changed anything. Nothing was changed in your project.'
      : result.errorText
        ? 'The sponsored task failed before it changed anything. Nothing was changed in your project.'
        : 'The sponsored task finished without changing anything in your project.'
    this.set({ phase: 'failed', failureReason })
    if (authToken) {
      await this.report(authToken, {
        state: 'failed',
        failureReason,
        diagnosticReason: `${how}; the turn recorded no file edits of its own`,
      })
    }
    return null
  }

  /**
   * Ctrl-C, a quit, or a signal, while a run is queued or running.
   *
   * THE QUESTION WITH NO WEB EQUIVALENT. The run is a process on the user's
   * machine that is going away, and it must not leave the proposal stuck on
   * `running` forever. So: abort the turn and report a terminal state from the
   * receipts, which are already on disk -- a report persisted to the outbox
   * before anything is sent, so it survives the process ending.
   */
  async interrupt(
    reason: 'ctrl-c' | 'signal' | 'quit',
  ): Promise<{ interrupted: boolean; notice: string | null }> {
    const active = this.active
    if (!active || active.settled) return { interrupted: false, notice: null }
    active.abort.abort(`interrupted: ${reason}`)
    await this.settle({ errorText: null, aborted: true })
    const files = this.snapshot.changedFiles
    return {
      interrupted: true,
      notice:
        files.length > 0
          ? [
              `The sponsored task from ${active.advertiserName} was interrupted.`,
              `It had already changed ${files.length === 1 ? '1 file' : `${files.length} files`} in this folder. Undo them with /ads:undo.`,
            ].join('\n')
          : `The sponsored task from ${active.advertiserName} was interrupted before it changed anything.`,
    }
  }

  /**
   * Put the run's files back.
   *
   * Reads the ledger from disk rather than from memory, so an undo works after
   * the CLI was closed and reopened in this folder. Skip-not-clobber: a file
   * the user has changed since the run is named and left alone.
   */
  undo(): { ok: boolean; message: string; brief: string | null } {
    if (this.active && !this.active.settled) {
      return {
        ok: false,
        message:
          'The sponsored task is still working. Interrupt it before undoing its changes.',
        brief: null,
      }
    }
    const runId = this.active?.runId ?? this.deps.lastRun.read()
    const ledger = runId ? readSponsoredLedger(this.deps.receipts, runId) : null
    if (!ledger) {
      return {
        ok: false,
        message: 'No sponsored task has changed anything in this folder.',
        brief: null,
      }
    }
    if (changedReceipts(ledger).length === 0 && ledger.undoneAt === undefined) {
      return {
        ok: false,
        message: `The sponsored task from ${ledger.advertiserName} did not change any files.`,
        brief: null,
      }
    }
    const result = undoSponsoredReceipts(ledger, this.deps.receipts)
    if (result.alreadyUndone) {
      return {
        ok: false,
        message: `The changes from ${ledger.advertiserName} were already undone.`,
        brief: null,
      }
    }
    // A partial undo leaves the rest owed, and the dock's Undo with it.
    if (this.snapshot.runId === ledger.runId && result.skipped.length === 0)
      this.set({ undone: true })
    const lines = [
      `Undid ${ledger.advertiserName}'s changes: ${result.restored.length} restored` +
        (result.skipped.length > 0
          ? `, ${result.skipped.length} skipped because they changed since: ${result.skipped.join(', ')}`
          : '.'),
    ]
    if (result.skipped.length > 0) {
      lines.push(
        'Run /ads:undo again to restore those once they are back to what the sponsored task left.',
      )
    }
    if (result.shellCommands > 0) {
      lines.push(
        'Files created by the commands it ran are not tracked; check `git status` for anything left behind.',
      )
    }
    lines.push(
      'Undoing does not refund the sponsor; nothing is charged to you.',
    )
    return {
      ok: true,
      message: lines.join('\n'),
      brief:
        result.restored.length > 0
          ? sponsoredUndoBrief(ledger.advertiserName, result.restored)
          : null,
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
      active.runId,
    )
  }

  private async reportWith(
    proposalId: string,
    runToken: string,
    authToken: string,
    update: SponsoredStateUpdate,
    runId: string,
  ) {
    if (!TERMINAL_REPORT_STATES.has(update.state)) {
      // `running` is the only nonterminal report, and it must carry the SAME
      // identity tuple a terminal report does: a funded Accept freezes
      // `compute_run_id`, and Convex refuses a report without it as
      // `invalid_report_identity`. The report id is derived from the run id,
      // as Desktop derives it, so a replayed turn-start is an exact replay
      // upstream rather than a conflict.
      const identified = {
        ...update,
        reportId: `running:${runId}`,
        runId,
      }
      return this.deps
        .reportState(proposalId, runToken, identified, authToken)
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
    // EACH REPORT KEEPS ITS OWN SCHEDULE. With no attempt cap, stopping at the
    // first report that is not due -- or that failed again -- would let one
    // report that keeps failing hold every later one back forever, newer runs'
    // included. So the pass continues past it, and one timer is set for
    // whichever pending report is due first.
    let retryAt: number | null = null
    const retryNoLaterThan = (dueAt: number) => {
      retryAt = retryAt === null ? dueAt : Math.min(retryAt, dueAt)
    }
    for (const report of reports) {
      if (report.disposition === 'permanent_refusal') continue
      if (!force && report.nextDueAt > this.deps.now()) {
        retryNoLaterThan(report.nextDueAt)
        continue
      }
      const authToken = this.deps.getToken()
      if (!authToken) {
        retryNoLaterThan(this.deps.now() + TERMINAL_REPORT_RETRY_MAX_MS)
        break
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
        report.disposition = 'pending'
        report.nextDueAt =
          this.deps.now() +
          Math.min(
            2 ** Math.min(report.attempts, 8) * 1_000,
            TERMINAL_REPORT_RETRY_MAX_MS,
          )
        this.writeTerminalReports(reports)
        retryNoLaterThan(report.nextDueAt)
        continue
      }
      reports = reports.filter(
        (candidate) => candidate.update.reportId !== report.update.reportId,
      )
      this.writeTerminalReports(reports)
    }
    if (retryAt !== null) this.scheduleTerminalRetry(retryAt)
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

// --------------------------------------------------------------- the SDK turn

/** The one shape a refused tool call takes, so every refusal reads the same. */
function refusal(message: string) {
  return [{ type: 'json' as const, value: { errorMessage: message } }]
}

/**
 * The write-tool guard: workspace bound, symlink resolved, then the path
 * CLASSES a review would not show -- `.git` internals, CI configuration,
 * credential files. The class check is shared verbatim with Cloud and Desktop
 * so all three refuse the same paths, and `.git` being refused here is half of
 * what keeps an in-place run's history read-only (the sandbox's
 * `readOnlyGitDir` is the other half, for the shell).
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
 * Two questions, in order. Is it inside the workspace (the COD-397 F1 finding:
 * the OS sandbox covers only the shell, and the file tools run in this process
 * as the user)? And, because an in-place run reads the user's REAL folder
 * rather than a checkout cut from a commit, is it a file that holds real
 * secrets -- `.env.local`, a key, an `.npmrc` -- which a worktree could never
 * have contained (`evaluateSponsoredReadPath`)?
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
  const classified = evaluateSponsoredReadPath(
    path.isAbsolute(requestedPath)
      ? requestedPath
      : path.join(workspaceRoot, requestedPath),
    { workspaceRoot },
  )
  return classified.allowed ? null : classified.message
}

/**
 * The handlers a sponsored turn installs. The SDK's own `overrideTools` type,
 * narrowed to the seven tools the grant admits and with every one REQUIRED:
 * a sponsored run with one of these missing would fall through to the SDK's
 * uncontained default for that tool, so an absent handler is a type error
 * here rather than a hole found in production.
 */
export type SponsoredOverrideTools = Required<
  Pick<
    OverrideToolHandlers,
    | 'read_files'
    | 'code_search'
    | 'list_directory'
    | 'glob'
    | 'write_file'
    | 'apply_patch'
    | 'run_terminal_command'
  >
>

export type SponsoredToolContext = {
  /** The user's project root: an in-place run's workspace IS the checkout. */
  workspaceRoot: string
  runtimeDir: string
  signal: AbortSignal
  recorder: SponsoredEditRecorder
}

/**
 * `overrideTools` for an in-place sponsored turn.
 *
 * Exported so the clamps can be asserted directly rather than only through a
 * live run: every entry here is a boundary, and a boundary that is only
 * exercised end-to-end is a boundary nobody tests.
 */
export function sponsoredOverrideTools(
  context: SponsoredToolContext,
): SponsoredOverrideTools {
  const workspaceRoot = context.workspaceRoot
  const processBroker = createSponsoredCodeSearchBroker({
    workspaceRoot,
    runtimeDir: context.runtimeDir,
    // The workspace's own `.git` is inside the write root and must stay
    // read-only to the run: no commit, no ref, and above all no `hooks/` or
    // `config`, which an unsandboxed `git -C` would later execute as the user.
    readOnlyGitDir: true,
  })
  // No broker: the file layer pins directories itself (COD-642).
  const rootedFs = createSponsoredRootedFileSystem({ workspaceRoot })
  const recorded = async <T>(
    requestedPath: string,
    write: () => Promise<T>,
  ) => {
    try {
      return await context.recorder.around(requestedPath, write)
    } catch (error) {
      // A write the undo could not reverse is refused, not performed.
      if (error instanceof SponsoredReceiptRefusal) {
        return refusal(error.message) as unknown as T
      }
      throw error
    }
  }
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
      const target = fileToolPath(input)
      const refused = sponsoredWriteGuard(workspaceRoot, target)
      if (refused) return refusal(refused)
      return recorded(target!, () =>
        changeFile({
          parameters: input,
          cwd: workspaceRoot,
          fs: rootedFs,
        }),
      )
    },
    apply_patch: async (input: unknown) => {
      const target = fileToolPath(input)
      const refused = sponsoredWriteGuard(workspaceRoot, target)
      if (refused) return refusal(refused)
      return recorded(target!, () =>
        applyPatchTool({
          parameters: input,
          cwd: workspaceRoot,
          fs: rootedFs,
        }),
      )
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
      // An in-place run leaves its work uncommitted, so it may not move
      // history or configuration. Answered as a sentence the model can act on;
      // the sandbox also denies `.git` outright.
      const refusedGit = sponsoredRefusedGitSubcommand(input.command)
      if (refusedGit) return refusal(sponsoredGitRefusal(refusedGit))
      // WSL, destructive database commands and container lifecycle commands
      // reach state outside the worktree that no sandbox covers (COD-665).
      const refusedCommand = sponsoredRefusedCommand(
        input.command,
        process.platform,
      )
      if (refusedCommand)
        return refusal(sponsoredCommandRefusal(refusedCommand))
      context.recorder.noteShellCommand()
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

/** The execution surface this machine reports; null where no run can happen. */
export function cliExecutionSurface(
  platform: NodeJS.Platform = process.platform,
  osRelease: string = release(),
): SponsoredCliExecutionSurface | null {
  if (platform === 'darwin') return 'cli_macos'
  if (platform !== 'linux') return null
  return osRelease.toLowerCase().includes('microsoft') ? 'cli_wsl' : 'cli_linux'
}

function privateStateFile(
  directory: string,
  projectRoot: string,
): { directory: string; key: string; target: string } {
  const canonicalRoot = realpathSync(projectRoot)
  const key = createHash('sha256').update(canonicalRoot).digest('hex')
  return {
    directory,
    key,
    target: path.join(directory, `${key}.json`),
  }
}

function atomicPrivateWrite(
  directory: string,
  key: string,
  target: string,
  value: string,
): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = path.join(directory, `.${key}.${randomUUID()}.tmp`)
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
}

function terminalReportStore(
  projectRoot: string,
): SponsoredRunDeps['terminalReports'] {
  const { directory, key } = privateStateFile(
    path.join(getConfigDir(), 'sponsored-terminal-reports'),
    projectRoot,
  )
  return terminalReportFileStore(directory, key)
}

/** One project's outbox file, by its key. */
function terminalReportFileStore(
  directory: string,
  key: string,
): SponsoredRunDeps['terminalReports'] {
  const target = path.join(directory, `${key}.json`)
  return {
    read: () => {
      try {
        return readFileSync(target, 'utf8')
      } catch {
        return null
      }
    },
    write: (value) => atomicPrivateWrite(directory, key, target, value),
  }
}

function lastRunStore(projectRoot: string): SponsoredRunDeps['lastRun'] {
  const { directory, key, target } = privateStateFile(
    path.join(getConfigDir(), 'sponsored-last-run'),
    projectRoot,
  )
  return {
    read: () => {
      try {
        const parsed = JSON.parse(readFileSync(target, 'utf8')) as {
          runId?: unknown
        }
        return typeof parsed.runId === 'string' ? parsed.runId : null
      } catch {
        return null
      }
    },
    write: (runId) =>
      atomicPrivateWrite(directory, key, target, JSON.stringify({ runId })),
  }
}

export const defaultSponsoredRunDeps = (
  projectRoot: string,
): SponsoredRunDeps => ({
  preview: previewSponsoredProposal,
  accept: acceptSponsoredProposal,
  reportState: reportSponsoredRunState,
  getToken: getAuthToken,
  platform: process.platform,
  containment: sponsoredContainment,
  executionSurface: () => cliExecutionSurface(),
  target: () => sponsoredProposalLocalTarget(),
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  terminalReports: terminalReportStore(projectRoot),
  receipts: sponsoredReceiptStore(),
  lastRun: lastRunStore(projectRoot),
})

let instance: SponsoredRun | null = null

/**
 * The process's one sponsored run, for the project the CLI is in NOW.
 *
 * The project root can change mid-process -- switching to the git root, or the
 * project picker (`index.tsx`, `process.chdir` + `setProjectRoot`) -- and a
 * run pinned to the root it was first built for would review, accept and edit
 * the folder the user just left. So an IDLE run for another root is replaced;
 * one with a run in flight is kept, because its edits, its token and its
 * terminal report all belong to the folder it started in.
 */
export function sponsoredRunFor(projectRoot: string): SponsoredRun {
  if (!instance || (instance.root !== projectRoot && instance.idle)) {
    instance = new SponsoredRun(
      projectRoot,
      defaultSponsoredRunDeps(projectRoot),
    )
    const mirror = (snapshot: SponsoredRunSnapshot) =>
      useSponsoredRunStore.setState({ snapshot })
    mirror(instance.state)
    instance.subscribe(mirror)
  }
  return instance
}

/**
 * Replay this project's outbox (see `flushPendingReports`). A run built here
 * already replays from its constructor, so only an EXISTING one is asked
 * again.
 */
export function replaySponsoredTerminalReports(projectRoot: string): void {
  const before = instance
  const run = sponsoredRunFor(projectRoot)
  if (run === before) run.flushPendingReports()
  if (foreignOutboxesReplayed) return
  foreignOutboxesReplayed = true
  try {
    const { directory, key } = privateStateFile(
      path.join(getConfigDir(), 'sponsored-terminal-reports'),
      projectRoot,
    )
    replayForeignOutboxes(directory, key, (terminalReports) => ({
      ...defaultSponsoredRunDeps(projectRoot),
      terminalReports,
    }))
  } catch (error) {
    logger.debug({ error }, '[sponsored-run] foreign outbox replay failed')
  }
}

/** Once per process: the other folders' files do not change under it. */
let foreignOutboxesReplayed = false

/**
 * Replay every OTHER project's outbox too.
 *
 * The outbox is keyed per project root, so a report stranded by a crash in
 * folder A used to wait until the CLI was next opened in A -- which may never
 * happen, leaving that row on `running` with its grant live. Every entry
 * carries its own proposal id and run token, so any folder's CLI can deliver
 * it. Each file gets its own flusher, which exists only to drain that file.
 */
export function replayForeignOutboxes(
  directory: string,
  ownKey: string,
  depsFor: (
    terminalReports: SponsoredRunDeps['terminalReports'],
  ) => SponsoredRunDeps,
): void {
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return
  }
  for (const name of names) {
    const key = /^([0-9a-f]{64})\.json$/.exec(name)?.[1]
    if (!key || key === ownKey) continue
    // The constructor drains the file; nothing else is ever asked of it.
    new SponsoredRun(
      directory,
      depsFor(terminalReportFileStore(directory, key)),
    )
  }
}

export function currentSponsoredRun(): SponsoredRun | null {
  return instance
}

/** Test-only. */
export function setSponsoredRunInstance(run: SponsoredRun | null): void {
  instance = run
}
