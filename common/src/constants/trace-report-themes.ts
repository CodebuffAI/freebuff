/**
 * The fixed themes the daily trace report sorts findings into. They are fixed
 * so that a theme's share of sessions means the same thing from one day to the
 * next. A finding that fits none of them lands in OTHER and is listed by title,
 * so a new problem shows up there first; when the same one keeps appearing,
 * give it a theme here. Built from the 2026-10-22 review of 935 sessions.
 *
 * Ids are keys in the report history (docs/daily-trace-report.md): never reuse
 * one for a different theme.
 */

export type Theme = { id: string; name: string; description: string }

export const OTHER_THEME = 'OTHER'

function themes(rows: [string, string, string][]): Theme[] {
  return rows.map(([id, name, description]) => ({ id, name, description }))
}

/** Problems seen in sessions; the id's letter is its group in THEME_GROUPS. */
// prettier-ignore
export const PROBLEM_THEMES = themes([
  ['A1', 'Turn ends without a visible answer or report', 'The agent ends a turn (or is cut off) without telling the user the result: only follow-up chips (suggest_followups/suggest_prompts), only a render_ui widget, a teaser line, no final summary, or the answer never arrives; includes no progress updates during very long turns'],
  ['A2', 'Claims success without verification', 'Declares work done/fixed/working without actually checking, reports untested results or numbers that were never measured, or the claimed fix does not actually work'],
  ['A3', 'Misunderstood the request / built the wrong thing', 'Misread intent, answered a different question, built a different solution or design than asked, did less than asked'],
  ['A4', 'Risky or unrequested actions without permission', 'Commits/pushes/opens PRs, installs runtimes, edits production/live systems, changes global settings, kills apps, or adds unrequested features/scope without asking'],
  ['A5', 'Broke working code or lost user work', 'Introduced regressions, syntax errors or runtime crashes, destructive git operations (reset/checkout) that lost changes, half-applied edits'],
  ['A6', 'Ignored or forgot user instructions/constraints', 'Did not follow explicit instructions, standing preferences or constraints stated earlier in the session (including after compaction)'],
  ['A7', 'Wrong or mixed reply language', 'Replied in a different language than the user, mixed languages, or used the wrong locale/script'],
  ['A8', 'Stuck or gave up without escalating', 'Kept trying without progress, gave up too early, or did not ask the user when blocked or when the request was ambiguous'],
  ['A9', 'Over-planning or unnecessary questions', 'Asked questions it could answer itself, re-planned repeatedly, deferred implementation until told to start, excessive confirmation'],
  ['A10', 'Weak debugging / speculative diagnosis', 'Did not reproduce the bug, guessed hypotheses, confident diagnosis without investigation, fixed symptoms not causes'],
  ['A11', 'Poor visual/UI or content quality', 'Design or UI output that does not match the request or looks bad, changes too subtle, low-quality generated content or copy'],
  ['A12', 'Hallucinated or unverified facts', 'Invented APIs, files, endpoints, model names or environment facts; asserted things it had not checked'],
  ['A13', 'Refusal problems', 'Over-refusal of legitimate work, inconsistent refusals (refuses then does it anyway), long repeated refusal text'],
  ['B1', 'Re-reading the same files repeatedly', 'Reads the same (often large) files many times in a session or turn, or duplicate reads'],
  ['B2', 'Repeating failing actions unchanged', 'Retries the same failing command, edit or tool call without changing approach; identical repeated calls'],
  ['B3', 'Excessive exploration before acting', 'Long reconnaissance, broad greps or searches, or web searches before doing simple work or answering a simple question'],
  ['B4', 'Over-verification loops', 'Rebuilds, re-runs full typecheck/test suites, or screenshot/preview cycles repeatedly for small changes'],
  ['B5', 'Sleep/poll loops', 'Blind sleep-and-poll waiting on servers, builds, deploys, CI or background jobs, burning calls'],
  ['B6', 'Rewriting whole files for small edits', 'Rewrites or regenerates entire large files instead of targeted edits; writes identical content again'],
  ['B7', 'Long commands hit tool timeouts repeatedly', 'Builds, emulators, test suites or servers exceed the command timeout and are retried the same way'],
  ['B8', 'Re-orientation after compaction or restart', 'After compaction, history rewrite or restart the agent re-reads files and re-discovers facts it already knew'],
  ['C1', 'Invalid tool parameters', 'Tool calls rejected by schema validation: missing completed in write_todos, missing instructions in write_file, wrong str_replace shape, wrong types, stringified arrays'],
  ['C2', 'Calls to non-existent tools', 'Hallucinated tool names such as run_command, bash, write_files, freebuff-preview, run_terminal_code_search, or unavailable subagents'],
  ['C3', 'Truncated tool calls or leaked tool-call tokens', 'Tool-call arguments cut off by output limits or connection drops, raw tool-call markup/special tokens leaked into text or code, empty responses'],
  ['C4', 'str_replace old-string mismatch', "Edits fail because the old string does not match (stale, whitespace, non-ASCII, ambiguous/multiple matches) or 'No change to the file'"],
  ['C5', 'Shell syntax / OS mismatch', 'Bash-only syntax in sh/PowerShell, Linux commands on Windows, quoting/heredoc breakage, path translation errors in commands'],
  ['D1', 'code_search failures', 'code_search timeouts, bad search directory (file passed as cwd, missing dir), ripgrep binary errors, 0 matches for existing text, non-ASCII paths'],
  ['D2', 'Writes outside the workspace / opaque edit errors', "write_file/str_replace refused or failing for paths outside the project (attached files, /tmp, other drives) with unclear errors like 'Failed to apply patch' or 'Invalid project path'"],
  ['D3', 'Preview screenshot capture failures', 'preview_screenshot fails: page not drawn, window minimized/covered, no frames/not composited, empty image'],
  ['D4', 'Preview interaction failures', 'preview_click/type/snapshot/evaluate/wait/open failures: box model errors, stale uids, locator strictness, timeouts, tab not attaching, interrupted by human input'],
  ['D5', 'read_url / web fetch failures', 'read_url 403/404/429, timeouts, PDFs unsupported, response too large, no readable text, blocked sites; web_search returning nothing useful'],
  ['D6', 'Background processes and dev servers die or are opaque', 'Dev servers or background jobs killed between calls/turns/restarts, nohup logs missing, unclear background status, need to relaunch'],
  ['D7', 'Guards and blocks misfire', 'Safety/product guards block benign actions: .env/secret guards, git blocked in Web, Convex compile gate blocking unrelated or read-only calls, privilege-wrapper false positives, plan-mode refusals'],
  ['D8', 'Encoding / non-ASCII handling bugs', 'Non-ASCII text mangled (U+FFFD), str_replace/glob failing on non-ASCII content or paths, console encoding issues caused by tools'],
  ['D9', 'Cannot see images or attachments', "Agent cannot view images/screenshots (text-only model or no image tool), chat-attached files not accessible, can't read .docx/PDF natively"],
  ['D10', 'File path resolution inconsistencies', 'read_files/list_directory report missing files that exist, relative paths break after restart, /tmp or Windows path differences between tools and shell'],
  ['D11', 'Output size limits', 'Cannot display or deliver a very large file/output; tool output truncated so the agent cannot finish'],
  ['D12', 'Command timeout cap too short', 'The terminal command timeout (e.g. 600s) is too short for legitimate builds/tests/installs'],
  ['E1', 'Compaction loses context', 'Compaction or history rewrites drop working context so the agent forgets earlier work, constraints, paths or answer language'],
  ['E2', 'Turn failures and interruptions', 'session_ended, response_failed, provider/connection errors, stalls or cutoffs mid-turn; the user must say continue or resend'],
  ['E3', 'Max-steps cutoff', 'Turn force-ended by the max agent steps limit, leaving work unfinished or unreported'],
  ['E4', 'Runtime nudges cause extra work or confusion', 'todo_nag, final completion check, follow-ups nudge or status-line nudge trigger extra calls, duplicate answers or confusion'],
  ['E5', 'Free session / quota limits cut work', 'Free session time, daily cap or subagent capacity limits end work mid-turn'],
  ['E6', 'Fallback or weaker model degraded quality', 'Model switch or fallback produced worse output (repetition loops, garbling)'],
  ['E7', 'Restart loses state', 'App restart or workspace restore loses preview tabs, node_modules, running processes or session context'],
  ['F1', "Desktop workspace vs. user's real project confusion", "Chat runs in an isolated thread workspace/worktree, not the user's folder; user can't find where files went, edits don't land in their checkout, agent can't see their disk"],
  ['F2', 'No visual preview on Web/Cloud/CLI', 'Surface lacks a browser/screenshot tool so UI work is done blind'],
  ['F3', 'Secrets and API keys management', "Confusion about where to put keys/env vars, keys not injected into the agent's shell or deployment, no safe secret entry"],
  ['F4', 'Hosting / deploy / publish issues', 'Freebuff Sites publish problems (503, URL, published site not loading), Vercel/other deploy integration gaps'],
  ['F5', 'Git/GitHub integration gaps', 'Cannot push/open PRs, no branch/PR link, git commands blocked, GitHub connect failures'],
  ['F6', 'Model selection and visibility', "Users can't tell or change which model/effort is used, ask which free model is best, model picker missing on a surface"],
  ['F7', 'Freebuff Web deprecation / migration', 'Legacy Freebuff Web projects, transferring projects out, deprecated workspace behavior'],
  ['F8', 'MCP / integration availability', 'User-configured MCP servers or integrations not available to the agent, tool approvals blocking work'],
  ['F9', 'No memory across sessions', "Agent doesn't remember standing preferences or project context between sessions/threads; 'continue' has no context"],
  ['F10', 'Cloud sandbox resource and tooling limits', 'Cloud/Web VM disk exhaustion, CPU starvation, missing browsers/libraries, no root'],
  ['F11', 'Other product UX friction', 'Other confusion about Freebuff itself: CLI behavior, chat management (moving threads), sponsored tools, client restarts, hidden paths'],
  ['G1', 'Windows environment friction', "Python not on PATH, cp1252 console encoding, Git Bash/MSYS/PowerShell path and quoting issues on the user's Windows machine"],
  ['G2', 'Missing toolchains, dependencies or permissions', 'User machine or project lacks required tools, SDKs, libraries, root access or network'],
  ['G3', 'User project or external service problems', 'Pre-existing broken builds, flaky external APIs/hosts, disk full, divergent copies — not caused by Freebuff'],
  ['H1', 'Abuse: cheats, malware, cracking, exam cheating', 'Requests to build game cheats/anti-cheat bypasses, malware, exploits against real targets, DRM/license cracks, mass account creation, exam cheating'],
  ['H2', 'Secrets exposure and prompt injection', 'Users paste live credentials into chat, agent asks for secrets in chat, repos containing jailbreak/prompt-injection files'],
])

