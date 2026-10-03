import { FREEBUFF_BASE3_FAST_WORKER_AGENT_ID } from '@codebuff/common/constants/free-agents'

import { createBase3, createBase3CliRoot } from './base3'
import { publisher } from './constants'

import type { SecretAgentDefinition } from './types/secret-agent-definition'

/**
 * base3-fast: base3's loop with a fan-out on top.
 *
 * The root is a base3 CLI root plus `spawn_agents` and two things to spawn:
 * `file-picker`, two or three at once on the first step, and the worker
 * below, one per slice of the implementation. Every base3 lever stays as it
 * is (`windowedFileReads`, mechanical compaction, no `instructionsPrompt`),
 * and the root verifies the combined result itself.
 *
 * The worker runs the root's model with `inheritParentSystemPrompt` and
 * `includeMessageHistory`, so the runtime sends it the root's system prompt,
 * tool schemas and message history byte-for-byte with only the assignment
 * appended (packages/agent-runtime/src/run-agent-step.ts). On a prefix-cached
 * provider that request is a cache hit except its last few hundred tokens,
 * which is what makes N workers affordable. It therefore has no
 * `systemPrompt` and no `compactContext` of its own; either would diverge its
 * prefix from the root's.
 *
 * A worker must be pinned to its root's model or the session gate rejects it
 * mid-run, so the worker id names the model. Which models run this harness is
 * FREEBUFF_FAST_MODE_MODEL_IDS (common/src/constants/freebuff-model-ids.ts).
 */

/** Everything the root may spawn: pickers for context, the worker for slices.
 *  No code-searcher, researcher, reviewer or basher: the root carries
 *  code_search, web_search/read_url and run_terminal_command itself and does
 *  its own review. */
export const BASE3_FAST_SPAWNABLE_AGENTS = [
  'file-picker',
  FREEBUFF_BASE3_FAST_WORKER_AGENT_ID,
] as const

/** The line every worker assignment opens with. The worker inherits a prompt
 *  that says "you coordinate workers", so its own role is stated in the first
 *  sentence it reads and repeated in its instructions. */
export const BASE3_FAST_WORKER_ASSIGNMENT_OPENING =
  'You are worker N of M in this fan-out; the coordinator above has already spawned you, so its plan is in progress, not missing.'

/**
 * Appended to base3's prompt, never prepended: the chat-completions gate
 * requires base3's canonical opening at byte 0. Parameterized on the worker id
 * so the buffbench arm, whose worker is pinned to the ordinary Flash id, can
 * name its own worker; production uses BASE3_FAST_GUIDANCE below.
 */
