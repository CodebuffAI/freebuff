// User hooks on Freebuff Desktop: the user's own shell commands, run on their computer before and
// after the agent uses a tool there. The file is Claude Code's hooks format, so hooks written for
// Claude Code carry over. Desktop reads and runs them (freebuff-desktop services/hooks/); these are
// the names and limits both sides of the bridge share.

/** Every event name Claude Code's hooks file can hold. All parse; see `RUNNABLE_HOOK_EVENTS`. */
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
] as const
export type HookEventName = (typeof HOOK_EVENTS)[number]

/** The events Desktop runs today. The others are read and ignored until Cloud can signal them. */
export const RUNNABLE_HOOK_EVENTS = ['PreToolUse', 'PostToolUse'] as const
export type RunnableHookEvent = (typeof RUNNABLE_HOOK_EVENTS)[number]

/** Seconds a hook may run when its entry names no `timeout`. */
export const HOOK_TIMEOUT_DEFAULT_SECONDS = 30
/** A longer `timeout` is cut to this. The whole tool step still has its own limit. */
export const HOOK_TIMEOUT_MAX_SECONDS = 60
/** The most of a blocking hook's stderr the model sees, in characters. */
export const HOOK_MESSAGE_CHARS = 4000

/**
 * Claude Code tool names a matcher may use, and the Freebuff tool each one means. A matcher may
 * also name a Freebuff tool directly. Hook input carries the Claude Code name when one maps.
 */
export const CLAUDE_CODE_TOOL_NAMES = {
  Bash: 'run_terminal_command',
  Write: 'write_file',
  // Before `MultiEdit`: a tool's own Claude Code name is the first entry that maps to it.
  Edit: 'str_replace',
  MultiEdit: 'str_replace',
  // Not `read_image`: no hook runs on it until Cloud can mark its own sponsored reads (Desktop
  // device-tools.ts).
  Read: 'read_files',
  Grep: 'code_search',
  Glob: 'glob',
  LS: 'list_directory',
} as const satisfies Record<string, string>

/**
 * Claude Code tool names with no Freebuff tool behind them. A matcher naming one (or a mapped name
 * in the wrong letter case, `bash`) is an entry error, so a carried-over guard is never silently
 * inert. Any other unknown name still loads: it may be an integration tool that exists only at run
 * time.
 */
export const CLAUDE_CODE_UNMAPPED_TOOL_NAMES = [
  'NotebookEdit',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'TodoWrite',
  'TodoRead',
  'BashOutput',
  'KillShell',
  'KillBash',
  'ExitPlanMode',
  'SlashCommand',
  'Skill',
  'AskUserQuestion',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
] as const

/**
 * Freebuff tools with no Claude Code name of their own that a Claude Code matcher also selects, so
 * a carried-over `Bash` or `Edit|Write` guard does not miss the same kind of step. For matching
 * only: hook input names the tool by the matcher name that selected it (or its Freebuff name).
 */
export const CLAUDE_CODE_ALSO_MATCHES = {
  // Every step that runs a command: a PTY's stdin, the user's own terminal, an elevated command.
  Bash: ['process_start', 'process_write', 'terminal_write', 'request_elevation'],
  Write: ['apply_patch'],
  Edit: ['apply_patch'],
} as const satisfies Partial<Record<keyof typeof CLAUDE_CODE_TOOL_NAMES, readonly string[]>>

/** The largest hooks file Desktop reads, in bytes. A bigger one is reported and runs nothing. */
export const HOOK_FILE_BYTES = 1024 * 1024
/** The most hooks Desktop loads from the file; each one after is an entry error (`too many hooks`),
 *  so a crafted file cannot flood main with approval checks. Settings adds at most `HOOKS_LIMIT`. */
export const HOOK_FILE_MAX_HOOKS = 200

/** One hook as read from the file, with the identity approval state keys on. */
export interface HookSummary {
  /** Stable across reloads and restarts; see `hookId` in Desktop's hooks/config.ts. */
  id: string
  /** `sha256:` + hex; changes with any edit to the entry's event, matcher, command or timeout. */
  hash: string
  event: HookEventName
  /** Whether Desktop runs this event today (`RUNNABLE_HOOK_EVENTS`). */
  runnable: boolean
  /** As written; empty (or absent) matches every tool. */
  matcher: string
  command: string
  /** `timeout` as configured, in seconds, or null when absent. */
  timeoutRaw: number | null
  /** Effective timeout: the default when absent, cut to the cap when longer. */
  timeoutMs: number
}

// ---- What can be added and switched on --------------------------------------------------------
//
// One set of rules for every layer: the file parser (Desktop services/hooks/config.ts), Settings'
// add form and route (`hookAddInput`, hooks-host.ts) and the consent bridge, which shows a command
// for a click only if it passes `hookCommandProblem`. Pure: nothing here reads a file.

/** A matcher's `|`-separated names, trimmed, empty names dropped. */
export const matcherNames = (matcher: string): string[] =>
  matcher
    .split('|')
    .map((name) => name.trim())
    .filter(Boolean)
