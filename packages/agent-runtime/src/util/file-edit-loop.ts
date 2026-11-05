import type { Message } from '@codebuff/common/types/messages/codebuff-message'

export const FILE_EDIT_LOOP_RECOVERY_TAG = 'FILE_EDIT_LOOP_RECOVERY'
export const FILE_EDIT_LOOP_RECOVERY_THRESHOLD = 3
export const FILE_EDIT_LOOP_STOP_THRESHOLD = 6
/** Steps of rejected edits to one file set, varied or not, that stop a turn.
 *  Higher than the identical-edit stop because a varied edit can still be a
 *  model working something out; twelve rejections in a row with no edit landing
 *  is not. */
export const FILE_EDIT_LOOP_VARIED_STOP_THRESHOLD = 12

export const FILE_EDIT_LOOP_RECOVERY_MESSAGE =
  'You have repeatedly sent the same file edit, and every attempt was rejected with the same result. Sending it again will not change anything. Read the file to see its current content, make a different edit, or explain the blocker to the user and end your turn.'

/** Sent at the varied count's recovery point: the edits differ, so "the same
 *  file edit" would be untrue, but each one has been rejected. */
export const FILE_EDIT_LOOP_VARIED_RECOVERY_MESSAGE =
  'Your last several edits to this file were all rejected, and none of them changed it. Read the file to see its current content before editing it again. If an edit was rejected because the old and new text are identical, the file already has that text. Otherwise explain the blocker to the user and end your turn.'

export const FILE_EDIT_LOOP_STOP_MESSAGE =
  'The model kept sending file edits that were all rejected (“No changes to existing files”) without making progress. This turn was stopped to avoid wasting more of your session. Try a different model or reasoning level, then continue.'

/** The tools whose rejection is reported as an `errorMessage` result: a no-op
 * the handler already explained to the model, so re-sending the same call
 * cannot do anything but earn the same answer.
 *
 * `write_file`, `str_replace` and `create_plan` get it from the
 * `postStreamProcessing` they share. `propose_str_replace` is the review-mode
 * twin of `str_replace` (`agents/base2`, the best-of-n editors) and builds the
 * same `{ file, errorMessage }` itself, in
 * `tools/handlers/tool/propose-str-replace.ts` — so an identical failing
 * proposal loops exactly like a `str_replace` one, and went uncounted here
 * until 2026-10-14.
 *
 * `apply_patch` and `propose_write_file` are deliberately absent, even though
 * `truncated-write-guard.ts`'s `FILE_MUTATING_TOOL_NAMES` lists them: neither
 * ever answers with `errorMessage`, so `isRejectedEdit` could not match one
 * and adding them would only widen the guard's precondition for nothing. */
const FILE_EDIT_LOOP_TOOL_NAMES = [
  'write_file',
  'str_replace',
  'create_plan',
  'propose_str_replace',
]

export function isFileEditLoopTool(toolName: string): boolean {
  return FILE_EDIT_LOOP_TOOL_NAMES.includes(toolName)
}

export class FileEditLoopError extends Error {
  constructor() {
    super(FILE_EDIT_LOOP_STOP_MESSAGE)
    this.name = 'FileEditLoopError'
  }
}

/** A tool result is a rejection when the handler answered with `errorMessage`
 * (content unchanged, old string not found, cut-off rewrite refused). */
export function isRejectedEdit(
  message: Extract<Message, { role: 'tool' }>,
): boolean {
  if (!Array.isArray(message.content)) return false
  return message.content.some(
    (part) =>
      part.type === 'json' &&
      typeof part.value === 'object' &&
      part.value !== null &&
      typeof (part.value as Record<string, unknown>).errorMessage === 'string',
  )
}

/** The same edit sent with a different `instructions` note is still the same
 * edit: only the path and the content decide what the handler answers. */
function editKey(toolName: string, input: Record<string, unknown>): string {
  const { instructions: _instructions, ...rest } = input
  return JSON.stringify([toolName, rest])
}

/** Count trailing steps of this user turn whose file edits were all the same
 * calls as the step before, and all rejected. Seen 2026-10-08 on Desktop with
 * Solar Pro 4: the model re-sent one unchanged write_file every step, each
 * answered "same as the old content", and only the general step budget stopped
 * it. Prose, reasoning, step prompts and the recovery note are not progress. A
 * different edit, an accepted edit, another tool, or a user message is. Only
 * matched, completed calls count, so a lost result cannot masquerade as this
 * model loop. */
export function trailingIdenticalRejectedEdits(messages: Message[]): number {
  let count = 0
  let latestStep: string | undefined
  const rejected = new Set<string>()

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === 'user') {
      if (
        message.tags?.includes('STEP_PROMPT') ||
        message.tags?.includes(FILE_EDIT_LOOP_RECOVERY_TAG)
      ) {
        continue
      }
      break
    }
    if (message.role === 'tool') {
      if (!isFileEditLoopTool(message.toolName) || !isRejectedEdit(message)) {
        break
      }
      rejected.add(message.toolCallId)
      continue
    }
    if (message.role !== 'assistant' || !Array.isArray(message.content))
      continue

    const keys: string[] = []
    for (const part of message.content) {
      if (part.type !== 'tool-call') continue
      if (
        !isFileEditLoopTool(part.toolName) ||
        !rejected.delete(part.toolCallId)
      ) {
        return count
      }
      keys.push(editKey(part.toolName, part.input))
    }
    if (keys.length === 0) continue
    const step = JSON.stringify(keys.sort())
    if (latestStep !== undefined && step !== latestStep) return count
    latestStep = step
    count++
  }

  return count
}

