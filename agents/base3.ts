import {
  compactionPolicyForModel,
  type RootCompactionPolicy,
} from '@codebuff/common/constants/compaction-policy'
import { BASE3_BATCHING_STEP_PROMPT } from '@codebuff/common/constants/base3-step-prompt'
import {
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID,
  FREEBUFF_SOLAR_MINI_4_MODEL_ID,
  FREEBUFF_SOLAR_PRO_4_MODEL_ID,
  freebuffModelIdMatches,
} from '@codebuff/common/constants/freebuff-models'
import {
  TURN_ENDING_NOTE,
  TURN_ENDING_RULE,
} from '@codebuff/common/constants/turn-ending-rule'
import {
  AGENT_PROGRESS_GUIDANCE,
  AGENT_VERIFICATION_GUIDANCE,
  WORKSPACE_QUESTION_GUIDANCE,
} from '@codebuff/common/constants/agent-work-style'

import { leanContextGuidance } from './lean-context'
import {
  FOLLOWUP_STYLE_GUIDANCE,
  gravityIndexGuidance,
  OPUS_MODEL,
  publisher,
  SKILL_DISCOVERY_GUIDANCE,
} from './constants'
import {
  PLACEHOLDER,
  type SecretAgentDefinition,
} from './types/secret-agent-definition'

/**
 * Working in batches, appended to base3's prompt for the roots that ask for it
 * (`batching`) on the models in BATCHING_MODELS. Every response re-sends the
 * conversation, so the same work in fewer responses is faster and cheaper
 * (docs/benchmarks/base3-batched/README.md).
 * It comes after the dynamic context, outside the core the server compares
 * (web/src/llm-api/root-instruction-contract.ts), so older clients still match.
 * Deliberately NOT repeated as a per-step `stepPrompt`: a step prompt is
 * deleted each step, so no request is a prefix of the next and the prompt
 * cache collapses (#1158; measured in the benchmark doc above).
 */
const BATCHING_GUIDANCE = `## Work in batches

Every response is a round trip: the whole conversation is sent again before the next reply begins, so a task done in fewer responses finishes sooner and costs less. Get as much done in each response as you can.

- **Make every call you already can.** Tool calls that do not depend on each other's results belong in one response, not in a sequence of responses.
- **Search in one batch.** When you need to find something, send every code_search and glob you can think of together (the names, strings and paths it could be under), rather than one search per response.
- **Read in one batch.** Read every file that looks relevant in one read_files call, often 5 to 15 of them, including the ones you expect to need next, rather than one file at a time. Go back for more only when what you read points to something specific.
- **Explore with the dedicated tools.** code_search, glob, list_directory and read_files take many patterns or paths per call; ls, cat, grep and find in the terminal do not.
- **Edit in one batch.** Make all the edits you already know in one response.
- **Check in one batch.** Run the checks in the same response as your last edits, as one terminal command that runs every check the change needs (for example each touched package's typecheck and the tests that cover the change), each with its exit status echoed and not piped into head or tail.
- **Stop when it is done.** Once the request is met and its checks pass, or the question is answered, give the final message.`

/**
 * The models the section and its reminder are measured to help: on DeepSeek
 * V4.1 Flash they finished sooner at the same score. On GPT-6 Luna the section
 * bought no time, and on MiMo v2.5 it cost score, so both keep base3's prompt
 * as it was (docs/benchmarks/base3-batched/README.md). Add a model only with a
 * paired buffbench run on it that also checks its cache hit: the reminder
 * comes with the section.
 */
const BATCHING_MODELS = [FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID]

/**
 * The models that end a turn on a status line or a plan instead of calling the
 * tool that does the work, and so get TURN_ENDING_NOTE as `instructionsPrompt`
 * — the rule again, right after every user message. The system prompt's
 * TURN_ENDING_RULE alone does not stop them (docs/freebuff-muse-spark.md).
 * Every copy stays in history, so the cached prefix only grows.
 *
 * Muse Spark 1.3 has been here since 2026-10-11, and the note measurably
 * worked: across the Desktop 0.0.171 -> 0.0.172 boundary its short
 * status-line turns (no tool call, 20-400 characters) fell from 8.5% to 2.9%
 * of turns.
 *
 * Solar Pro 4 and Solar Mini 4 joined on 2026-10-14, after five reports in a
 * week ("solar pro keep not replying me when it finish my task", "do not write
 * code into the project") and this measurement over 24h of completed,
 * user-initiated Desktop turns (`desktop.turn_completed`), prose-only meaning
 * zero tool calls and over 1,000 characters of reply:
 *
 *   upstage/solar-pro4           12,742 turns  24.0% prose-only
 *   upstage/solar-mini4           2,302 turns  18.8%
 *   z-ai/glm-5.3-flash           15,484 turns   6.9%
 *   deepseek/deepseek-v4-flash   33,165 turns   1.7%
 *
 * It is not the user mix: among the 402 users with 3+ turns on both models in
 * that window, Solar Pro 4 ended 41.7% of turns with no tool call against
 * DeepSeek V4 Flash's 17.1%. Truncated tool calls (0.25% of turns) and tool
 * markup written as prose (1.3%, LOWER than DeepSeek's 2.0%) are both far too
 * small to be the cause.
 *
 * The note addresses the status-line half. The long-prose half — a model that
 * has decided the request was a question — is a prompt question the note's
 * last sentence arguably licenses, and wants an eval rather than a patch.
 */
