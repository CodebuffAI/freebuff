import { FREEBUFF_BASE3_FAST_WORKER_AGENT_ID } from '@codebuff/common/constants/free-agents'

import { createBase3, createBase3CliRoot } from './base3'
import { publisher } from './constants'

import type { SecretAgentDefinition } from './types/secret-agent-definition'

/**
 * base3-fast: base3's loop with a fan-out on top.
 *
 * The root is a base3 CLI root plus `spawn_agents` and three things to spawn:
 * `file-picker` and `code-searcher` for context, in parallel, and the worker
 * below for the one shape of work worth splitting — a large mechanical change
 * repeated across many independent files. The root implements everything
 * else itself: across five 62-task runs the tasks it split were the ones it
 * did worst on and no faster than base3 (docs/benchmarks/base3-fast/). Every
 * base3 lever stays as it is (`windowedFileReads`, mechanical compaction, no
 * `instructionsPrompt`), and the root reconciles and verifies the result.
 *
 * The worker runs the root's model with `inheritParentSystemPrompt` and
 * `includeMessageHistory`, so the runtime sends it the root's system prompt,
 * tool schemas and message history byte-for-byte with only the assignment
 * appended (packages/agent-runtime/src/run-agent-step.ts). On a prefix-cached
 * provider that request is a cache hit except its last few hundred tokens,
 * which is what makes N workers affordable. It therefore has no
 * `systemPrompt` and no `compactContext` of its own; either would diverge its
 * prefix from the root's. Its last message is its report to the root and
 * names the files it edited; the root reads those files to reconcile the
 * slices, so no git round-trip (and no git) is needed.
 *
 * A worker must be pinned to its root's model or the session gate rejects it
 * mid-run, so the worker id names the model. Which models run this harness is
 * FREEBUFF_FAST_MODE_MODEL_IDS (common/src/constants/freebuff-model-ids.ts).
 */

/** Everything the root may spawn: pickers and searchers for context, the
 *  worker for slices. The code-searcher is programmatic — a batch of ripgrep
 *  queries and no model call — so it needs no free-mode allowlist entry. */
export const BASE3_FAST_SPAWNABLE_AGENTS = [
  'file-picker',
  'code-searcher',
  FREEBUFF_BASE3_FAST_WORKER_AGENT_ID,
] as const

/** The line every worker assignment opens with. The worker inherits a prompt
 *  that says "you coordinate workers", so its own role is the first sentence
 *  it reads and is repeated in its instructions. */
export const BASE3_FAST_WORKER_ASSIGNMENT_OPENING =
  'You are worker N of M in this fan-out; the coordinator above has already spawned you, so its plan is in progress, not missing.'

/** What a worker may not run of base3's own tools: the terminal, because
 *  verification is the root's, once, for every slice together, and a worker
 *  with a terminal runs the suite N times in parallel; and the todo list,
 *  which is the root's plan. Everything else base3 has, the worker has. */
const WORKER_WITHHELD_TOOLS: ReadonlySet<string> = new Set([
  'run_terminal_command',
  'write_todos',
])

/**
 * Appended to base3's prompt, never prepended: the chat-completions gate
 * requires base3's canonical opening at byte 0. Parameterized on the worker id
 * so the buffbench arm, whose worker is pinned to the ordinary Flash id, can
 * name its own worker; production uses BASE3_FAST_GUIDANCE below.
 *
 * Deliberately short and mostly suggestions: the agent answers questions,
 * explores as long as it needs to, and decides when to split. What it is told
 * firmly is the one thing it would otherwise skip (spawning helpers in
 * parallel) and the one failure the fan-out invites (incoherent slices).
 */
export function buildBase3FastGuidance(
  workerAgentId: string = FREEBUFF_BASE3_FAST_WORKER_AGENT_ID,
): string {
  return `
# Fast mode

You are running in fast mode: besides your own tools you can spawn helpers with spawn_agents, and everything named in one spawn_agents call runs at the same time. Spawning context helpers in parallel is really, really helpful here and strongly encouraged. The notes below are the shape that works, not a script: when the user is asking a question, thinking something through or wants a small change, just answer or make it.

**Context.** When a task needs you to understand code you have not read, start with one spawn_agents call that spawns several file-pickers, each prompted from a different angle (the feature itself, its callers and tests, the conventions it should match), together with code-searchers, each carrying a batch of ripgrep queries for the names and patterns involved — put every query you can already think of into that first round. Then read generously: one read_files call with every path that looked relevant, rather than one file per step. Follow up with another round of code-searchers when the first points somewhere specific; a second round of file-pickers is rarely worth it. Everything you need is in the repository in front of you: do not search the web for this project's own code, history or packages.

**Implementing.** Make the change yourself. A change you hold in your head comes out coherent, and the slow part of any delegation is reading, reconciling and repairing what came back. Workers exist for one shape of work: a large, mechanical change repeated across many independent files, where each slice can be written without seeing the others, such as a rename across a tree or the same migration applied to dozens of modules. Only then spawn one ${workerAgentId} per slice, all in one spawn_agents call, after writing any piece the slices must agree on (a new type, signature or helper) yourself. Give each worker a short assignment that opens with "${BASE3_FAST_WORKER_ASSIGNMENT_OPENING}", then names the files it owns, the shared names it must use, and what belongs to another worker. Never give two workers the same file.

**If you did split, coherence is your job.** Workers run in parallel without seeing each other's edits, so the most common failure of a split is a change that is right in pieces and wrong as a whole: two slices solving the same problem two ways, a helper defined twice, a call site that does not match a new signature, a requirement that fell between slices, code that ignores how this repository already does things. Each worker's report names the files it edited. Read those files as one change: reconcile anything that disagrees, finish anything nobody owned, and check the request against what actually changed before you call it done.

**Verifying.** Verify after the last worker has returned, and verify properly: typecheck each package you touched, run the tests that cover the change (adding focused tests where the change warrants them), and when no test exercises the requested behaviour, exercise it yourself. Fix what fails and re-run what you changed until it is green. What is not worth repeating is a check that already passed on files you have not edited since, or the whole repository's suite when the covering tests exist. Run each check as a plain command so its exit status is yours to read.
`.trim()
}