export const THEME_GROUPS: Record<string, string> = {
  A: 'Agent judgment',
  B: 'Inefficiency',
  C: 'Tool calls',
  D: 'Tools',
  E: 'Runtime',
  F: 'Product',
  G: 'User environment',
  H: 'Trust and safety',
}

/**
 * Trust-and-safety themes. The report gives their counts only, never examples
 * or quotes: it is mailed, and the details are for the abuse tooling.
 */
export const COUNT_ONLY_THEMES: ReadonlySet<string> = new Set(['H1', 'H2'])

/** Questions about Freebuff itself, and feature requests. */
// prettier-ignore
export const PRODUCT_THEMES = themes([
  ['P1', 'Visual verification / preview on CLI, Web, Cloud', 'Let the agent open, view or screenshot the running app (browser/preview) on surfaces that lack it, or better preview tooling generally'],
  ['P2', 'Image understanding and generation', 'Agent should see attached images/screenshots/rendered frames; generate images; use pasted logos/photos as files'],
  ['P3', 'Files and workspace location', "Open/import the user's real project folder; know where files were saved; edits land in the user's checkout; download/export files, ZIPs, APKs; Files panel downloads"],
  ['P4', 'Secrets, API keys and env vars', 'Where to put keys; keys reaching the agent/backend/deployment; safe secret entry; agent requesting a key'],
  ['P5', 'Deploy, publish and hosting', 'Freebuff Sites, custom domains/URLs, Vercel/Netlify/VPS/Hostinger deploys, preview vs production mismatch, published site errors'],
  ['P6', 'Git, GitHub and change history', 'Push/PR/branch links, diffs and change lists, blocked git in Web, checkpoints/undo, version-control safety net'],
  ['P7', 'Memory across sessions', "Remember standing preferences, project context and prior chats; 'continue' across sessions; survive restarts"],
  ['P8', 'Long-running and background processes', 'Persistent dev servers, long builds/renders beyond the timeout, background jobs that survive turns/restarts, notifications when done, cancel a running job'],
  ['P9', 'Remote servers and external systems', "Run commands/migrations on the user's remote server, SSH, databases, connect to external accounts/platforms"],
  ['P10', 'Model choice and visibility', 'Which model/effort is running, change model mid-chat, pick a stronger model, context window, data/training questions'],
  ['P11', 'Free tier, session limits and usage', 'How free hours/sessions/tokens work, limits cutting work, perks, transparency about usage'],
  ['P12', 'Skills, MCP and tool integrations', 'Install/manage skills, configure MCP servers, game-engine/IDE integrations (Roblox, Godot, Unity), plugin marketplace'],
  ['P13', 'Parallel agents and delegation', 'Run subagents in parallel, split work across agents'],
  ['P14', "Control of the user's computer or browser", "Drive local apps, use the user's browser sessions, open apps on screen"],
  ['P15', 'Mobile / remote access to Freebuff', 'Use Freebuff from a phone/iPhone or another device; manage everything without a desktop'],
  ['P16', 'Documents and office files', 'Read/write .docx/.pdf/.xlsx natively, rasterize PDFs, large file output'],
  ['P17', 'Safety modes and approvals', 'Read-only/plan mode guarantees, approval prompts, undo, protecting production'],
  ['P18', 'Agent behavior wishes', 'Follow standing workflow rules (commit/push after each batch), better progress updates, fewer questions, finish without stopping, autonomy'],
  ['P19', 'Desktop app UX', 'Desktop UI language, chat/thread management (move chats between projects), restarts, preview panel quirks, notifications'],
  ['P20', 'CLI UX', 'CLI progress indicators, hints, turn status, scripting/headless mode'],
  ['P21', 'Web/Cloud product specifics', 'Freebuff Web deprecation/migration, Keys tab, Convex integration, Changes panel, Cloud workspace sync with GitHub'],
  ['P22', 'Other capability requests', 'Anything else: new features unrelated to the above'],
])