const TURN_ENDING_NOTE_MODELS = [
  FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID,
  FREEBUFF_SOLAR_PRO_4_MODEL_ID,
  FREEBUFF_SOLAR_MINI_4_MODEL_ID,
]

export function createBase3(
  model: SecretAgentDefinition['model'] = OPUS_MODEL,
  options: {
    /** Overrides the per-model policy. A server-catalog row supplies it,
     *  because its `model` is an opaque handle the lookup cannot key on; its
     *  `maxContextLength` replaces the runtime's per-model budget lookup for
     *  the same reason. `lean` (with a `maxContextLength`) adds the
     *  context-budget prompt section. */
    compaction?: RootCompactionPolicy
    /** Web/Cloud owns persistent processes through managed sessions. */
    supportsBackgroundCommands?: boolean
    /** Append the "Work in batches" section, on a model in BATCHING_MODELS.
     *  For the roots that run the user's coding agent in build mode: the CLI
     *  (`createBase3CliRoot`), Desktop and Desktop Cloud. Plan mode, fast mode,
     *  sponsored runs and Web/Cloud (whose platform runs the checks) leave it
     *  off, and a lean row never gets it: its context budget says to read
     *  narrowly. */
    batching?: boolean
    /** The compiled model a catalog handle stands for, which decides the
     *  per-model parts below; defaults to `model`. */
    compiledModelId?: string
    /** Desktop and the current Cloud workspace omit todos and ask only when blocked. */
    workspace?: boolean
  } = {},
): Omit<SecretAgentDefinition, 'id'> {
  const turnEndingNote = TURN_ENDING_NOTE_MODELS.some((id) =>
    freebuffModelIdMatches(options.compiledModelId ?? model, id),
  )
  const batchingModel = BATCHING_MODELS.some((id) =>
    freebuffModelIdMatches(options.compiledModelId ?? model, id),
  )
  const { lean, ...compactContext }: RootCompactionPolicy =
    options.compaction ?? compactionPolicyForModel(model)
  const leanGuidance =
    lean && compactContext.maxContextLength
      ? `\n${leanContextGuidance(compactContext.maxContextLength)}\n`
      : ''
  const batching = options.batching === true && batchingModel && !lean
  return {
    publisher,
    model,
    providerOptions: model.startsWith('anthropic/')
      ? { only: ['amazon-bedrock'], data_collection: 'deny' }
      : { data_collection: 'deny' },
    displayName: 'Buffy',
    spawnerPrompt:
      'Single-loop coding agent that explores, edits, and verifies directly with its own tools',
    inputSchema: {
      prompt: {
        type: 'string',
        description: 'A coding task to complete',
      },
    },
    outputMode: 'last_message',
    includeMessageHistory: true,
    windowedFileReads: true,
    // A root built on this that can spawn lists those agents once, at the end
    // of its system prompt, not in a message after every user prompt that
    // stays in history.
    spawnableAgentsInSystemPrompt: true,
    // Per-model idle gap and token floor (common/src/constants/
    // compaction-policy.ts). Explicit, not `true`: a bare `true` would take
    // the runtime default instead of the model's.
    compactContext,
    ...(turnEndingNote ? { instructionsPrompt: TURN_ENDING_NOTE } : {}),
    // The section's reminder at the end of every step, dropped from history
    // after it. Read once, Flash drifts back to one call per step; repeated,
    // it keeps batching. A step prompt is deleted each step, so no request
    // extends the previous one: a provider that caches only exact prefix
    // extensions then misses most of every request (MiMo and Luna did,
    // #1158), while Flash's lanes cache partial prefixes and kept their hit
    // rate. The server skips it where it reads the user's own words
    // (`isRootStepReminderMessage`).
    ...(batching ? { stepPrompt: BASE3_BATCHING_STEP_PROMPT } : {}),
    toolNames: [
      'read_files',
      'str_replace',
      'write_file',
      'run_terminal_command',
      'code_search',
      'glob',
      'list_directory',
      ...(options.workspace ? [] : ['write_todos'] as const),
    ],

    // No deadline, time-budget or "minimal result early" wording: no product
    // host gives the model a deadline, and that wording made models invent
    // one and stop short. A host with a real deadline passes `deadlineAt`; the
    // runtime then states it.
    systemPrompt: `You are Buffy, the coding agent behind Codebuff. You help users with software engineering tasks: fixing bugs, adding functionality, refactoring, and explaining code.

Current date: ${PLACEHOLDER.CURRENT_DATE}.

- Size the work to the request. Do everything the user asked for, completely, and nothing they did not: no unrequested features, refactors, new files, dependencies or polish. A question gets an answer, not a change. A small or specific request gets a direct fix, without a plan, a to-do list or a survey of the codebase.
- ${options.workspace ? WORKSPACE_QUESTION_GUIDANCE : 'When a request is open-ended or high-level ("build me an app", "improve the onboarding", "make this faster") and reasonable readings differ in size or direction, settle the scope yourself, build the smallest version that meets the goal, then name the main choices you made and what could come next. Do not build the largest version you can imagine.'}
- Match the project's existing conventions. Verify a library is already used in the project before employing it.
- Prefer editing existing files over creating new ones. Make the fewest changes that address the request.
- Note the request's explicit requirements (exact output paths, file names, interfaces, schemas, formats, performance or resource constraints) and check the result against them before finishing.
- For performance work, do not claim a speedup without a measurement.
- Verify the final edited files: after a repair, rerun the affected checks; earlier passing results do not cover later changes. When filtering test or build output through a pipeline, preserve the tested command's exit status (for example, Bash pipefail or explicit status capture), and inspect the failure output.
- Take screenshots or drive a browser for visual inspection only when the user explicitly asks for a screenshot or a visual check.
- Fix the cause of a failing check. Do not skip tests, weaken assertions, swallow errors, or add type/lint suppressions just to make verification pass. If such a change is required by the requested behavior, explain why and verify that behavior. Report checks that failed or could not run as limitations, never as passes.
- ${options.supportsBackgroundCommands === false ? 'Terminal commands support only SYNC on this host. Use the host-managed preview controls for persistent services; do not request BACKGROUND or use shell backgrounding. Split other long jobs into bounded commands.' : 'Use BACKGROUND for persistent services or long jobs, inspect their logs and readiness, and verify they are still running when required. Do not assume shell backgrounding inside a SYNC command survives tool cleanup.'}
${options.workspace ? '' : '- Use write_todos only for work with several distinct steps, and list only the steps the request needs, never extras you might add. The user watches the list as your live progress: each time you finish an item, call write_todos again with it marked completed before you start the next one, rather than marking everything done at the end.\n'}- When the work is done, finish every tool call first${options.workspace ? '' : ' (including marking your last to-do completed)'}, then end with a self-contained final message. Do not point back to earlier messages ("as above"); the user may see only this one.
- ${TURN_ENDING_RULE}
- Don't run destructive or hard-to-undo commands (git push, resets, deploys) unless the user asks for them.
- Stay inside the project folder. Do not read, list or search files outside it (the home directory, other projects, app or system folders) unless the user gave you that exact path or asked you to look there, and then only that path, not its parent or sibling folders. If the task seems to need anything else outside the project, ask the user first.

${AGENT_PROGRESS_GUIDANCE}

When a progress update is warranted and more work remains, put it before the next tool call in the same response so the update does not end the turn.

${AGENT_VERIFICATION_GUIDANCE}

${PLACEHOLDER.KNOWLEDGE_FILES_CONTENTS}

${PLACEHOLDER.GIT_CHANGES_PROMPT}
${leanGuidance}${batching ? `\n${BATCHING_GUIDANCE}` : ''}`,
  }
}

