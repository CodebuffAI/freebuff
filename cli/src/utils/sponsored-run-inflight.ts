/**
 * The in-flight record of a sponsored run, and the boot sweep that reads it
 * (COD-665 R5).
 *
 * ## The hole this closes
 *
 * A terminal report is persisted to the outbox before it is sent, so a
 * report this process WROTE survives it. What did not survive was a process
 * that never got as far as writing one: SIGKILL, a closed laptop lid that
 * never woke, a crash inside the turn. The row then sat on `running` with its
 * compute grant live until the server's own sweep failed it -- as `timed_out`,
 * which says nothing about what happened, and even when the run had already
 * edited the user's files.
 *
 * So the moment the run is known to be spending compute, this process writes
 * down that it owns it: `{ version, proposalId, runId, runToken, pid,
 * startedAtMs }`, one file per RUN under its project's key
 * (`<config>/sponsored-inflight/<sha256(root)>/<runId>.json`). The record is
 * removed as soon as a terminal report for that run is durable in the outbox.
 * A record still on disk at the next launch, whose process is gone, is a run
 * that ended without a verdict -- and the next CLI reports it `failed` through
 * that folder's outbox, from the receipts on disk:
 *
 *  - edits recorded: `partial_edits`, whose copy says the changes are still in
 *    the user's files and names `/ads:undo`;
 *  - none: `app-quit: the CLI exited without reporting a verdict (found at
 *    launch)`.
 *
 * ## What it deliberately does not do
 *
 * The next launch in ANY folder sweeps every folder's records, not only its
 * own (`replayForeignOutboxes`): whether a pid is alive does not depend on the
 * folder, and each folder's report goes into that folder's own outbox, which
 * the same launch then drains.
 *
 * It never reports a run whose process is ALIVE (another CLI is still running
 * it), or whose pid is this process's own (a record this
 * process wrote, or a recycled pid -- the server's sweep covers that one). It
 * never reports without a session token, and keeps the record until there is
 * one. It never reports a run that already has a report in the outbox: that
 * report is the verdict, and the outbox delivers it. Runs that never reached
 * `running` have no record; the server's sweep covers those.
 *
 * `private-state.ts` holds the file helpers, shared with `sponsored-run.ts`,
 * so this module needs nothing from the run itself.
 */
import { SPONSORED_RUN_TOKEN_TTL_MS } from '@codebuff/common/ads/sponsored-run-token'
import {
  SPONSORED_PARTIAL_EDITS_COPY,
  sponsoredPartialEditsDiagnostic,
} from '@codebuff/common/ads/sponsored-in-place'
import { readdirSync, readFileSync, unlinkSync } from 'fs'
import { createHash } from 'node:crypto'
import path from 'path'

import { getConfigDir } from './config-dir'
import { atomicPrivateWrite, privateStateFile } from './private-state'
import { changedReceipts, readSponsoredLedger } from './sponsored-receipts'

import type { SponsoredStateUpdate } from './sponsored-proposal-api'
import type { SponsoredReceiptStore } from './sponsored-receipts'

export const SPONSORED_INFLIGHT_VERSION = 1

/** One run this process owns while it spends the sponsor's compute. */
export type SponsoredInflightRecord = {
  version: typeof SPONSORED_INFLIGHT_VERSION
  proposalId: string
  runId: string
  runToken: string
  pid: number
  startedAtMs: number
}

/**
 * The run's port onto its in-flight records. Injected, so the sweep is
 * testable with an in-memory list and a fake pid table.
 */
export type SponsoredInflightPort = {
  list: () => SponsoredInflightRecord[]
  /** Adds the record, replacing any other record for the same run. */
  put: (record: SponsoredInflightRecord) => void
  remove: (runId: string) => void
  /** This process's pid. */
  pid: number
  /** Whether a process with this pid exists. */
  isAlive: (pid: number) => boolean
}

/**
 * The sentence a partial-edits run's card shows: the shared copy, plus the
 * one remedy a terminal has that Desktop's conversation does not name.
 */
export function sponsoredCliPartialEditsFailureReason(
  how: keyof typeof SPONSORED_PARTIAL_EDITS_COPY,
): string {
  return `${SPONSORED_PARTIAL_EDITS_COPY[how]} Run /ads:undo to revert them.`
}

