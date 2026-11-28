// Read-only enforcement for destructive tool calls: when an agent opts into
// `blockDestructiveTools`, the tools that mutate files or run shell commands are
// refused outright.
//
// This is a property of the agent definition, not a per-call approval. A
// tool-call field cannot gate it — the tool input schemas drop unknown
// properties, so such a flag never reaches a handler — and a flag the model
// writes is worthless anyway, because the model writes its own tool input and
// could always confirm itself. Per-call approval would have to come from the
// host (the client that owns the human, not the agent), and the runtime has no
// such channel yet: `requestClientToolCall` asks the client to *run* a call, not
// to approve it. Until that channel exists the behaviour is all-or-nothing, and
// the name says exactly that. Off by default, so existing agents are unchanged.

export const DESTRUCTIVE_TOOLS_DISABLED_MESSAGE =
  'This tool is disabled for this agent: it is destructive (it writes files or runs shell commands) and the agent is configured for read-only work. Take a non-destructive route, or report what the user needs to do instead.'

export const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'str_replace',
  'apply_patch',
  'run_terminal_command',
])

/**
 * Returns true when `toolName` is considered destructive (mutates files or runs
 * shell commands). Purely a name-based classification.
 */
export function isDestructiveTool(toolName: unknown): boolean {
  return typeof toolName === 'string' && DESTRUCTIVE_TOOLS.has(toolName)
}

export function areDestructiveToolsBlocked(
  agentTemplate: { blockDestructiveTools?: boolean } | undefined,
): boolean {
  return agentTemplate?.blockDestructiveTools === true
}

/**
 * The one decision every destructive handler makes: may this tool run?
 * `toolName` is the handler's own tool, so the classification is local and the
 * caller does not repeat it.
 */
export function isDestructiveToolBlocked(
  agentTemplate: { blockDestructiveTools?: boolean } | undefined,
  toolName: string,
): boolean {
  return areDestructiveToolsBlocked(agentTemplate) && isDestructiveTool(toolName)
}