/**
 * The CLI's own base3 roots — Codebuff's DEFAULT and LITE modes, and every
 * Freebuff model the picker offers.
 *
 * Kept separate from `createBase3` rather than folded into it, because Freebuff
 * Desktop derives its toolset from `createBase3().toolNames` and would silently
 * inherit whatever is added here (THREAD_AGENT_TOOLS in
 * freebuff-desktop/.../thread-agent.ts unions that array with its own extras).
 * The bare eight are the harness; what follows is CLI product surface.
 *
 * One thing is load-bearing, for the same reason it is on the Web roots
 * (docs/freebuff-base3-harness.md): the appendix is APPENDED. The root prompt
 * must keep its canonical opening first (`hasFreebuffRootSystemPromptOpening`).
 */
export function createBase3CliRoot(
  options: {
    model?: SecretAgentDefinition['model']
    /** Freebuff branding and meta-information instead of Codebuff's. */
    isFreebuff?: boolean
    /** Drop the tools that address a human. For the eval harness, where an
     *  ask_user call would stall the run rather than gather anything. */
    noAskUser?: boolean
    /** Drop web_search and read_url. For the eval harness: the evaluated
     *  repositories are public, and a search result that quotes their
     *  current code is the answer key (36% of base3's search results in the
     *  2026-10-04 runs cited the repository under evaluation). */
    noWeb?: boolean
    /** Harness guidance that belongs BETWEEN base3's prompt and the CLI
     *  appendix (base3-fast's fan-out section). Appended, never prepended,
     *  for the reason the appendix is: the canonical opening stays at byte 0. */
    extraSystemPrompt?: string
    /** The model's human name, for the meta-information line. A server
     *  catalog root's `model` is an opaque handle, which must not be what the
     *  prompt tells the model it is running on. */
    modelLabel?: string
    /** See createBase3. */
    compaction?: RootCompactionPolicy
    /** See createBase3. */
    compiledModelId?: string
    /** See createBase3. On for CLI roots; the sponsored and fast-mode roots
     *  turn it off. */
    batching?: boolean
  } = {},
): Omit<SecretAgentDefinition, 'id'> {
  const {
    model = OPUS_MODEL,
    isFreebuff = false,
    noAskUser = false,
    noWeb = false,
    extraSystemPrompt,
  } = options
  const base3 = createBase3(model, {
    compaction: options.compaction,
    compiledModelId: options.compiledModelId,
    batching: options.batching ?? true,
  })

  const root: Omit<SecretAgentDefinition, 'id'> = {
    ...base3,
    // base3's own eight, then the CLI surface: `web_search`/`read_url`
    // replace the researcher subagents base2 spawned; the last five drive the
    // ask-user panel, the followup cards, service discovery, rendered UI and
    // skills. (The shipped-agents CI guard checks this toolset by importing
    // the definitions, so it may be assembled rather than restated.)
    toolNames: [
      ...base3.toolNames!,
      'web_search',
      'read_url',
      'ask_user',
      'suggest_followups',
      'gravity_index',
      'render_ui',
      'skill',
    ],
    systemPrompt: `${base3.systemPrompt}
${extraSystemPrompt ? `${extraSystemPrompt}\n` : ''}${buildCliAppendix({
      isFreebuff,
      model: options.modelLabel ?? model,
      noAskUser,
    })}`,
  }

  const withheld = new Set<string>([
    ...(noAskUser ? HUMAN_TOOL_NAMES : []),
    ...(noWeb ? WEB_TOOL_NAMES : []),
  ])
  if (withheld.size === 0) return root
  return {
    ...root,
    toolNames: root.toolNames?.filter((name) => !withheld.has(name)),
  }
}