/** The no-edits verdict of a run found at launch without one. */
export const SPONSORED_ORPHANED_RUN_DIAGNOSTIC =
  'app-quit: the CLI exited without reporting a verdict (found at launch)'

/**
 * `how` for an orphaned run WITH edits. Deliberately not `app-quit: …`: the
 * funnel classifier reads that prefix as `app_quit` before it looks for the
 * partial-edits marker, and a run that left edits is `partial_edits`.
 */
const SPONSORED_ORPHANED_TURN_HOW =
  'turn closed: the CLI exited without reporting a verdict (found at launch)'

/**
 * The failed report for a run whose process ended without one, read off the
 * receipts that process left on disk.
 */
export function orphanedSponsoredRunReport(
  runId: string,
  receipts: SponsoredReceiptStore,
): Pick<SponsoredStateUpdate, 'state' | 'failureReason' | 'diagnosticReason'> {
  let edited = 0
  try {
    const ledger = readSponsoredLedger(receipts, runId)
    edited = ledger ? changedReceipts(ledger).length : 0
  } catch {
    // An unreadable ledger is a run with no edits we can name.
  }
  if (edited > 0) {
    return {
      state: 'failed',
      failureReason: sponsoredCliPartialEditsFailureReason('interrupted'),
      diagnosticReason: sponsoredPartialEditsDiagnostic(
        SPONSORED_ORPHANED_TURN_HOW,
        edited,
      ),
    }
  }
  return {
    state: 'failed',
    failureReason:
      'The sponsored task stopped when Freebuff closed, before it changed anything. Nothing was changed in your project.',
    diagnosticReason: SPONSORED_ORPHANED_RUN_DIAGNOSTIC,
  }
}

/**
 * Whether `pid` names a live process. `kill(pid, 0)` sends nothing: ESRCH is
 * "no such process"; EPERM is a process we may not signal, which is still a
 * process. Anything else is treated as alive, because a wrong "dead" reports
 * a live run as failed and a wrong "alive" only waits for the server's sweep.
 */
export function sponsoredPidIsAlive(
  pid: number,
  kill: (pid: number, signal: 0) => unknown = (target, signal) =>
    process.kill(target, signal),
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code !== 'ESRCH'
  }
}

/**
 * Report every run whose process ended without a verdict.
 *
 * `enqueue` puts the report in the outbox (the caller's, so it is delivered
 * and retried like any other terminal report); only then is the record
 * removed. Returns the run ids it reported.
 */
export function sweepSponsoredInflightRuns(input: {
  inflight: SponsoredInflightPort
  receipts: SponsoredReceiptStore
  /** Whether the outbox already holds a report for this run. */
  hasOutboxReport: (runId: string) => boolean
  tokenAvailable: boolean
  now: number
  enqueue: (
    record: SponsoredInflightRecord,
    update: Pick<
      SponsoredStateUpdate,
      'state' | 'failureReason' | 'diagnosticReason'
    >,
  ) => void
}): string[] {
  const { inflight } = input
  const reported: string[] = []
  for (const record of inflight.list()) {
    if (record.pid === inflight.pid) continue
    if (inflight.isAlive(record.pid)) continue
    // Its terminal report is already durable: that is the verdict.
    if (input.hasOutboxReport(record.runId)) {
      inflight.remove(record.runId)
      continue
    }
    // Past the run token's lifetime nothing upstream would accept a report,
    // and the server's sweep has long since failed the row.
    if (input.now - record.startedAtMs > SPONSORED_RUN_TOKEN_TTL_MS) {
      inflight.remove(record.runId)
      continue
    }
    // Signed out: keep it, and report it once there is a session.
    if (!input.tokenAvailable) continue
    input.enqueue(
      record,
      orphanedSponsoredRunReport(record.runId, input.receipts),
    )
    inflight.remove(record.runId)
    reported.push(record.runId)
  }
  return reported
}

