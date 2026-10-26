import {
  assistantContent,
  userContent,
  userMessage,
} from '@codebuff/common/util/messages'
import { truncateStringWithMessage } from '@codebuff/common/util/string'

import { isRealHistory } from './compact-history'
import { stripThinkScaffolding } from './util/think-tag-stream'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { ToolResultOutput } from '@codebuff/common/types/messages/content-part'

/**
 * Agents started with `spawn_agent_async`, per parent.
 *
 * The spawn returns at once; the subagent runs in the background and its
 * report waits here until the parent's loop delivers it between two steps
 * (run-agent-step.ts). A parent's turn cannot end while one of its subagents
 * is still running: the loop waits for the next report instead.
 *
 * Every agent of one run tree runs in this process, so a process-local map
 * sees them all. It is keyed by the parent's runId, one per run of its loop,
 * which opens and ends the group, so nothing outlives the turn. Never by
 * agentId: every root run's is 'main-agent', and one process runs many roots
 * at once (Desktop's threads, a runner's users).
 */

export const ASYNC_SUBAGENT_REPORT_TAG = 'ASYNC_SUBAGENT_REPORT'

/** A finished subagent's report, waiting for its parent's next step. */
export type AsyncSubagentReport = {
  spawnId: string
  agentType: string
  task: string
  status: 'completed' | 'failed'
  /** Credits the subagent spent. Added to the parent when it is delivered,
   *  on the parent's own state, so a step's state copy cannot overwrite it. */
  creditsUsed: number
  durationMs: number
  /** Everything the subagent did after its task, as text
   *  (`renderAsyncSubagentTranscript`). */
  transcript: string
  errorMessage?: string
}

type AsyncSubagentGroup = {
  /** Spawn ids handed out, this turn's and every earlier turn's. */
  spawned: number
  /** Each running subagent's abort controller, by spawn id. */
  running: Map<string, AbortController>
  finished: AsyncSubagentReport[]
  wake: Set<() => void>
}

const groups = new Map<string, AsyncSubagentGroup>()

const groupOf = (parentRunId: string | undefined) =>
  parentRunId === undefined ? undefined : groups.get(parentRunId)

/** Opens the parent's group for one run of its loop (run-agent-step.ts). */
export function beginAsyncSubagentGroup(parentRunId: string): void {
  groups.set(parentRunId, {
    spawned: 0,
    running: new Map(),
    finished: [],
    wake: new Set(),
  })
}

/** Ends the parent's group: aborts what is still running, drops the rest.
 *  Called when the parent's loop exits, however it exits. */
export function endAsyncSubagentGroup(parentRunId: string): void {
  const group = groups.get(parentRunId)
  if (!group) return
  groups.delete(parentRunId)
  for (const abort of group.running.values()) abort.abort()
  for (const wake of group.wake) wake()
}

/**
 * The next spawn id for this parent: t1, t2, ... in spawn order. Each run of
 * the loop opens a new group, so its count continues from the spawns already
 * in the parent's history: an id never names two tasks. Undefined when the
 * parent has no loop running to deliver a report to.
 */
export function nextAsyncSpawnId(parent: {
  runId?: string
  messageHistory: Message[]
}): string | undefined {
  const group = groupOf(parent.runId)
  if (!group) return undefined
  if (group.spawned === 0) {
    for (const message of parent.messageHistory) {
      if (message.role !== 'assistant') continue
      for (const part of assistantContent(message.content)) {
        if (part.type === 'tool-call' && part.toolName === 'spawn_agent_async')
          group.spawned++
      }
    }
  }
  return `t${++group.spawned}`
}

/** Tracks a started subagent until `run` settles with its report. A parent
 *  whose loop has ended in the meantime gets no report: the subagent is
 *  stopped instead. */
export function trackAsyncSubagent(
  parentRunId: string | undefined,
  spawnId: string,
  abort: AbortController,
  run: Promise<AsyncSubagentReport>,
): void {
  const group = groupOf(parentRunId)
  if (!group) {
    abort.abort()
    return
  }
  group.running.set(spawnId, abort)
  void run.then((report) => {
    if (groupOf(parentRunId) !== group) return
    group.running.delete(spawnId)
    group.finished.push(report)
    for (const wake of group.wake) wake()
  })
}

export function hasRunningAsyncSubagents(parentRunId: string): boolean {
  return (groups.get(parentRunId)?.running.size ?? 0) > 0
}

/** Spawn ids of this parent's subagents that are still running. */
export function runningAsyncSubagents(parentRunId: string): string[] {
  return [...(groups.get(parentRunId)?.running.keys() ?? [])]
}

