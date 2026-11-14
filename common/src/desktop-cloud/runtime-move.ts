/** A runtime stops at a move tool; the owning Desktop turn remains running. */
export const RUNTIME_MOVE_ABORT = 'runtime-move'
export const RUNTIME_CONTEXT_EVENT = 'runtime_context'
/** Ordinary prompts are bounded separately from a runtime handoff's full context. */
export const CLOUD_PROMPT_MAX_CHARS = 200_000

export class RuntimeMoveRequested extends Error {
  constructor() {
    super(RUNTIME_MOVE_ABORT)
    this.name = 'RuntimeMoveRequested'
  }
}

export function runtimeMoveResult(target: 'cloud' | 'local', error?: string) {
  return {
    moved: !error,
    runtime: target,
    ...(error ? { error } : {}),
    note: error
      ? 'The runtime did not change. Continue this same response here.'
      : 'The runtime switched. Continue this same response after the move tool result; do not repeat completed work or announce a new turn. Files moved; running processes, terminals and dev servers did not. Dependencies may need installing. Do not move again during this user request.',
  }
}
