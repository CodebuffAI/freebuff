import type { HostedBrowserScope } from './hosted-workspace'

export const TASKS_PANEL_UNSUPPORTED = 'DEVICE_TASKS_UNSUPPORTED'

export function isTasksPanelUnsupported(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === TASKS_PANEL_UNSUPPORTED
  )
}

/**
 * The background work a local Claude Code or Codex chat's kept process is running (freebuff-desktop's
 * claude-live-session.ts and codex-tasks.ts): Claude Code's `run_in_background` shells, Monitors and
 * subagents, foreground or backgrounded; Codex's subagents and the shells it leaves running. It
 * outlives the turn that started it, so the Overview shows it beside the chat.
 */
export type BackgroundTaskKind = 'shell' | 'agent' | 'monitor' | 'workflow' | 'other'

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped'

export interface BackgroundTask {
  id: string
  kind: BackgroundTaskKind
  /** What the CLI calls it: the shell command's description, the subagent's task. */
  title: string
  /** A subagent's type (`general-purpose`, a custom agent's name). */
  agentType?: string
  /** A one-line status: a subagent's progress summary, or the last tool it used. */
  detail?: string
  status: BackgroundTaskStatus
  /** Runs without holding a turn open: `run_in_background`, a Monitor, a backgrounded subagent. */
  background: boolean
  /** The subagent task that started this one, when one did. */
  parentId?: string
  startedAt?: number
  endedAt?: number
  /** A subagent's tool calls and tokens so far. */
  toolUses?: number
  totalTokens?: number
}

/** Finished tasks the Overview still lists: the most recent ones, for a while after they end. */
export const FINISHED_TASKS_KEPT = 20
export const FINISHED_TASK_MS = 30 * 60_000

export interface BackgroundTasksSnapshot {
  /** A Claude Code or Codex process is kept for this chat; false means nothing can be running in it. */
  live: boolean
  /** Running tasks first, then recently finished ones, newest first within each. */
  tasks: BackgroundTask[]
}

/** Task reads and stops are scoped to the native chat; the device resolves its process. */
export type HostedTasksRequest = HostedBrowserScope & (
  | { operation: 'list' }
  | { operation: 'stop'; taskId: string }
)
export type HostedTasksResponses = { list: BackgroundTasksSnapshot; stop: { stopped: boolean } }
export type HostedTasksHost = {
  request<T extends HostedTasksRequest>(input: T): Promise<HostedTasksResponses[T['operation']]>
}

/** Task ids are the CLI's own (Codex: a subagent's thread id, a command's item id); anything else
 *  is refused before it reaches a process. */
export const BACKGROUND_TASK_ID = /^[a-zA-Z0-9_.:-]{1,128}$/