/** What a near-miss of the guard above looked like. Counts and flags only: no
 *  path, no file content, no edit arguments. */
export type FileEditLoopNearMiss = {
  /** Trailing steps that re-sent a rejected edit to the same file set. */
  consecutive: number
  /** Which of the holes this episode fell through, so the miss rate can be
   *  attributed rather than guessed. */
  varied: boolean
  interleaved: boolean
  mixedStep: boolean
  /** The edit tool of the most recent counted step. */
  toolName: string
}

/** A loop is edits with the odd read between them, not a long stretch of other
 *  work with one failed edit at each end — and this runs on every step that
 *  edits a file, so the walk back has to stay short. Consecutive steps that
 *  made no file edit at all, beyond this many, end the count. */
const NEAR_MISS_MAX_INTERLEAVED_STEPS = 2

function editPath(input: Record<string, unknown>): string {
  return typeof input.path === 'string' ? input.path : ''
}

/** The same shape as `trailingIdenticalRejectedEdits`, counted the way the
 * loops users actually photograph look. It was measurement only until
 * 2026-11-05: over the day before, 356 server-side Solar Pro 4 runs reached six
 * such steps, 115 of them stayed past twenty, and the identical-edit guard
 * stopped only 157 (a Cloud user watched "No changes to existing files" for 38
 * minutes). It now gives recovery guidance at `FILE_EDIT_LOOP_STOP_THRESHOLD`
 * and stops the turn at `FILE_EDIT_LOOP_VARIED_STOP_THRESHOLD` (run-agent-step).
 *
 * Three things the strict counter requires and a real loop often lacks:
 *   - byte-identical arguments, so a model that nudges `old_string` each
 *     attempt scores 1 forever (`varied`);
 *   - an unbroken run of edit steps, so one `read_files` between two attempts
 *     resets it (`interleaved`);
 *   - a step whose calls are *all* edit tools, which is the caller's
 *     precondition, so an edit batched with a read is never even looked at
 *     (`mixedStep`).
 *
 * This counts trailing steps that kept sending rejected edits to the SAME file
 * set, tolerating all three. An accepted edit, a different file set, or a real
 * user message still ends the count: those are progress. Returns null when
 * there is no trailing rejected edit at all. */
export function trailingRejectedEditsToSameFiles(
  messages: Message[],
  limit: number = FILE_EDIT_LOOP_STOP_THRESHOLD,
): FileEditLoopNearMiss | null {
  let count = 0
  let latestPaths: string | undefined
  let latestKeys: string | undefined
  let varied = false
  let interleaved = false
  let mixedStep = false
  let toolName = ''
  let interleavedRun = 0
  const rejected = new Set<string>()

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === 'user') {
      if (
        message.tags?.includes('STEP_PROMPT') ||
        message.tags?.includes(FILE_EDIT_LOOP_RECOVERY_TAG)
      ) {
        continue
      }
      break
    }
    if (message.role === 'tool') {
      // An edit that landed is progress, whichever step it belonged to.
      // Other tools' results are ignored: their call decides the step.
      if (isFileEditLoopTool(message.toolName)) {
        if (!isRejectedEdit(message)) break
        rejected.add(message.toolCallId)
      }
      continue
    }
    if (message.role !== 'assistant' || !Array.isArray(message.content))
      continue

    const paths: string[] = []
    const keys: string[] = []
    let others = 0
    let unmatched = false
    for (const part of message.content) {
      if (part.type !== 'tool-call') continue
      if (!isFileEditLoopTool(part.toolName)) {
        others++
        continue
      }
      // A call with no matching rejection is either still open or was
      // answered some other way; either way this is not the loop.
      if (!rejected.delete(part.toolCallId)) {
        unmatched = true
        continue
      }
      paths.push(editPath(part.input))
      keys.push(editKey(part.toolName, part.input))
      toolName = part.toolName
    }
    if (unmatched) break
    if (keys.length === 0) {
      // A step of nothing but other tools. Before the first counted step it
      // means the turn is not sitting on a rejected edit at all.
      if (count === 0) return null
      if (others > 0) interleaved = true
      if (++interleavedRun > NEAR_MISS_MAX_INTERLEAVED_STEPS) break
      continue
    }
    interleavedRun = 0
    if (others > 0) mixedStep = true

    const stepPaths = JSON.stringify([...paths].sort())
    if (latestPaths !== undefined && stepPaths !== latestPaths) break
    const stepKeys = JSON.stringify([...keys].sort())
    // The whole point of this counter: a varied edit is still the same loop.
    if (latestKeys !== undefined && stepKeys !== latestKeys) varied = true
    latestPaths = stepPaths
    latestKeys = stepKeys
    count++
    if (count >= limit) break
  }

  if (count === 0) return null
  return { consecutive: count, varied, interleaved, mixedStep, toolName }
}
