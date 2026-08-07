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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { getProjectDataDir } from '../project-files'
import {
  diffSnapshot,
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
  createdAt: string
  /** Snapshot captured at /undo time; set only while the record is redoable. */
  hashAfter?: string
  /**
   * Turns reverted by an undo action that jumped back past them. Stored on
   * the redo record so /redo can restore both the files and the stacks.
   */
  restored?: UndoRecord[]
}

export type UndoState = {
  undoStack: UndoRecord[]
  redoStack: UndoRecord[]
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

/**
 * Record a completed turn. Clears the redo stack: new edits invalidate redo.
 * No-ops when the snapshot is missing or nothing changed.
 */
export function recordUndoEntry(
  chatId: string,
  entry: { hashBefore: string; files: string[]; message: string },
): void {
  if (!entry.hashBefore || entry.files.length === 0) return
  const state = loadUndoState(chatId)
  state.undoStack.push({
    id: randomUUID(),
    chatId,
    hashBefore: entry.hashBefore,
    files: entry.files,
    message: truncateMessage(entry.message),
    createdAt: new Date().toISOString(),
  })
  if (state.undoStack.length > MAX_UNDO_ENTRIES) {
    state.undoStack.shift()
  }
  state.redoStack = []
  saveUndoState(chatId, state)
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
  state.undoStack.push(record)
  if (state.undoStack.length > MAX_UNDO_ENTRIES) {
    state.undoStack.shift()
  }
  saveUndoState(chatId, state)
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
 */
export async function undoToRecord(
  chatId: string,
  projectRoot: string,
  recordId: string,
): Promise<string | null> {
  const state = loadUndoState(chatId)
  const index = state.undoStack.findIndex((record) => record.id === recordId)
  if (index === -1) return null
  const record = state.undoStack[index]!
  // The selected turn plus every newer one — all of it is reverted.
  const affected = state.undoStack.slice(index)
  const files = Array.from(new Set(affected.flatMap((r) => r.files)))

  // Capture the current state first so /redo can restore exactly what was
  // undone. If the snapshot store is unavailable, abort without mutating the
  // stacks (mirrors the old inline handler's behavior).
  const hashAfter = await trackSnapshot(projectRoot)
  if (!hashAfter) return null

  // Diff of what the affected turns changed (computed before reverting).
  const diffStat = await diffSnapshot(projectRoot, record.hashBefore)
  const { restored, deleted } = await revertFiles(
    projectRoot,
    record.hashBefore,
    files,
  )

  state.undoStack = state.undoStack.slice(0, index)
  state.redoStack.push({ ...record, hashAfter, restored: affected })
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
  return `${heading}\n${undone}${diffStat ? `\n\n${diffStat}` : ''}`
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
  state.redoStack = state.redoStack.slice(0, index)
  if (record.restored && record.restored.length > 0) {
    state.undoStack.push(...record.restored)
  } else {
    state.undoStack.push({ ...record, hashAfter: undefined, restored: undefined })
  }
  saveUndoState(chatId, state)

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
