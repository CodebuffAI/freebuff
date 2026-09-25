/**
 * A sponsored run's EDIT RECEIPTS, and the undo they make possible (#3989).
 *
 * An in-place run edits the user's working copy directly, so the worktree that
 * used to be the write boundary is gone (the 2026-09-24 amendment in
 * `docs/freebuff-sponsored-local-execution.md`). What replaces it is a
 * RECOVERY mechanism: every file the run's own tools write is snapshotted
 * before and after, and `/ads:undo` reverse-applies those snapshots.
 *
 * The same receipts decide three things, which is the point of keeping one
 * record rather than three:
 *
 * - the VERDICT: `delivered` when at least one file changed, `failed` when none
 *   did (Desktop decides it off its turn receipts the same way);
 * - the OUTCOMES an advertiser is credited with, from the added lines;
 * - the UNDO, which restores exactly the files the verdict counted.
 *
 * ## What is and is not recorded
 *
 * Only the run's FILE TOOLS (`write_file`, `str_replace`, `apply_patch`) are
 * recorded, because only there can the before-image be captured at the moment
 * of the write. A shell command's writes are not: they happen inside the
 * sandboxed process, and a scan afterwards could only OBSERVE a change, not
 * attribute it -- the same limit Desktop's receipts have (`hasAgentEditEvidence`).
 * The undo says so when the run used the shell, rather than implying it
 * covered everything.
 *
 * A write whose before-image cannot be captured -- a file over the snapshot
 * cap, or something that is not a regular file -- is REFUSED rather than
 * performed unrecorded. An undo that silently skips the one file it could not
 * see is worse than a run told it may not touch that file.
 *
 * ## Where they live
 *
 * In the CLI's private state (`<config>/sponsored-receipts/<runId>.json`, mode
 * 0600), outside the checkout: a receipt holds file CONTENTS, and a file in
 * the project is one `git add -A` from being committed. Persisted after every
 * write, so an undo survives the CLI being closed mid-run.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import {
  SPONSORED_DIFF_FILE_TEXT_CAP,
  declaredOutcomes,
  verifyOutcomes,
} from '@codebuff/common/ads/sponsored-run-outcomes'

import { getConfigDir } from './config-dir'

import type { SponsoredDiffFile } from '@codebuff/common/ads/sponsored-run-outcomes'

/** Desktop's receipt cap (`freebuff-desktop/src/server/git/receipts.ts`). */
export const SPONSORED_SNAPSHOT_MAX_BYTES = 5 * 1024 * 1024

/** A file's contents at one moment, or null for "did not exist". */
export type SponsoredFileSnapshot = {
  sha256: string
  /** Base64, so a binary file restores byte for byte. */
  bytes: string
} | null

export type SponsoredEditReceipt = {
  /** Project-relative, forward slashes. */
  path: string
  /** Before the run FIRST wrote it. Never updated by a later write. */
  before: SponsoredFileSnapshot
  /** After the run's LAST write to it. */
  after: SponsoredFileSnapshot
}

export type SponsoredReceiptLedger = {
  runId: string
  proposalId: string
  advertiserName: string
  projectRoot: string
  receipts: SponsoredEditReceipt[]
  /** Commands the run executed; their writes are not in `receipts`. */
  shellCommands: number
  /** Set by a completed undo; a second one is a no-op. */
  undoneAt?: number
}

export type SponsoredReceiptStore = {
  read: (runId: string) => string | null
  write: (runId: string, value: string) => void
}

export class SponsoredReceiptRefusal extends Error {}

function snapshotOf(bytes: Buffer): NonNullable<SponsoredFileSnapshot> {
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.toString('base64'),
  }
}

/**
 * Read a file for a receipt. Throws a refusal for anything the undo could not
 * put back exactly: a symlink, a directory, a device, or a file over the cap.
 */
export function readSponsoredSnapshot(absolute: string): SponsoredFileSnapshot {
  const stat = lstatSync(absolute, { throwIfNoEntry: false })
  if (!stat) return null
  if (!stat.isFile()) {
    throw new SponsoredReceiptRefusal(
      `Refusing to edit \`${absolute}\`: sponsored runs may only edit regular files.`,
    )
  }
  if (stat.size > SPONSORED_SNAPSHOT_MAX_BYTES) {
    throw new SponsoredReceiptRefusal(
      `Refusing to edit \`${absolute}\`: sponsored runs may not edit files larger than 5 MB, because the change could not be undone.`,
    )
  }
  return snapshotOf(readFileSync(absolute))
}

