import { TOOLS_WHICH_WONT_FORCE_NEXT_STEP } from '@codebuff/common/tools/constants'
import { createHash } from 'crypto'

import { isRejectedEdit } from './file-edit-loop'
import { FILE_MUTATING_TOOL_NAMES } from './truncated-write-guard'

import type { ToolMessage } from '@codebuff/common/types/messages/codebuff-message'

/**
 * Consecutive model steps with no progress that end a root turn. Far above the
 * identical-call guards' thresholds because it matches a broader shape, so a
 * false stop has to be much less likely, and a model polling a slow build with
 * unchanged output has to survive it.
 */
export const NO_PROGRESS_STOP_THRESHOLD = 40

/**
 * Shown to the user and kept in history as the model's own words, so it gives
 * the model no cost reason to stop: "carrying on would only spend your
 * session" taught it, in its own voice, that a task can be left unfinished to
 * save the session.
 */
export const NO_PROGRESS_STOP_MESSAGE = `I stopped here because my last ${NO_PROGRESS_STOP_THRESHOLD} steps changed no files and returned nothing new. This task is not finished. Tell me what to try differently, or switch model, and I'll pick it up from here.`

/** Bookkeeping, not work: a new to-do list is not a new fact about the task. */
const BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set([
  ...TOOLS_WHICH_WONT_FORCE_NEXT_STEP,
  'write_todos',
])

export type StepToolCall = {
  toolCallId: string
  toolName: string
  input: unknown
}

/**
 * Counts the consecutive steps of one turn that made no progress. A step makes
 * progress when it changes a file, or when a tool returns something this turn
 * has not seen: the same tool, input and output is not news, and anything else
 * is. So a long reading stretch never counts, and neither does output that
 * moves while a command is polled.
 *
 * Deliberately generous, because what it misses still ends at the step ceiling:
 *  - An accepted edit is progress even if the next one undoes it.
 *  - A rejected edit is never progress, however it varies: nothing changed.
 *  - Results from before this turn are unknown, so re-reading them is news.
 */
export function createTurnProgress() {
  const seen = new Set<string>()
  let stepsWithoutProgress = 0

  return {
    /** Takes one step's calls and results; returns the streak it leaves. */
    recordStep(calls: StepToolCall[], results: ToolMessage[]): number {
      const inputs = new Map(calls.map((c) => [c.toolCallId, c.input]))
      let progressed = false
      for (const result of results) {
        if (FILE_MUTATING_TOOL_NAMES.has(result.toolName)) {
          if (!isRejectedEdit(result)) progressed = true
          continue
        }
        if (BOOKKEEPING_TOOLS.has(result.toolName)) continue
        const fingerprint = createHash('sha1')
          .update(
            JSON.stringify([
              result.toolName,
              inputs.get(result.toolCallId),
              result.content,
            ]),
          )
          .digest('base64')
        if (!seen.has(fingerprint)) {
          seen.add(fingerprint)
          progressed = true
        }
      }
      stepsWithoutProgress = progressed ? 0 : stepsWithoutProgress + 1
      return stepsWithoutProgress
    },

    /** A message from the user is a new start, whatever came before it. */
    reset() {
      stepsWithoutProgress = 0
    },
  }
}