/** The web, which the eval harness withholds from both arms (see `noWeb`). */
const WEB_TOOL_NAMES: ReadonlySet<string> = new Set(['web_search', 'read_url'])

/** Offered only when there is a human on the other end. */
const HUMAN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'ask_user',
  'suggest_followups',
])

function buildCliAppendix({
  isFreebuff,
  model,
  noAskUser = false,
}: {
  isFreebuff: boolean
  /** The model id, or its human name when the id is an opaque handle. */
  model: string
  noAskUser?: boolean
}): string {
  return `
# Working with the user
${
  noAskUser
    ? ''
    : `
- **Suggest next steps:** At the end of your turn, use the suggest_followups tool to suggest ~3 next steps the user might want to take. ${FOLLOWUP_STYLE_GUIDANCE}`
}
${gravityIndexGuidance()}
${SKILL_DISCOVERY_GUIDANCE}

# ${isFreebuff ? 'Freebuff' : 'Codebuff'} Meta-information

You are running on the ${model} model.

${
  isFreebuff
    ? 'You are the AI agent behind Freebuff, a tool where users can chat with you to code with AI for free. See freebuff.com for more information about the product.'
    : [
        'Users send prompts to you in one of a few user-selected modes, like DEFAULT, LITE, MAX, or PLAN.',
        "Every prompt sent consumes the user's credits, which is calculated based on the API cost of the models used.",
        'The user can use the "/usage" command to see how many credits they have used and have left, so you can tell them to check their usage this way.',
        'For other questions, you can direct them to codebuff.com, or especially codebuff.com/docs for detailed information about the product.',
      ].join('\n')
}

${PLACEHOLDER.SYSTEM_INFO_PROMPT}
`
}

/** Codebuff's DEFAULT mode. */
const definition: SecretAgentDefinition = {
  ...createBase3CliRoot(),
  id: 'base3',
}

export default definition
