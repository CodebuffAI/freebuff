/**
 * Per-chat undo/redo journal.
 *
 * Each assistant turn that changed files records an entry here: the snapshot
 * hash captured before the turn plus the files it changed. `/undo` pops the
 * most recent entry and reverts those files via the snapshot repo; `/redo`
 * restores the state captured at undo time. Persisted as `undo.json` inside
 * the chat's data directory so it survives restarts and follows the chat
 * across `/history` resumes.
 */

import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { getProjectDataDir, tryGetProjectRoot } from '../project-files'
import { logger } from '../utils/logger'
import { anchorOf, type RewindAnchor } from './undo-rewind'
import {
  anchorSnapshot,
  diffSnapshot,
  isSnapshotAvailable,
  listAnchors,
  releaseSnapshot,
  restoreSnapshot,
  revertFiles,
  trackSnapshot,
} from '../utils/undo-snapshot'

export type UndoRecord = {
  id: string
  chatId: string
  /** Snapshot (git tree hash) captured before the assistant turn. */
  hashBefore: string
  /** Files the turn changed, relative to the project root. */
  files: string[]
  /** The user message that started the turn. */
  message: string
  /**
   * Where the turn started in the conversation, captured as its run begins.
   * Absent for entries written before the conversation rewind existed, and for
   * a turn whose transcript could not be read.
   */
  anchor?: RewindAnchor
  createdAt: string
  /** Snapshot captured at /undo time; set only while the record is redoable. */
  hashAfter?: string
  /**
   * Turns reverted by an undo action that jumped back past them. Stored on
   * the redo record so /redo can restore both the files and the stacks.
   */
  restored?: UndoRecord[]
}

/**
 * A conversation cut, staged by an undo that rewinds the conversation too.
 *
 * Staged, not applied: setting it deletes nothing, so `/redo` lifts it and
 * cannot lose a message. A turn that runs afterwards absorbs it — the state
 * that turn builds already excludes the cut messages — and it is cleared then.
 */
export type RewindBoundary = {
  /** The entry whose turn the conversation was rewound to. */
  recordId: string
  /** `messageHistory.length` the model's history is cut back to. */
  historyLength: number
  /** Transcript index of the prompt that turn started from. */
  transcriptIndex: number
  /** When the cut was staged. */
  createdAt: string
}

export type UndoState = {
  undoStack: UndoRecord[]
  redoStack: UndoRecord[]
  /** Present while a conversation cut is staged for this chat. */
  rewind?: RewindBoundary
}

const MAX_UNDO_ENTRIES = 20
const MAX_MESSAGE_CHARS = 120

/** Keep the journal small: first line of the prompt, truncated. */
function truncateMessage(message: string): string {
  const firstLine = (message.split('\n')[0] ?? '').trim()
  if (firstLine.length <= MAX_MESSAGE_CHARS) return firstLine
  return `${firstLine.slice(0, MAX_MESSAGE_CHARS - 1)}…`
}

function chatDirFor(chatId: string): string {
  return path.join(getProjectDataDir(), 'chats', chatId)
}

function undoFilePath(chatId: string): string {
  return path.join(chatDirFor(chatId), 'undo.json')
}

export function loadUndoState(chatId: string): UndoState {
  try {
    const file = undoFilePath(chatId)
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<UndoState>
      return {
        undoStack: Array.isArray(parsed.undoStack) ? parsed.undoStack : [],
        redoStack: Array.isArray(parsed.redoStack) ? parsed.redoStack : [],
        // A staged cut has to survive every other journal write, or a turn
        // recorded while it is pending would silently lift it.
        ...(parsed.rewind ? { rewind: parsed.rewind } : {}),
      }
    }
  } catch {
    // Corrupt or unreadable — treat as empty rather than breaking commands.
  }
  return { undoStack: [], redoStack: [] }
}

