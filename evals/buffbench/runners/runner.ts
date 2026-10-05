import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

export type AgentStep = PrintModeEvent

export type RunnerResult = {
  steps: AgentStep[]
  totalCostUsd: number
  diff: string
  /** Why the run ended early, when it did: the SDK's error message. A run that
   *  died with no edits is then recorded as a failure, not as an agent that
   *  chose to change nothing. */
  error?: string
}

export interface Runner {
  run: (prompt: string) => Promise<RunnerResult>
}
