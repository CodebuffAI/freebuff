import { appendFileSync, mkdirSync } from 'fs'
import path, { dirname } from 'path'

import { IS_DEV } from '@codebuff/common/env'

import { getCliEnv } from './env'
import { getCurrentChatDir, getProjectRoot } from '../project-files'

import type { TraceWriter } from '@codebuff/common/types/contracts/trace'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'

const TRACE_FILENAME = 'trace.jsonl'

type AgentTraceState = {
  /** Roles of messages already written, in order. Used to detect history
   * rewrites (compaction/expiry) without holding onto message objects. */
  writtenRoles: string[]
  system: string | undefined
  /** The step prompt last written, serialised. */
  stepPrompt: string | undefined
}

/**
 * Returns whether trace writing is enabled: always in dev, opt-in via
 * CODEBUFF_TRACE=1 in production builds (so users don't pay disk for a second
 * copy of their conversation by default).
 */
export function isTraceEnabled(): boolean {
  if (IS_DEV) return true
  // Same accepted values as CODEBUFF_FULL_TELEMETRY (see analytics-sampling)
  const flag = getCliEnv().CODEBUFF_TRACE
  return flag === '1' || flag === 'true' || flag === 'yes'
}

function getTraceFilePath(): string | null {
  try {
    return IS_DEV
      ? path.join(getProjectRoot(), 'debug', TRACE_FILENAME)
      : path.join(getCurrentChatDir(), TRACE_FILENAME)
  } catch {
    return null // No project root set yet
  }
}

/**
 * Create a TraceWriter that appends agent message histories to trace.jsonl —
 * one message per line, each written exactly once.
 *
 * In dev the trace goes to <projectRoot>/debug/trace.jsonl (next to
 * cli.jsonl); otherwise to the current chat directory. Returns undefined when
 * tracing is disabled.
 *
 * History rewrites (compaction, message expiry) are detected by comparing the
 * role sequence of the incoming history against what was already written; on
 * mismatch a `history_rewritten` marker line is appended followed by the new
 * history. Content-only edits that preserve the role sequence are not
 * re-traced — acceptable for a debug trace.
 */
export function createTraceWriter(
  resolveTraceFilePath: () => string | null = getTraceFilePath,
): TraceWriter | undefined {
  if (!isTraceEnabled()) {
    return undefined
  }

  const agentStates = new Map<string, AgentTraceState>()
  let ensuredDir: string | undefined

  return {
    recordStep: ({
      agentId,
      agentType,
      runId,
      userInputId,
      step,
      system,
      messages,
    }) => {
      const state = agentStates.get(agentId) ?? {
        writtenRoles: [],
        system: undefined,
        stepPrompt: undefined,
      }
      const base = { agentId, agentType, runId, userInputId, step }
      const timestamp = new Date().toISOString()
      const lines: string[] = []
      const appendLine = (record: Record<string, unknown>): void => {
        lines.push(JSON.stringify({ timestamp, ...record }))
      }

      // An agent's step prompt ends each step's request and is gone from the
      // next (the runtime drops it every step): diffed with the history it
      // would read as a rewrite at every step. It is recorded like the system
      // prompt instead, once and again only when it changes.
      const history = messages.filter((m) => !m.tags?.includes('STEP_PROMPT'))
      const stepPrompt = messages.find((m) => m.tags?.includes('STEP_PROMPT'))

      const rewritten =
        history.length < state.writtenRoles.length ||
        state.writtenRoles.some((role, i) => history[i]?.role !== role)
      if (rewritten) {
        appendLine({
          ...base,
          type: 'history_rewritten',
          previousMessageCount: state.writtenRoles.length,
          messageCount: history.length,
        })
        state.writtenRoles = []
      }

      if (system !== undefined && system !== state.system) {
        appendLine({ ...base, type: 'system', system })
        state.system = system
      }

      const stepPromptText = stepPrompt && JSON.stringify(stepPrompt.content)
      if (stepPromptText && stepPromptText !== state.stepPrompt) {
        appendLine({ ...base, type: 'step_prompt', message: stepPrompt })
        state.stepPrompt = stepPromptText
      }

      for (let i = state.writtenRoles.length; i < history.length; i++) {
        const message = history[i] as Message
        appendLine({
          ...base,
          type: 'message',
          index: i,
          message,
        })
      }

      state.writtenRoles = history.map((m) => m.role)
      agentStates.set(agentId, state)

      if (lines.length === 0) return
      // Resolve the path per step (not cached for the writer's lifetime: the
      // current chat directory changes when the user starts a new chat).
      const filePath = resolveTraceFilePath()
      if (!filePath) return
      try {
        const dir = dirname(filePath)
        if (ensuredDir !== dir) {
          mkdirSync(dir, { recursive: true })
          ensuredDir = dir
        }
        appendFileSync(filePath, lines.join('\n') + '\n')
      } catch {
        // Tracing must never break the run
      }
    },
  }
}