export function saveUndoState(chatId: string, state: UndoState): void {
  try {
    const dir = chatDirFor(chatId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(undoFilePath(chatId), JSON.stringify(state, null, 2))
  } catch {
    // Best-effort; undo is a convenience feature.
  }
}

/** Every hash the journal would need in order to restore from either stack. */
function referencedHashes(state: UndoState): Set<string> {
  const hashes = new Set<string>()
  for (const record of [...state.undoStack, ...state.redoStack]) {
    if (record.hashBefore) hashes.add(record.hashBefore)
    if (record.hashAfter) hashes.add(record.hashAfter)
    for (const reverted of record.restored ?? []) {
      if (reverted.hashBefore) hashes.add(reverted.hashBefore)
      if (reverted.hashAfter) hashes.add(reverted.hashAfter)
    }
  }
  return hashes
}

/**
 * Drop the anchors of the snapshots this chat no longer lists. Snapshots are
 * held by refs (see undo-snapshot), so releasing them is what keeps the store
 * from growing for the life of the project.
 *
 * Synchronous, like the rest of the journal's bookkeeping: the file it just
 * wrote must not list an entry whose snapshot is still held by a stale ref,
 * nor hold a ref no entry lists.
 */
function releaseDroppedAnchors(
  chatId: string,
  before: Set<string>,
  after: Set<string>,
): void {
  const projectRoot = tryGetProjectRoot()
  if (!projectRoot) return
  for (const hash of before) {
    if (after.has(hash)) continue
    releaseSnapshot(projectRoot, chatId, hash)
  }
}

/** Chat ids that have a data directory on disk, journalled or not. */
function listJournalChatIds(): string[] {
  try {
    return readdirSync(path.join(getProjectDataDir(), 'chats'), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    // No chats yet, or the directory is unreadable.
    return []
  }
}

/**
 * Make the anchors match the journals: hold what a journal lists, drop what
 * none lists, and re-anchor an entry whose ref went missing.
 *
 * The journals are the root set. Releasing on drop covers the entries this
 * store hands out, but it runs per chat and cannot know about a chat that was
 * deleted: its `undo.json` disappears and the refs its turns created stay
 * behind. Sweeping against the journals collects those, and repairs an anchor
 * or a release that failed, which is what keeps the store bounded.
 */
export function sweepAnchors(projectRoot: string): {
  released: number
  anchored: number
} {
  const anchors = listAnchors(projectRoot)
  const chatIds = new Set(anchors.map((anchor) => anchor.key))
  for (const chatId of listJournalChatIds()) chatIds.add(chatId)

  let released = 0
  let anchored = 0
  for (const chatId of chatIds) {
    const needed = referencedHashes(loadUndoState(chatId))
    for (const anchor of anchors) {
      if (anchor.key !== chatId || needed.has(anchor.hash)) continue
      if (releaseSnapshot(projectRoot, chatId, anchor.hash)) released += 1
    }
    for (const hash of needed) {
      if (anchors.some((a) => a.key === chatId && a.hash === hash)) continue
      if (anchorSnapshot(projectRoot, chatId, hash)) anchored += 1
    }
  }
  return { released, anchored }
}

/** The project root the sweep has already run for, so it runs once each. */
let sweptProjectRoot: string | null = null

/**
 * Sweep once per project root per process, after the current work is done so
 * the turn's own path never waits on maintenance.
 */
function sweepAnchorsInBackground(): void {
  const projectRoot = tryGetProjectRoot()
  if (!projectRoot || sweptProjectRoot === projectRoot) return
  sweptProjectRoot = projectRoot
  setTimeout(() => {
    try {
      const { released, anchored } = sweepAnchors(projectRoot)
      if (released > 0 || anchored > 0) {
        logger.debug(
          { released, anchored },
          'undo-store: swept the snapshot anchors',
        )
      }
    } catch (error) {
      logger.debug({ error }, 'undo-store: anchor sweep failed')
    }
  }, 0)
}

/**
 * Record a completed turn. Clears the redo stack: new edits invalidate redo.
 * No-ops when the snapshot is missing or nothing changed.
 */
export function recordUndoEntry(
  chatId: string,
  entry: {
    hashBefore: string
    files: string[]
    message: string
    anchor?: RewindAnchor
  },
): void {
  if (!entry.hashBefore || entry.files.length === 0) return
  const state = loadUndoState(chatId)
  const referenced = referencedHashes(state)
  state.undoStack.push({
    id: randomUUID(),
    chatId,
    hashBefore: entry.hashBefore,
    files: entry.files,
    message: truncateMessage(entry.message),
    ...(entry.anchor ? { anchor: entry.anchor } : {}),
    createdAt: new Date().toISOString(),
  })
  if (state.undoStack.length > MAX_UNDO_ENTRIES) {
    state.undoStack.shift()
  }
  state.redoStack = []
  saveUndoState(chatId, state)
  releaseDroppedAnchors(chatId, referenced, referencedHashes(state))
  // After the journal lists the turn, so the sweep can never see a snapshot
  // no entry is holding yet.
  const projectRoot = tryGetProjectRoot()
  if (projectRoot) anchorSnapshot(projectRoot, chatId, entry.hashBefore)
  sweepAnchorsInBackground()
}

export function peekUndo(chatId: string): UndoRecord | null {
  const stack = loadUndoState(chatId).undoStack
  return stack[stack.length - 1] ?? null
}

export function popUndo(chatId: string): UndoRecord | null {
  const state = loadUndoState(chatId)
  const record = state.undoStack.pop() ?? null
  if (record) saveUndoState(chatId, state)
  return record
}

/** Push a record back onto the undo stack (used by /redo). Does not touch redo. */
export function pushUndo(chatId: string, record: UndoRecord): void {
  const state = loadUndoState(chatId)
  const referenced = referencedHashes(state)
  state.undoStack.push(record)
  if (state.undoStack.length > MAX_UNDO_ENTRIES) {
    state.undoStack.shift()
  }
  saveUndoState(chatId, state)
  releaseDroppedAnchors(chatId, referenced, referencedHashes(state))
}

export function peekRedo(chatId: string): UndoRecord | null {
  const stack = loadUndoState(chatId).redoStack
  return stack[stack.length - 1] ?? null
}

export function popRedo(chatId: string): UndoRecord | null {
  const state = loadUndoState(chatId)
  const record = state.redoStack.pop() ?? null
  if (record) saveUndoState(chatId, state)
  return record
}

export function pushRedo(chatId: string, record: UndoRecord): void {
  const state = loadUndoState(chatId)
  state.redoStack.push(record)
  saveUndoState(chatId, state)
}

/**
 * The conversation cut staged for a chat, if any.
 *
 * Read on the way into a run (see `applyRewind`) and by the picker, so it has
 * to be one journal read: this sits on the send path.
 */
export function getRewindBoundary(chatId: string): RewindBoundary | null {
  return loadUndoState(chatId).rewind ?? null
}

/** Stage a conversation cut. Nothing is deleted; `/redo` lifts it. */
export function setRewindBoundary(
  chatId: string,
  boundary: RewindBoundary,
): void {
  const state = loadUndoState(chatId)
  state.rewind = boundary
  saveUndoState(chatId, state)
}

/**
 * Lift a staged cut: what a redo does, and what a turn does once it has run
 * (its state was built from the cut history, so the cut is baked in by then).
 */
export function clearRewindBoundary(chatId: string): void {
  const state = loadUndoState(chatId)
  if (!state.rewind) return
  delete state.rewind
  saveUndoState(chatId, state)
}

/** The undo stack for a chat, oldest turn first. */
export function listUndoEntries(chatId: string): UndoRecord[] {
  return loadUndoState(chatId).undoStack
}

/** The redo stack for a chat, oldest action first. */
export function listRedoEntries(chatId: string): UndoRecord[] {
  return loadUndoState(chatId).redoStack
}

/**
 * Undo back to a specific recorded turn (the OpenCode model): reverts that
 * turn's files AND everything the agent changed in newer turns, restoring the
 * project to the snapshot captured before the selected turn. The reverted
 * turns move onto the redo stack so /redo can restore the exact state that
 * was left behind. Returns the confirmation message, or null when the
 * snapshot store is unavailable (in which case nothing is changed).
 *
 * With `options.conversation`, the turn is also taken out of the model's
 * memory — staged, so a redo puts it back. The cut is skipped for an entry with
 * no anchor (recorded before this existed), because a wrong cut is worse than a
 * file-only undo; the entry still reverts its files either way.
 */
export async function undoToRecord(
  chatId: string,
  projectRoot: string,
  recordId: string,
  options: { conversation?: boolean } = {},
): Promise<string | null> {
  const state = loadUndoState(chatId)
  const index = state.undoStack.findIndex((record) => record.id === recordId)
  if (index === -1) return null
  const record = state.undoStack[index]!
  // The selected turn plus every newer one — all of it is reverted.
  const affected = state.undoStack.slice(index)
  const files = Array.from(new Set(affected.flatMap((r) => r.files)))

  // A snapshot can be gone — collected by the cleanup job, or lost with the
  // config directory. Abort before touching anything: reverting against a
  // snapshot it cannot read is how undoing deletes the files it meant to keep.
  if (!(await isSnapshotAvailable(projectRoot, record.hashBefore))) return null

  // Capture the current state first so /redo can restore exactly what was
  // undone. If the snapshot store is unavailable, abort without mutating the
  // stacks (mirrors the old inline handler's behavior).
  const hashAfter = await trackSnapshot(projectRoot)
  if (!hashAfter) return null
  // Held until the redo record that points at it is dropped.
  anchorSnapshot(projectRoot, chatId, hashAfter)

  // Diff of what the affected turns changed (computed before reverting).
  const diffStat = await diffSnapshot(projectRoot, record.hashBefore)
  const { restored, deleted } = await revertFiles(
    projectRoot,
    record.hashBefore,
    files,
  )

  state.undoStack = state.undoStack.slice(0, index)
  state.redoStack.push({ ...record, hashAfter, restored: affected })
  // The conversation half, when it was asked for and this turn knows where it
  // started. Staged, never applied: the files are already back, and the model's
  // history is cut on its way into the next run.
  const anchor = anchorOf(record)
  const rewound = Boolean(options.conversation && anchor)
  if (rewound && anchor) {
    state.rewind = {
      recordId: record.id,
      historyLength: anchor.historyLength,
      transcriptIndex: anchor.transcriptIndex,
      createdAt: new Date().toISOString(),
    }
  }
  saveUndoState(chatId, state)

  const undone = [
    ...restored.map((file) => `  ↺ ${file}`),
    ...deleted.map((file) => `  🗑 ${file} (deleted)`),
  ].join('\n')
  if (!undone) return 'Could not undo the selected change.'
  const turns = affected.length
  const heading =
    turns === 1
      ? '**Undid the last change:**'
      : `**Undid ${turns} change(s) back to: ${truncateMessage(record.message)}**`
  const rewoundNote = rewound ? '\n  ↶ the conversation was rewound with it' : ''
  return `${heading}\n${undone}${rewoundNote}${diffStat ? `\n\n${diffStat}` : ''}`
}

/**
 * Redo a specific undo action: restores the project to the state captured
 * when that undo ran and moves the reverted turns back onto the undo stack.
 * Redo actions newer than the selected one are invalidated by the jump.
 * Returns the confirmation message, or null when the restore fails.
 */
export async function redoToRecord(
  chatId: string,
  projectRoot: string,
  recordId: string,
): Promise<string | null> {
  const state = loadUndoState(chatId)
  const index = state.redoStack.findIndex((record) => record.id === recordId)
  if (index === -1) return null
  const record = state.redoStack[index]!
  if (!record.hashAfter) return null

  // Diff of what this redo restores (computed before the tree changes).
  const diffStat = await diffSnapshot(projectRoot, record.hashAfter)
  const ok = await restoreSnapshot(projectRoot, record.hashAfter)
  if (!ok) return null

  // Drop newer redo actions — jumping back invalidates them.
  const referenced = referencedHashes(state)
  state.redoStack = state.redoStack.slice(0, index)
  // A redo puts the conversation back as well, so it lifts any staged cut:
  // that mark is the only thing standing between the user and the messages.
  delete state.rewind
  if (record.restored && record.restored.length > 0) {
    state.undoStack.push(...record.restored)
  } else {
    state.undoStack.push({ ...record, hashAfter: undefined, restored: undefined })
  }
  saveUndoState(chatId, state)
  releaseDroppedAnchors(chatId, referenced, referencedHashes(state))

  const turns = record.restored?.length ?? 1
  const files = record.restored
    ? Array.from(new Set(record.restored.flatMap((r) => r.files)))
    : record.files
  // After the restore, files present in the tree came back; files missing
  // were removed by the restored state (the agent had deleted them).
  const fileLines = files.map((file) =>
    existsSync(path.join(projectRoot, file))
      ? `  ↺ ${file}`
      : `  🗑 ${file} (deleted)`,
  )
  const fileWord = files.length === 1 ? 'file' : 'files'
  const heading =
    turns === 1
      ? `**Redid the last change (${files.length} ${fileWord}):**`
      : `**Redid ${turns} change(s) (${files.length} ${fileWord}):**`
  return `${heading}\n${fileLines.join('\n')}${diffStat ? `\n\n${diffStat}` : ''}`
}