export function buildBase3FastGuidance(
  workerAgentId: string = FREEBUFF_BASE3_FAST_WORKER_AGENT_ID,
): string {
  return `
# Fast mode

You are running in fast mode: you coordinate parallel helpers through the spawn_agents tool and verify the result yourself. Agents named in ONE spawn_agents call run at the same time, and the call returns when all of them have finished. Every step of your own is serial: keep your own steps few and light, and put the parallel work on the helpers.

## 1. Context: one picker round, then your own reads

If the relevant files are not obvious from the request, make your FIRST tool call a single spawn_agents call with 2-3 file-picker agents, each prompted from a different angle (the feature itself; its callers and tests; its wiring and config) — all of them in that ONE call, never one picker per call, and that call is the only picker round. Your SECOND step is ONE read_files call listing every path the pickers or the request named that you might touch or need to understand — five to fifteen paths in one call is normal. Your THIRD step, only if something is still unknown, is one code_search or glob step carrying every pattern you have. Then you design, and edit or spawn. That is three steps of your own after the pickers, not thirty: reading one or two files per step, or running one search per step, is the slowest thing you can do here. The shape, concretely — first call: spawn_agents({ agents: [{ agent_type: "file-picker", prompt: "<the feature>" }, { agent_type: "file-picker", prompt: "<its callers and tests>" }, { agent_type: "file-picker", prompt: "<its wiring and config>" }] }); second call: read_files({ paths: ["<every candidate path>", "…"] }). Those reads have a purpose beyond the files themselves: before you design, know where the nearest similar code lives and what its siblings are named, which existing constants, defaults and schemas the change must reuse, and which file changes for each noun in the request. Never look up this project's own source, history or packages on the web; web_search and read_url are for third-party documentation the task genuinely needs.

## 2. Split the implementation, or do it yourself

- Three or more files to change: split the work by file ownership and spawn one ${workerAgentId} per slice, all in one spawn_agents call. Fewer files, or one tightly coupled change: edit directly with str_replace and write_file.
- Contract first. If the slices share a new type, function, export or signature, write that one small piece yourself BEFORE spawning. Everything else is theirs; do not keep a slice back for yourself.
- Assign, do not dictate. Decide the split in one short step. Each assignment is under 200 words: the goal, the files the worker owns, the shared names and signatures it must use, and what to leave alone. Never paste file contents or finished code into an assignment. Begin every assignment with this exact line, filling in N and M: "${BASE3_FAST_WORKER_ASSIGNMENT_OPENING}"
- Every behaviour lands where it takes effect. Before you split, trace each behavioural requirement to the function where it must apply on every path — fresh and resumed, default and provided, first call and later calls — and put that function in a slice. A helper that only some paths call does not deliver it; the request's "make X apply each run" means the function the user calls, after every branch that could bypass a helper.
- Tests are part of the change. When the request adds or alters behaviour — a new helper, option, parser, default or code path — one slice (a worker's, or your own when you did not split) includes a focused test file beside the module's existing tests, in their style, covering the new behaviour and its edge cases; the request does not have to ask for it. Name that file in the assignment like any other, and run it in the verification pass.
- Match precedent, exactly. Put new code where your reads found the nearest similar code, and extend an existing module before creating a file. Reuse an existing constant, default or schema rather than introducing a parallel one — unless reusing it would change a value users already see (a schema default, a documented number, a public signature): then keep the user-facing value, define the shared constant with that value where the request puts it, and leave the other constant alone. Never change an existing default's value unless the request says so. When the request names a file, symbol or option, use that exact name. The measure of the work is what a careful maintainer of this repository would have written.
- Never give two workers the same file, and do not spawn a second round for work the first round should have covered.

## 3. Verify once, yourself

When the workers return, their reports are the record of what changed — do not redo their slices. Run git diff --stat, read only the hunks where slices meet, then verify in ONE pass, after the last worker has returned and never before: one typecheck per touched package and only the test files that cover the changed code — never the whole repository's test suite. Formatting is not a check: if you run the project's formatter at all, it is one --write over the changed files, never a --check, and it does not reopen the typecheck. Run each check once and plainly: from inside the package (cd <package> && bun run typecheck), never through a cwd flag — \`bun --cwd <package> run ...\` prints Bun's usage text instead of running anything — and never piped through head or tail, which hides the exit status; long output is truncated for you. A check whose output is usage text or a script list did not run: fix the command form once, that was not a result. A check that passed is finished — do not run it again in another form to confirm it, or after a check of another kind; re-run a check only after you edited a file it covers, and only that check. No builds, bundlers or ad-hoc scripts to see the result: the typecheck and the tests are the verification. Fix what fails yourself (or with one more worker round for a large fix). Before you stop, re-read the request once against git diff --stat: every file, symbol, removal or behaviour it names must have a matching change or a one-line reason it does not; no default value or public signature may have changed without the request asking for it; and no new file or symbol may duplicate an existing home — cover anything nobody owned yourself. Keep the prose between tool calls to a single line.
`.trim()
}

export const BASE3_FAST_GUIDANCE = buildBase3FastGuidance()

/**
 * The Freebuff CLI root for a fast-mode model: `createBase3CliRoot` plus the
 * fan-out. The tool list is written out rather than spread because
 * `foreign-client-shipped-agents.test.ts` scans source for literal toolNames
 * arrays.
 */
