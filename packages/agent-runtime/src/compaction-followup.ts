/**
 * What a run does after it compacts: the measurement behind "does compaction
 * cause read loops". A compaction opens a window; the next compaction or the
 * end of the run closes it and logs one content-free event with how much the
 * run read inside it, and how many of those reads were files whose contents
 * the compaction had just dropped.
 *
 * Reads are told apart by tool-call id, which survives every history rewrite
 * the runtime does, so the window needs no hook into tool execution: whatever
 * `read_files` call is in the history at close and was not there right after
 * the compaction happened inside the window.
 */

import { COMPACTION_FOLLOWUP_EVENT } from '@codebuff/common/util/axiom-only-log'

import { COMPACTED_READ_MARKER } from './compaction-working-set'
import { countTokensJson } from './util/token-counter'

import type { CompactionTrigger } from './compact-history'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'

/** `fallback` is the mechanical pass a failed model compaction fell back to. */
export type CompactionMode = 'model' | 'mechanical' | 'fallback'

export type CompactionWindow = {
  mode: CompactionMode
  /** The user's arm, which `mode` is not: a model-arm fallback is mechanical. */
  deterministicCohort?: boolean
  trigger: CompactionTrigger | 'manual'
  openedAt: number
  /** Every tool call already in the compacted history. */
  carriedCallIds: Set<string>
  /** Files read before the compaction whose results did not survive it. */
  elidedPaths: Set<string>
}

type ReadCall = { toolCallId: string; paths: string[] }

function readCalls(messages: Message[]): ReadCall[] {
  const calls: ReadCall[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.content) {
      if (part.type !== 'tool-call' || part.toolName !== 'read_files') continue
      const raw = (part.input as { paths?: unknown } | undefined)?.paths
      const paths = Array.isArray(raw)
        ? raw.flatMap((entry) => {
            const path =
              typeof entry === 'string'
                ? entry
                : (entry as { path?: unknown } | null)?.path
            return typeof path === 'string' && path ? [path] : []
          })
        : []
      calls.push({ toolCallId: part.toolCallId, paths })
    }
  }
  return calls
}

function toolCallIds(messages: Message[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.content) {
      if (part.type === 'tool-call') ids.add(part.toolCallId)
    }
  }
  return ids
}

/** Paths whose contents a history's read_files results actually hold. A
 * working-set stub names a file without holding it. */
function heldPaths(messages: Message[]): Set<string> {
  const held = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'tool' || message.toolName !== 'read_files') continue
    for (const part of message.content) {
      if (part.type !== 'json' || !Array.isArray(part.value)) continue
      for (const file of part.value) {
        const { path, content } = (file ?? {}) as {
          path?: unknown
          content?: unknown
        }
        if (
          typeof path === 'string' &&
          !(
            typeof content === 'string' &&
            content.startsWith(COMPACTED_READ_MARKER)
          )
        )
          held.add(path)
      }
    }
  }
  return held
}

export function openCompactionWindow(params: {
  before: Message[]
  after: Message[]
  mode: CompactionMode
  deterministicCohort?: boolean
  trigger: CompactionTrigger | 'manual'
  now?: number
}): CompactionWindow {
  const carriedPaths = heldPaths(params.after)
  return {
    mode: params.mode,
    deterministicCohort: params.deterministicCohort,
    trigger: params.trigger,
    openedAt: params.now ?? Date.now(),
    carriedCallIds: toolCallIds(params.after),
    elidedPaths: new Set(
      readCalls(params.before)
        .flatMap((call) => call.paths)
        .filter((path) => !carriedPaths.has(path)),
    ),
  }
}

/** The numbers the window's event carries; exported for tests. */
export function measureCompactionWindow(
  window: CompactionWindow,
  messages: Message[],
) {
  const newCalls = readCalls(messages).filter(
    (call) => !window.carriedCallIds.has(call.toolCallId),
  )
  const newCallIds = new Set(newCalls.map((call) => call.toolCallId))
  const readPathsAfter = new Set(newCalls.flatMap((call) => call.paths))
  let readTokensAfter = 0
  for (const message of messages) {
    if (message.role === 'tool' && newCallIds.has(message.toolCallId)) {
      readTokensAfter += countTokensJson(message.content)
    }
  }
  let toolCallsAfter = 0
  for (const id of toolCallIds(messages)) {
    if (!window.carriedCallIds.has(id)) toolCallsAfter++
  }
  return {
    elided_read_paths: window.elidedPaths.size,
    read_calls_after: newCalls.length,
    read_paths_after: readPathsAfter.size,
    reread_paths: [...readPathsAfter].filter((path) =>
      window.elidedPaths.has(path),
    ).length,
    read_tokens_after: readTokensAfter,
    tool_calls_after: toolCallsAfter,
  }
}

/** Logs the window's event. Telemetry: never throws. */
export function closeCompactionWindow(params: {
  window: CompactionWindow
  messages: Message[]
  endedBy: 'compaction' | 'run_end'
  nextTrigger?: CompactionTrigger | 'manual'
  logger: Logger
  runId?: string
  model?: string
  now?: number
}): void {
  try {
    params.logger.info(
      {
        axiomEvent: COMPACTION_FOLLOWUP_EVENT,
        agent_run_id: params.runId,
        model: params.model,
        mode: params.window.mode,
        deterministic_cohort: params.window.deterministicCohort,
        trigger_reason: params.window.trigger,
        ended_by: params.endedBy,
        next_trigger_reason: params.nextTrigger,
        ...measureCompactionWindow(params.window, params.messages),
        window_ms: (params.now ?? Date.now()) - params.window.openedAt,
      },
      'Compaction follow-up',
    )
  } catch {
    // Telemetry must never fail a run.
  }
}