export const BASE3_FAST_GUIDANCE = buildBase3FastGuidance()

/**
 * The Freebuff CLI root for a fast-mode model: `createBase3CliRoot` plus the
 * fan-out. Its toolset is the CLI root's plus `spawn_agents`, assembled rather
 * than restated; the shipped-agents CI guard imports the definition and
 * checks the list it becomes.
 */
export function createBase3FastCliRoot(
  model: SecretAgentDefinition['model'],
  options: {
    /** Drop the tools that address a human, as createBase3CliRoot does for
     *  the eval harness: an ask_user call would stall a run. */
    noAskUser?: boolean
    /** Drop the web tools, as createBase3CliRoot does for the eval harness. */
    noWeb?: boolean
    /** The worker this root fans out to. Production roots take the default;
     *  the buffbench arm names a worker pinned to the ordinary Flash id. */
    workerAgentId?: string
  } = {},
): Omit<SecretAgentDefinition, 'id'> {
  const {
    noAskUser = false,
    noWeb = false,
    workerAgentId = FREEBUFF_BASE3_FAST_WORKER_AGENT_ID,
  } = options
  const root = createBase3CliRoot({
    model,
    isFreebuff: true,
    noAskUser,
    noWeb,
    extraSystemPrompt: buildBase3FastGuidance(workerAgentId),
  })
  return {
    ...root,
    displayName: 'Buffy (fast mode)',
    spawnerPrompt:
      'Fast-mode coding agent: gathers context with parallel file-pickers and code-searchers, implements the change itself, and can split a large mechanical change across parallel prompt-cached workers that report which files they changed',
    toolNames: [...root.toolNames!, 'spawn_agents'],
    spawnableAgents: BASE3_FAST_SPAWNABLE_AGENTS.map((id) =>
      id === FREEBUFF_BASE3_FAST_WORKER_AGENT_ID ? workerAgentId : id,
    ),
  }
}

/**
 * The worker a fast-mode root fans its implementation out to. It shares the
 * root's prompt, tools and history (see the file comment) and may run only
 * base3's own tools minus WORKER_WITHHELD_TOOLS: it SEES the root's full tool
 * schema, but the runtime executes just these and answers anything else with
 * a tool error (packages/agent-runtime/src/tools/tool-executor.ts), and tells
 * the worker which tools are its own.
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
      'Implements ONE slice of the current task in parallel with sibling workers by reading and editing files; it has no terminal and no web. It sees this whole conversation and inherits your system prompt (its request is a prompt-cache hit), so brief it rather than re-explaining. Its report names every file it edited.',
    inputSchema: {
      prompt: {
        type: 'string',
        description:
          'The assignment: open with the worker-N-of-M line, then the goal, the files this worker owns, the shared names and signatures it must use, and what belongs to another worker. Brief — it already has the context above; never paste file contents or finished code.',
      },
    },
    outputMode: 'last_message',
    includeMessageHistory: true,
    inheritParentSystemPrompt: true,
    windowedFileReads: true,
    toolNames: base3.toolNames!.filter(
      (name) => !WORKER_WITHHELD_TOOLS.has(name),
    ),
    spawnableAgents: [],
    instructionsPrompt: `You are a WORKER spawned by the coordinator whose conversation appears above — one of several running in parallel. The coordinator's plan to spawn workers has already happened: you are that spawn. Never conclude that the workers did not run.

- Implement your assignment. Edit only the files it names; if the slice needs a change elsewhere, leave it and say so in your report.
- Read a file before editing it; search only to confirm a name or usage you were not given. Do not re-explore what the conversation above already established.
- Do not verify: no typecheck, tests, lint, build or git — you have no terminal, and the coordinator checks every slice together once you are all done.
- Work in as few steps as the edits allow, and stop as soon as your slice is done. Your last message is your report: every file you edited and what changed in each, plus anything left undone or worth checking, in a few sentences.`,
  }
}