/** Removes and returns the reports that arrived since the last call. */
export function takeAsyncSubagentReports(
  parentRunId: string,
): AsyncSubagentReport[] {
  return groups.get(parentRunId)?.finished.splice(0) ?? []
}

/** Resolves once a report is waiting (true), or when nothing is running or
 *  the signal aborts (false). */
export async function waitForAsyncSubagentReport(
  parentRunId: string | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  const group = groupOf(parentRunId)
  if (!group) return false
  if (group.finished.length === 0 && group.running.size > 0) {
    await new Promise<void>((resolve) => {
      const done = () => {
        group.wake.delete(done)
        signal.removeEventListener('abort', done)
        resolve()
      }
      if (signal.aborted) return resolve()
      group.wake.add(done)
      signal.addEventListener('abort', done, { once: true })
    })
  }
  return group.finished.length > 0
}

const taskOpening = (spawnId: string) => `<subagent_task spawn_id="${spawnId}">`

/** How the task reads in the subagent's own history. */
export function asyncSubagentTaskPrompt(spawnId: string, task: string): string {
  return `${taskOpening(spawnId)}\n${task}\n</subagent_task>`
}

/** Messages before a subagent's own task are the conversation it inherited;
 *  everything after it, less the runtime's scaffolding, is what it did. Empty
 *  if the task never made it into the history (a run that failed to start). */
export function asyncSubagentTranscript(
  history: Message[],
  spawnId: string,
): Message[] {
  const opening = taskOpening(spawnId)
  const start = history.findLastIndex(
    (message) =>
      message.role === 'user' &&
      message.tags?.includes('USER_PROMPT') === true &&
      userContent(message.content).some(
        (part) => part.type === 'text' && part.text.startsWith(opening),
      ),
  )
  if (start === -1) return []
  return history.slice(start + 1).filter(isRealHistory)
}

/** One tool input or result. Above this a part keeps its head and tail. */
const MAX_PART_CHARS = 16_000
/** A whole transcript. Above this its middle is cut; the end, where the
 *  subagent's closing summary is, always survives. */
const MAX_TRANSCRIPT_CHARS = 60_000

const clip = (str: string, maxLength: number) =>
  truncateStringWithMessage({
    str,
    maxLength,
    message: `${str.length - maxLength} characters cut`,
    remove: 'MIDDLE',
  })

function renderToolOutput(output: ToolResultOutput[]): string {
  return output
    .map((part) =>
      part.type === 'json'
        ? typeof part.value === 'string'
          ? part.value
          : JSON.stringify(part.value)
        : `[${part.mediaType} attachment]`,
    )
    .join('\n')
}

/** The transcript as text: what the subagent wrote, every tool call with its
 *  input, every result. Reasoning is left out. */
export function renderAsyncSubagentTranscript(messages: Message[]): string {
  const blocks: string[] = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const part of assistantContent(message.content)) {
        if (part.type === 'text') {
          const text = stripThinkScaffolding(part.text).trim()
          if (text) blocks.push(text)
        } else if (part.type === 'tool-call') {
          blocks.push(
            `[tool call: ${part.toolName}] ${clip(JSON.stringify(part.input ?? {}), MAX_PART_CHARS)}`,
          )
        }
      }
    } else if (message.role === 'tool') {
      blocks.push(
        `[tool result: ${message.toolName}] ${clip(renderToolOutput(message.content), MAX_PART_CHARS)}`,
      )
    } else if (message.role === 'user') {
      const text = userContent(message.content)
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('')
        .trim()
      if (text) blocks.push(`[note] ${clip(text, 2_000)}`)
    }
  }
  return clip(blocks.join('\n\n'), MAX_TRANSCRIPT_CHARS)
}

/** The message a report becomes in the parent's history. */
export function asyncSubagentReportMessage(
  report: AsyncSubagentReport,
  stillRunning: string[],
): Message {
  const seconds = Math.round(report.durationMs / 1000)
  const running =
    stillRunning.length === 0
      ? 'No other subagents are running.'
      : `Still running: ${stillRunning.join(', ')}.`
  return userMessage({
    content: [
      `<subagent_report spawn_id="${report.spawnId}" agent="${report.agentType}" status="${report.status}" seconds="${seconds}">`,
      `<task>\n${report.task}\n</task>`,
      `<transcript>\n${report.transcript || '(no messages)'}\n</transcript>`,
      ...(report.errorMessage
        ? [`<error>\n${clip(report.errorMessage, 2_000)}\n</error>`]
        : []),
      `</subagent_report>`,
      running,
    ].join('\n'),
    tags: [ASYNC_SUBAGENT_REPORT_TAG],
  })
}