function sameSnapshot(
  left: SponsoredFileSnapshot,
  right: SponsoredFileSnapshot,
): boolean {
  return left === null || right === null
    ? left === right
    : left.sha256 === right.sha256
}

/**
 * Records one run's edits. Constructed at the Accept, handed to the tool
 * overrides, and persisted after every write.
 */
export class SponsoredEditRecorder {
  private readonly ledger: SponsoredReceiptLedger

  constructor(
    init: Omit<SponsoredReceiptLedger, 'receipts' | 'shellCommands'>,
    private readonly store: SponsoredReceiptStore,
  ) {
    this.ledger = { ...init, receipts: [], shellCommands: 0 }
    this.persist()
  }

  get runId(): string {
    return this.ledger.runId
  }

  /**
   * Run one file-tool write between its two snapshots.
   *
   * The before-image is taken only on the run's FIRST write to a path, so a
   * file edited five times is restored to what the user had, not to the run's
   * fourth draft.
   */
  async around<T>(requestedPath: string, write: () => Promise<T>): Promise<T> {
    const absolute = path.resolve(this.ledger.projectRoot, requestedPath)
    const relative = path
      .relative(this.ledger.projectRoot, absolute)
      .split(path.sep)
      .join('/')
    let receipt = this.ledger.receipts.find((entry) => entry.path === relative)
    if (!receipt) {
      const before = readSponsoredSnapshot(absolute)
      receipt = { path: relative, before, after: before }
      this.ledger.receipts.push(receipt)
    }
    try {
      return await write()
    } finally {
      // Whatever the tool did -- including a partial write before it threw --
      // is what is on disk now, and that is what the undo compares against.
      try {
        receipt.after = readSponsoredSnapshot(absolute)
      } catch {
        receipt.after = null
      }
      this.persist()
    }
  }

  noteShellCommand(): void {
    this.ledger.shellCommands += 1
    this.persist()
  }

  /** The receipts whose file actually differs from what the user had. */
  changed(): SponsoredEditReceipt[] {
    return changedReceipts(this.ledger)
  }

  snapshot(): SponsoredReceiptLedger {
    return structuredClone(this.ledger)
  }

  private persist(): void {
    this.store.write(this.ledger.runId, JSON.stringify(this.ledger))
  }
}

export function changedReceipts(
  ledger: SponsoredReceiptLedger,
): SponsoredEditReceipt[] {
  return ledger.receipts.filter(
    (receipt) => !sameSnapshot(receipt.before, receipt.after),
  )
}

export function readSponsoredLedger(
  store: SponsoredReceiptStore,
  runId: string,
): SponsoredReceiptLedger | null {
  const raw = store.read(runId)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as SponsoredReceiptLedger
    return parsed && Array.isArray(parsed.receipts) ? parsed : null
  } catch {
    return null
  }
}

function decode(snapshot: SponsoredFileSnapshot): Buffer | null {
  return snapshot ? Buffer.from(snapshot.bytes, 'base64') : null
}

function textOf(snapshot: SponsoredFileSnapshot): string | null {
  const bytes = decode(snapshot)
  if (!bytes) return ''
  // A NUL in the first 4 KiB is Desktop's binary test too. A binary file adds
  // no lines an outcome rule could read.
  if (bytes.subarray(0, Math.min(bytes.length, 4096)).includes(0)) return null
  return bytes.toString('utf8')
}

/**
 * The lines a file GAINED, as a multiset difference: every line of the after
 * image, less one occurrence of each line the before image already had.
 *
 * Not a diff, and it does not need to be one: the outcome rules ask "did the
 * run add a line that looks like X", and a line the user already had is not
 * evidence of anything the run did whether or not it moved.
 */
export function addedLines(receipt: SponsoredEditReceipt): string | null {
  const after = textOf(receipt.after)
  const before = textOf(receipt.before)
  if (after === null || before === null) return null
  const remaining = new Map<string, number>()
  for (const line of before.split('\n')) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1)
  }
  const added: string[] = []
  for (const line of after.split('\n')) {
    const left = remaining.get(line) ?? 0
    if (left > 0) remaining.set(line, left - 1)
    else added.push(line)
  }
  return added.join('\n').slice(0, SPONSORED_DIFF_FILE_TEXT_CAP)
}

/**
 * The outcomes this run proved, read the same way Desktop reads them off its
 * receipts (`sponsoredOutcomesFromFileEdits`): the same `verifyOutcomes` over
 * the same added lines, so what an advertiser is credited with does not
 * depend on which surface ran the task.
 */