function isInflightRecord(value: unknown): value is SponsoredInflightRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    record.version === SPONSORED_INFLIGHT_VERSION &&
    typeof record.proposalId === 'string' &&
    typeof record.runId === 'string' &&
    typeof record.runToken === 'string' &&
    typeof record.pid === 'number' &&
    typeof record.startedAtMs === 'number'
  )
}

/** Tolerant: an unreadable or foreign record is null, never thrown. */
export function parseSponsoredInflightRecord(
  raw: string | null,
): SponsoredInflightRecord | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return isInflightRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Where every project's in-flight records live. */
export function sponsoredInflightBaseDirectory(): string {
  return path.join(getConfigDir(), 'sponsored-inflight')
}

/**
 * A run's file name. A run id is a UUID minted by this CLI; anything else is
 * hashed rather than trusted to name a file.
 */
function inflightFileStem(runId: string): string {
  return /^[0-9a-f-]{36}$/i.test(runId)
    ? runId.toLowerCase()
    : createHash('sha256').update(runId).digest('hex')
}

/**
 * One project's in-flight records, by the project's key:
 * `<base>/<key>/<runId>.json`, ONE FILE PER RUN.
 *
 * Per run rather than one list per project, because two CLIs open in the same
 * folder can each own a run, and a list is a read-modify-write: two processes
 * rewriting it at once would each write back a list without the other's
 * record, leaving that run's crash unreported. With a file per run, `put` and
 * `remove` touch only their own run's file, and `list` reads the directory.
 * The directory is never removed: a process deleting it while another is
 * about to write into it would lose that write, and an empty one costs
 * nothing.
 */
export function sponsoredInflightKeyStore(
  base: string,
  key: string,
): Pick<SponsoredInflightPort, 'list' | 'put' | 'remove'> {
  const directory = path.join(base, key)
  const target = (runId: string) =>
    path.join(directory, `${inflightFileStem(runId)}.json`)
  return {
    list: () => {
      let names: string[]
      try {
        names = readdirSync(directory)
      } catch {
        return []
      }
      const records: SponsoredInflightRecord[] = []
      for (const name of names) {
        // Temporary files start with a dot; they are someone's write in flight.
        if (name.startsWith('.') || !name.endsWith('.json')) continue
        let raw: string | null = null
        try {
          raw = readFileSync(path.join(directory, name), 'utf8')
        } catch {}
        const record = parseSponsoredInflightRecord(raw)
        if (record) records.push(record)
      }
      return records.sort(
        (left, right) =>
          left.startedAtMs - right.startedAtMs ||
          left.runId.localeCompare(right.runId),
      )
    },
    put: (record) => {
      const stem = inflightFileStem(record.runId)
      atomicPrivateWrite(
        directory,
        stem,
        target(record.runId),
        JSON.stringify(record),
      )
    },
    remove: (runId) => {
      try {
        unlinkSync(target(runId))
      } catch {}
    },
  }
}

/** One project's in-flight records, by its root (`privateStateFile`'s key). */
export function sponsoredInflightStore(
  projectRoot: string,
  base: string = sponsoredInflightBaseDirectory(),
): Pick<SponsoredInflightPort, 'list' | 'put' | 'remove'> {
  const { key } = privateStateFile(base, projectRoot)
  return sponsoredInflightKeyStore(base, key)
}

/**
 * The project keys that have an in-flight directory under `base` -- the same
 * SHA-256 keys the outboxes use, so a key names one folder in both.
 */
export function sponsoredInflightKeys(
  base: string = sponsoredInflightBaseDirectory(),
): string[] {
  try {
    return readdirSync(base).filter((name) => /^[0-9a-f]{64}$/.test(name))
  } catch {
    return []
  }
}

/** The production port for a project's store, whether by root or by key. */
export function sponsoredInflightPortFor(
  store: Pick<SponsoredInflightPort, 'list' | 'put' | 'remove'>,
): SponsoredInflightPort {
  return {
    ...store,
    pid: process.pid,
    isAlive: (pid) => sponsoredPidIsAlive(pid),
  }
}

/** The production port for a project. */
export function sponsoredInflightPort(
  projectRoot: string,
): SponsoredInflightPort {
  return sponsoredInflightPortFor(sponsoredInflightStore(projectRoot))
}