/** `.*` is Claude Code's regex spelling of "every tool", common in carried-over files. */
export const isWildcardName = (name: string): boolean => name === '*' || name === '.*'
const REGEX_CHARS = /[.*+?()[\]{}^$\\]/

const ALSO_MATCHES: Record<string, readonly string[]> = CLAUDE_CODE_ALSO_MATCHES
/** Freebuff tools a Claude Code name selects; `glob` is one, so it is never `Glob` in the wrong case. */
const MAPPED_FREEBUFF_TOOLS = new Set<string>([
  ...Object.values(CLAUDE_CODE_TOOL_NAMES),
  ...Object.values(ALSO_MATCHES).flat(),
])
/** Only the mapped names: an unmapped one in another case (`task`) may be a run-time tool. */
const MAPPED_BY_CASE = new Map(
  Object.keys(CLAUDE_CODE_TOOL_NAMES).map((name) => [name.toLowerCase(), name] as const),
)
const UNMAPPED = new Set<string>(CLAUDE_CODE_UNMAPPED_TOOL_NAMES)

/** A Claude Code tool name no Freebuff tool answers to: unmapped, or a mapped one in the wrong case. */
const isDeadClaudeCodeName = (name: string): boolean => {
  if (UNMAPPED.has(name)) return true
  if (MAPPED_FREEBUFF_TOOLS.has(name)) return false
  const known = MAPPED_BY_CASE.get(name.toLowerCase())
  return known !== undefined && known !== name
}

/**
 * Why a matcher cannot be used, or null. Matchers here are plain tool names, not regexes, so a
 * carried-over regex (`Bash.*`, `(Write|Edit)`) is reported as broken rather than silently never
 * matching; `*` and `.*` alone mean every tool. A matcher that is written but names nothing (`|`,
 * spaces) is an error too, never "every tool"; only an absent or empty one means that. So is a
 * Claude Code tool name Freebuff has no tool for (`WebFetch`), or a mapped one in another letter
 * case (`bash`). Any other unknown name loads: it may be an integration tool known only at run time.
 */
export function matcherProblem(matcher: string): string | null {
  if (matcher === '') return null
  const names = matcherNames(matcher)
  if (names.length === 0) return 'Enter a tool name'
  if (names.some((name) => !isWildcardName(name) && REGEX_CHARS.test(name)))
    return 'Enter tool names separated by |, not a pattern'
  const dead = names.find(isDeadClaudeCodeName)
  if (dead !== undefined) return `Freebuff has no ${dead} tool`
  return null
}

/** The longest command the approval dialog shows whole (the consent bridge's `MAX_HOOK_COMMAND_CHARS`). */
export const HOOK_COMMAND_MAX_CHARS = 4000
/** The longest matcher the approval dialog shows (the consent bridge's `MAX_HOOK_MATCHER_CHARS`). */
export const HOOK_APPROVAL_MATCHER_MAX_CHARS = 512
/** Layout that can push part of a command out of view in the dialog: at most this many `\n` in a row. */
const HOOK_COMMAND_MAX_LINE_BREAKS = 2
const HOOK_COMMAND_MAX_SPACE_RUN = 8
const PLAIN_COMMAND = /^[\x20-\x7e\n]*$/
const PLAIN_MATCHER = /^[\x20-\x7e]*$/

// The sentences below reach Settings as they are, so they are written for the user: no full stop,
// no jargon. Identical to the consent bridge's `HOOK_MESSAGES` (pinned by hosted-hooks.test.ts).

/**
 * Why the consent bridge would refuse to show this command for a click, or null: in its words and
 * its order (`readHook` and `commandRefusal` in freebuff-desktop electron/mcp-consent-bridge.cjs,
 * pinned equal by hosted-hooks.test.ts). A command is printable ASCII plus newlines, so two
 * different commands never look the same in the dialog.
 */
export function hookCommandProblem(command: string): string | null {
  if (!command.trim()) return 'A hook needs a command'
  if (command.length > HOOK_COMMAND_MAX_CHARS) return 'Too long to show for approval'
  if (!PLAIN_COMMAND.test(command)) return 'Has curly quotes or other special characters, so it can’t be turned on'
  if (command.includes('\n'.repeat(HOOK_COMMAND_MAX_LINE_BREAKS + 1))) return 'Remove the blank lines from the command'
  if (/ (\n|$)/.test(command)) return 'Remove the spaces at the end of each line'
  if (command.includes(' '.repeat(HOOK_COMMAND_MAX_SPACE_RUN + 1)))
    return `Use at most ${HOOK_COMMAND_MAX_SPACE_RUN} spaces in a row`
  return null
}

/**
 * Why the consent bridge would refuse to show this matcher for a click, or null (`readHook`). Only
 * a hand-written matcher can fail it: Settings' own form allows fewer characters and 200 at most.
 */
export function hookMatcherApprovalProblem(matcher: string): string | null {
  if (matcher.length > HOOK_APPROVAL_MATCHER_MAX_CHARS) return 'The tool name is too long'
  if (!PLAIN_MATCHER.test(matcher)) return 'The tool name has special characters, so it can’t be turned on'
  return null
}