export function sponsoredOutcomesFromReceipts(
  procedure: string,
  receipts: readonly SponsoredEditReceipt[],
): { outcomes?: string[]; outcomeFiles?: Record<string, string[]> } {
  const allowed = declaredOutcomes(procedure)
  if (allowed.length === 0) return {}
  const diff: SponsoredDiffFile[] = receipts.flatMap((receipt) => {
    if (receipt.after === null) return []
    const addedText = addedLines(receipt)
    return addedText === null ? [] : [{ path: receipt.path, addedText }]
  })
  if (diff.length === 0) return {}
  const verified = verifyOutcomes(diff, allowed)
  return {
    outcomes: verified.map((entry) => entry.outcome),
    ...(verified.length > 0
      ? {
          outcomeFiles: Object.fromEntries(
            verified.map((entry) => [entry.outcome, entry.files]),
          ),
        }
      : {}),
  }
}

export type SponsoredUndoResult = {
  restored: string[]
  /** Changed since the run -- by the user or anything else -- so left alone. */
  skipped: string[]
  alreadyUndone: boolean
  /** The run used the shell, whose writes no receipt covers. */
  shellCommands: number
}

/**
 * Reverse-apply a run's receipts, skipping rather than clobbering.
 *
 * A file is restored only when it is still EXACTLY what the run left: the
 * after-image's hash. Anything else means someone has worked on it since, and
 * putting the pre-run bytes back would destroy that work silently -- the one
 * thing an undo must never do. Those files are named instead.
 */
export function undoSponsoredReceipts(
  ledger: SponsoredReceiptLedger,
  store: SponsoredReceiptStore,
): SponsoredUndoResult {
  if (ledger.undoneAt !== undefined) {
    return {
      restored: [],
      skipped: [],
      alreadyUndone: true,
      shellCommands: ledger.shellCommands,
    }
  }
  const restored: string[] = []
  const skipped: string[] = []
  for (const receipt of [...changedReceipts(ledger)].reverse()) {
    const absolute = path.resolve(ledger.projectRoot, receipt.path)
    let current: SponsoredFileSnapshot
    try {
      current = readSponsoredSnapshot(absolute)
    } catch {
      skipped.push(receipt.path)
      continue
    }
    // Already back to what the user had -- they reverted it themselves -- so
    // there is nothing to put back, and it must not be owed forever.
    if (sameSnapshot(current, receipt.before)) {
      restored.push(receipt.path)
      continue
    }
    if (!sameSnapshot(current, receipt.after)) {
      skipped.push(receipt.path)
      continue
    }
    const before = decode(receipt.before)
    try {
      if (before === null) {
        unlinkSync(absolute)
      } else {
        mkdirSync(path.dirname(absolute), { recursive: true })
        writeFileSync(absolute, before)
      }
      restored.push(receipt.path)
    } catch {
      skipped.push(receipt.path)
    }
  }
  // DONE ONLY WHEN NOTHING WAS LEFT BEHIND. A skipped file is still the
  // sponsor's edit; stamping the whole run undone would make every later undo
  // answer "already undone" once the user has put that file back as the run
  // left it. So the restored files are marked restored (after == before, so
  // they are no longer "changed") and the rest stay owed.
  const restoredPaths = new Set(restored)
  const next: SponsoredReceiptLedger =
    skipped.length === 0
      ? { ...ledger, undoneAt: Date.now() }
      : {
          ...ledger,
          receipts: ledger.receipts.map((receipt) =>
            restoredPaths.has(receipt.path)
              ? { ...receipt, after: receipt.before }
              : receipt,
          ),
        }
  store.write(ledger.runId, JSON.stringify(next))
  return {
    restored: restored.reverse(),
    skipped: skipped.reverse(),
    alreadyUndone: false,
    shellCommands: ledger.shellCommands,
  }
}

/** The default store: private application state, never the checkout. */
export function sponsoredReceiptStore(
  directory: string = path.join(getConfigDir(), 'sponsored-receipts'),
): SponsoredReceiptStore {
  const file = (runId: string) => {
    // A run id is a UUID minted here; anything else never names a file.
    if (!/^[0-9a-f-]{36}$/i.test(runId)) {
      throw new Error('Invalid sponsored run id.')
    }
    return path.join(directory, `${runId}.json`)
  }
  return {
    read: (runId) => {
      try {
        return readFileSync(file(runId), 'utf8')
      } catch {
        return null
      }
    },
    write: (runId, value) => {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const target = file(runId)
      const temporary = path.join(directory, `.${runId}.${randomUUID()}.tmp`)
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
