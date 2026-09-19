/**
 * Guards shared by the undo picker and the send path.
 *
 * Both are about a jump-back being honest about what it takes with it: one
 * tells the user how far back the action reaches before they commit to it, the
 * other keeps a turn's bookkeeping from being written against changes that are
 * not its own.
 */

import type { UndoRecord } from './undo-store'

/** The files of a set of entries, each one listed once. */
const unionFiles = (entries: readonly UndoRecord[]): string[] =>
  Array.from(new Set(entries.flatMap((record) => record.files)))

/**
 * Every file an undo would touch: the selected turn's, plus every newer one's.
 *
 * The picker used to list only the selected entry's files while the action
 * reverts the selected turn *and* everything after it, so the panel understated
 * the very blast radius the notice above it was warning about. This is the same
 * union `undoToRecord` reverts.
 */
export function filesTakenBack(
  newestFirst: readonly UndoRecord[],
  recordId: string,
): string[] {
  const index = newestFirst.findIndex((record) => record.id === recordId)
  if (index === -1) return []
  return unionFiles(newestFirst.slice(0, index + 1))
}

/**
 * Every file a redo brings back: the turns its undo had reverted, when the
 * record carries them.
 */
export function filesRestored(record: UndoRecord): string[] {
  if (record.restored && record.restored.length > 0) {
    return unionFiles(record.restored)
  }
  return unionFiles([record])
}

/**
 * How many entries are newer than `recordId`.
 *
 * The picker lists entries newest first, so the position of the selected row
 * *is* the count: everything above it is newer. The journal reverts the
 * selected turn plus every newer one (and an undo of an undo invalidates the
 * newer redo entries the same way), which is the part the picker used to leave
 * unsaid.
 */
export function newerTurnCount(
  newestFirst: readonly UndoRecord[],
  recordId: string,
): number {
  const index = newestFirst.findIndex((record) => record.id === recordId)
  return index > 0 ? index : 0
}

/**
 * The newest turn that started, per chat.
 *
 * A turn captures its snapshot before its run and writes its entry after it,
 * in the `finally`. Those sit far apart in time and the run can be interrupted
 * in between: on Esc the chain lock is released before that `finally` finishes,
 * so the next turn can already be editing the worktree when the interrupted
 * turn diffs its snapshot. That diff is computed against the worktree as it is
 * *then*, so it would report files the newer turn changed, and `/undo` on that
 * entry would revert work the user never selected.
 *
 * So a turn stamps itself when it starts and records only while its stamp is
 * still the newest. Past that point its changes can no longer be told apart
 * from the next turn's, and the turn is dropped instead of recorded wrong —
 * best-effort, like the rest of the feature.
 */
const latestTurnStamp = new Map<string, number>()
let stampSequence = 0

/** Stamp a turn as it starts. Returns what it must present in order to record. */
export function beginUndoTurn(chatId: string): number {
  stampSequence += 1
  latestTurnStamp.set(chatId, stampSequence)
  return stampSequence
}

/** Whether `stamp` is still the newest turn that started for this chat. */
export function isLatestUndoTurn(chatId: string, stamp: number): boolean {
  return latestTurnStamp.get(chatId) === stamp
}
