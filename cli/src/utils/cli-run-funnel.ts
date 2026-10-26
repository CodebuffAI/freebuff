import { canAgentHideToolCall } from './constants'

import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type {
  ProductFunnelStage,
  ProductFunnelState,
} from '@codebuff/common/constants/product-funnel'

/** The native dispatch is observable; remote durable acceptance is not. */
export function createCliRunFunnel(deps: {
  capture(
    stage: ProductFunnelStage,
    state: ProductFunnelState,
    details?: {
      output_kind?: 'text' | 'tool'
      has_output?: boolean
      reason?: 'error' | 'empty'
      duration_ms?: number
    },
  ): void
  now?: () => number
}) {
  const now = deps.now ?? Date.now
  let startedAt = 0
  let accepted = false
  let started = false
  let ended = false
  const outputKinds = new Set<'text' | 'tool'>()
  const emit: typeof deps.capture = (...args) => {
    try {
      deps.capture(...args)
    } catch {
      /* Never interrupt a run. */
    }
  }
  const output = (kind: 'text' | 'tool') => {
    if (!accepted || ended || outputKinds.has(kind)) return
    outputKinds.add(kind)
    emit('response', 'received', { output_kind: kind })
  }
  return {
    accept() {
      if (accepted || ended) return
      accepted = true
      startedAt = now()
      emit('send', 'accepted')
    },
    event(event: PrintModeEvent) {
      if (!accepted || ended) return
      if (event.type === 'start' && !started) {
        started = true
        emit('turn', 'started')
      }
      // Match ToolBranch: hidden file/terminal work still renders collapsed;
      // agents can only suppress their own bookkeeping. Control tools render
      // elsewhere and do not establish a useful root-tool response.
      if (
        event.type === 'tool_call' &&
        !event.parentAgentId &&
        !(
          event.includeToolCall === false &&
          canAgentHideToolCall(event.toolName)
        ) &&
        ![
          'end_turn',
          'ask_user',
          'spawn_agents',
          'spawn_agent_async',
          'wait_for_subagents',
          'spawn_agent_inline',
        ].includes(event.toolName)
      ) {
        output('tool')
      }
    },
    chunk(chunk: unknown) {
      // Root text is delivered as a string. Structured chunks are subagent
      // output or reasoning and must not make a first-turn success.
      if (typeof chunk === 'string' && chunk.trim()) output('text')
    },
    finish(success: boolean) {
      if (!accepted || ended) return
      ended = true
      const hasOutput = outputKinds.size > 0
      emit('turn', success && hasOutput ? 'succeeded' : 'failed', {
        has_output: hasOutput,
        ...(!success
          ? { reason: 'error' as const }
          : !hasOutput
            ? { reason: 'empty' as const }
            : {}),
        duration_ms: Math.min(
          7 * 24 * 60 * 60 * 1000,
          Math.max(0, now() - startedAt),
        ),
      })
    },
    cancel() {
      if (ended) return
      ended = true
      if (!accepted) return
      emit('turn', 'cancelled', { has_output: outputKinds.size > 0 })
    },
  }
}
