/**
 * When a chat belongs on the user's computer rather than in Cloud. The chat's own agent decides:
 * Desktop offers `move_to_cloud` on the computer, and Cloud offers `continue_locally` to a run
 * Desktop submitted. Both tools carry this guidance in their descriptions, so every harness that
 * gets a tool gets the guidance too.
 */
export const PLACEMENT_GUIDANCE =
  'Decide in your first step, before editing files or running commands: a move after work has started carries only the files, not running processes. ' +
  'Cloud suits long or unattended work (the user wants to step away), several things in parallel, heavy or risky installs, and deploying a site. ' +
  "The user's computer suits work that needs it: its hardware, simulators or devices, the user's Docker images, VPN or localhost services, CLI sign-ins and browser or MCP tools only that computer has, files outside the project, and quick edit-and-check loops against something already running there. " +
  "The user's explicit wording always wins. If unsure, stay. At most one move per user message, and never back unless the user asks. " +
  'Calling it switches the runtime at this tool boundary. Continue the same response from the tool result in the destination; do not end your turn or ask the user to continue. Do not announce or summarize the runtime change; simply carry on with the task.'

/** The run event a Cloud run writes when its agent asks to continue on the user's computer. */
export const HANDOFF_REQUEST_EVENT = 'handoff_request'