/** Why a question the user asked went unanswered. */
// prettier-ignore
export const UNANSWERED_THEMES = themes([
  ['U1', 'Status/progress question ignored', "User asked about progress or completion (did you finish? what's the status? did you analyze it?) and got no direct answer"],
  ['U2', 'Question answered with actions instead of an answer', 'Agent started editing/running tools instead of answering a direct question, or replied with follow-up chips/options'],
  ['U3', 'Answer lost to a cutoff', 'The turn died, hit max steps, was compacted or stalled before the answer was delivered'],
  ['U4', 'Could not see the referenced image/file', 'The question depended on a screenshot, image, attachment or file the agent could not access'],
  ['U5', 'Question about Freebuff itself', 'About models, limits, pricing, where files are, deploying, the app, skills or MCP; the agent did not know or answered wrongly'],
  ['U6', 'Misread or answered incorrectly', 'Agent misunderstood the question or gave a wrong/speculative answer'],
  ['U7', 'Other', 'Anything else'],
])

const ALL_THEMES = [...PROBLEM_THEMES, ...PRODUCT_THEMES, ...UNANSWERED_THEMES]
const BY_ID = new Map(ALL_THEMES.map((t) => [t.id, t]))

export function themeName(id: string): string {
  return BY_ID.get(id)?.name ?? 'Other'
}

/** A model-supplied id, checked against one list; anything else is OTHER. */
export function normalizeThemeId(
  value: unknown,
  list: readonly Theme[],
): string {
  const id = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return list.some((t) => t.id === id) ? id : OTHER_THEME
}
