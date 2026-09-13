/**
 * The conversation half of an undo.
 *
 * A turn leaves two memories behind: the transcript the user reads and the run
 * state the model is fed. The undo journal only ever reverted files, so the
 * model kept its memory of the turn: it would look at the disk, not find the
 * file it believed it had just written, and write it again — the undo undid
 * itself.
 *
 * These helpers decide how far back that second memory is cut. Nothing is
 * deleted to make it happen: the journal *stages* the cut (see `undo-store`) and
 * the history is slice-copied on its way into `createRunConfig`, the single
 * place a run is built. Lifting the staged cut (`/redo`) is therefore free, and
 * cannot lose a message.
 *
 * Pure on purpose: these numbers come out of a journal, and the mistakes worth
 * catching are off-by-one ones.
 */

import type { RunState } from '@codebuff/sdk'

import type { ChatMessage } from '../types/chat'

/** Where a turn started, in each of the two memories. */
export type RewindAnchor = {
  /** `messageHistory.length` when the turn started. */
  historyLength: number
  /** Transcript index of the user prompt that started the turn. */
  transcriptIndex: number
}

/** The anchor a journal record carries, when it carries a usable one. */
export function anchorOf(record: { anchor?: RewindAnchor }): RewindAnchor | null {
  const anchor = record.anchor
  if (!anchor) return null
  if (!Number.isInteger(anchor.historyLength) || anchor.historyLength < 0) {
    return null
  }
  if (!Number.isInteger(anchor.transcriptIndex) || anchor.transcriptIndex < 0) {
    return null
  }
  return anchor
}

/**
 * Index of the last user prompt in a transcript, or -1 when there is none.
 *
 * Read as a turn starts — before its own run can add anything — so "the last
 * one" is the prompt that turn belongs to. A turn that injects prompts while it
 * runs (steering) would otherwise be indistinguishable from a newer turn's
 * prompt, which is exactly how another agent's rewind learned to look for the
 * *first* user message of the turn instead of the last.
 */
export function lastUserMessageIndex(messages: readonly ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.variant === 'user') return index
  }
  return -1
}

/**
 * The state a run should start from, with the conversation rewound to
 * `historyLength`.
 *
 * Returns the very same reference when there is nothing to cut, so a chat that
 * never staged a rewind pays no copy — and never gets one by accident. The
 * nested objects are copied rather than mutated: the caller still holds the full
 * state in a ref, and persists it.
 *
 * Left alone on purpose: `contextTokenCount` (recounted before every model call)
 * and each subagent's own history (a subagent reaches the model through the
 * parent's history, which is what gets cut).
 */
export function applyRewind(
  runState: RunState | null,
  historyLength: number | null,
): RunState | null {
  if (!runState || historyLength === null) return runState
  const sessionState = runState.sessionState
  const mainAgentState = sessionState?.mainAgentState
  const history = mainAgentState?.messageHistory
  if (!sessionState || !mainAgentState || !history) return runState
  if (historyLength >= history.length) return runState
  return {
    ...runState,
    sessionState: {
      ...sessionState,
      mainAgentState: {
        ...mainAgentState,
        messageHistory: history.slice(0, historyLength),
      },
    },
  }
}
