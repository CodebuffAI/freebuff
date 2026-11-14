// A new Cloud chat's first turn opens on the user's computer, read-only, while the chat moves to
// Cloud (docs/cloud-moving-chats.md, "Warm-up"). Desktop enforces the read-only tools; Cloud
// decides when the turn moves. Shared so both sides speak the same refusal.

/** What the model gets back for a refused tool while Cloud is still starting. */
export const WARMUP_REFUSAL =
  'Cloud workspace startup is still in progress. This tool has NOT run yet. This is a temporary ' +
  'startup delay, not a permission denial or a task failure. The tool will be available after ' +
  'the workspace is ready. Continue reading or inspecting, then retry this tool in a few seconds. ' +
  'Do not end the task or report that permissions blocked it; Freebuff will continue the run in Cloud.'

/** Appended to the warm-up agent's instructions, in every harness. */
export const WARMUP_GUIDANCE = `This task runs in a cloud workspace that is still starting. For its first moments you have read-only access to the project: read, search and inspect freely. Tools that write files or run commands that could change them return a "this cloud workspace is still starting" message until it is ready, which can take a little time. That message is temporary, not a failure: keep exploring, then ask for the change again. Never end your turn or tell the user you could not do something because of it.`

/** What a refused tool answers once the turn is moving to Cloud: the model never runs on. */
export const WARMUP_MOVED = 'This step continues in the cloud workspace, which is ready now.'

/** How long a refused tool waits for Cloud before the agent hears WARMUP_REFUSAL. */
export const WARMUP_HOLD_MS = 15_000

/**
 * A native warm-up turn's journal record of a refused tool (device-harnesses.ts). Never shown:
 * the worker reads it to move the turn to Cloud once the chat has landed there.
 */
export const WARMUP_REFUSED_EVENT = 'warmup_refused'

/** Freebuff's own tools a warm-up may use: they read, ask or show, and change nothing. */
export const WARMUP_THREAD_TOOLS = new Set([
  'suggest_prompts',
  'ask_questions',
  'read_thread_context',
  'reveal_file',
  'terminal_list',
  'terminal_read',
  'preview_snapshot',
  'preview_screenshot',
  'preview_logs',
  'preview_status',
  'preview_wait',
  'sites_list',
  'sites_inspect',
])

/**
 * The Freebuff agent's device tools that only read. `run_terminal_command` is not one: Desktop
 * runs a warm-up command only when it inspects (warmupCommandRefusalReason) and refuses the rest.
 */
export const WARMUP_DEVICE_READ_TOOLS = new Set([
  'end_turn',
  'read_image',
  'read_files',
  'list_directory',
  'glob',
  'code_search',
  'process_list',
  'process_read',
])

/** Whether a warm-up refuses this device tool without looking at its input. */
export function warmupRefusesTool(name: string) {
  return !WARMUP_DEVICE_READ_TOOLS.has(name) && !WARMUP_THREAD_TOOLS.has(name) && name !== 'run_terminal_command'
}