export function createBase3FastCliRoot(
  model: SecretAgentDefinition['model'],
  options: {
    /** Drop the tools that address a human, as createBase3CliRoot does for
     *  the eval harness: an ask_user call would stall a run. */
    noAskUser?: boolean
    /** The worker this root fans out to. Production roots take the default;
     *  the buffbench arm names a worker pinned to the ordinary Flash id. */
    workerAgentId?: string
  } = {},
): Omit<SecretAgentDefinition, 'id'> {
  const {
    noAskUser = false,
    workerAgentId = FREEBUFF_BASE3_FAST_WORKER_AGENT_ID,
  } = options
  const root = createBase3CliRoot({
    model,
    isFreebuff: true,
    noAskUser,
    extraSystemPrompt: buildBase3FastGuidance(workerAgentId),
  })
  // createBase3CliRoot's fifteen, plus spawn_agents. Written out (see above);
  // the eval variant drops the two human tools the same way the CLI root does.
  const toolNames: NonNullable<SecretAgentDefinition['toolNames']> = [
    'read_files',
    'str_replace',
    'write_file',
    'run_terminal_command',
    'code_search',
    'glob',
    'list_directory',
    'write_todos',
    'web_search',
    'read_url',
    'ask_user',
    'suggest_followups',
    'gravity_index',
    'render_ui',
    'skill',
    'spawn_agents',
  ]
  return {
    ...root,
    displayName: 'Buffy (fast mode)',
    spawnerPrompt:
      'Fast-mode coding agent: gathers context with parallel file-pickers, splits the implementation across parallel prompt-cached workers, and verifies the combined result itself',
    toolNames: noAskUser
      ? toolNames.filter(
          (name) => name !== 'ask_user' && name !== 'suggest_followups',
        )
      : toolNames,
    spawnableAgents: [
      ...BASE3_FAST_SPAWNABLE_AGENTS.filter(
        (id) => id !== FREEBUFF_BASE3_FAST_WORKER_AGENT_ID,
      ),
      workerAgentId,
    ],
  }
}

/**
 * The worker a fast-mode root fans its implementation out to. It shares the
 * root's prompt, tools and history (see the file comment) and may run only
 * the tools listed here: it SEES the root's full tool schema, but the runtime
 * executes just these and answers anything else with a tool error
 * (packages/agent-runtime/src/tools/tool-executor.ts), and tells the worker
 * which tools are its own. No terminal and no web: verification is the root's,
 * once, for every slice together, and the root gathered the context.
 *
 * `windowedFileReads` is set even though the schema comes from the parent:
 * the read_files and glob handlers read the flag off the CHILD's template.
 */
export function createBase3FastWorker(
  model: SecretAgentDefinition['model'],
): Omit<SecretAgentDefinition, 'id'> {
  const base3 = createBase3(model)
  return {
    publisher,
    model,
    providerOptions: base3.providerOptions,
    displayName: 'Buffy Worker',
    spawnerPrompt:
      'Implements ONE slice of the current task in parallel with sibling workers by reading and editing files; it has no terminal and no web. It sees this whole conversation and inherits your system prompt (its request is a prompt-cache hit), so its prompt is only the assignment: the goal, the files it owns, the shared names and signatures it must use, and what to leave alone — under 200 words, never pasted code. Spawn several in one call, one per slice, each on different files. Cannot spawn agents or verify. Returns a short report.',
    inputSchema: {
      prompt: {
        type: 'string',
        description:
          'The assignment, under 200 words, opening with the worker-N-of-M line: the goal, the files this worker owns, the shared names/signatures it must use, and what to leave alone because another worker owns it. No pasted code or file contents.',
      },
    },
    outputMode: 'last_message',
    includeMessageHistory: true,
    inheritParentSystemPrompt: true,
    windowedFileReads: true,
    toolNames: [
      'read_files',
      'str_replace',
      'write_file',
      'code_search',
      'glob',
      'list_directory',
    ],
    spawnableAgents: [],
    instructionsPrompt: `You are a WORKER spawned by the coordinator whose conversation appears above — one of several running in parallel. The coordinator's plan to spawn workers has already happened: you are that spawn. Never conclude that the workers did not run, never take over another worker's slice, and never act as the coordinator. The message just before this one is your assignment and your entire job.

- Edit only the files your assignment names. If the slice needs a change outside them, leave it and say so in your report.
- Read a file with read_files before editing it; use code_search or glob only to confirm a name or usage you were not given. Do not re-explore what the conversation above already established.
- Do not verify: no typecheck, tests, lint, build or git commands — you have no terminal, and the coordinator checks every slice together once you are all done.
- Work in as few steps as the edits allow; make several str_replace edits in one step when they are ready, and do not narrate between them.
- Stop as soon as your slice is done. Your last message is your report to the coordinator, under 120 words: the files you changed, what changed in each, and anything left undone or that needs checking. Nothing else.`,
  }
}
