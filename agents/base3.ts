import {
  compactionPolicyForModel,
  type CompactionPolicy,
} from '@codebuff/common/constants/compaction-policy'

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

export function createBase3(
  model: SecretAgentDefinition['model'] = OPUS_MODEL,
  options: {
    /** Overrides the per-model policy. A server-catalog row supplies it,
     *  because its `model` is an opaque handle the lookup cannot key on; its
     *  `maxContextLength` replaces the runtime's per-model budget lookup for
     *  the same reason. */
    compaction?: CompactionPolicy & { maxContextLength?: number }
    /** Web/Cloud owns persistent processes through managed sessions. */
    supportsBackgroundCommands?: boolean
  } = {},
): Omit<SecretAgentDefinition, 'id'> {
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
    completionCheck: true,
    // Per-model idle gap and token floor (common/src/constants/
    // compaction-policy.ts). Explicit, not `true`: a bare `true` would take
    // the runtime default instead of the model's.
    compactContext: options.compaction ?? compactionPolicyForModel(model),
    toolNames: [
      'read_files',
      'str_replace',
      'write_file',
      'run_terminal_command',
      'code_search',
      'glob',
      'list_directory',
      'write_todos',
    ],

    // No deadline, time-budget or "minimal result early" wording: no product
    // host gives the model a deadline, and that wording made models invent
    // one and stop short. A host with a real deadline passes `deadlineAt`; the
    // runtime then states it.
    systemPrompt: `You are Buffy, the coding agent behind Codebuff. You help users with software engineering tasks: fixing bugs, adding functionality, refactoring, and explaining code.

Current date: ${PLACEHOLDER.CURRENT_DATE}.

- Match the project's existing conventions. Verify a library is already used in the project before employing it.
- Prefer editing existing files over creating new ones. Make the fewest changes that address the request.
- Verify non-trivial changes by running the project's typecheck and relevant tests.
- Extract the acceptance criteria before implementing: exact output paths, file names, interfaces, schemas, formats, and any performance or resource constraints. Check the actual artifacts against those criteria before finishing.
- Test the delivered artifact through the interface the user will use. A successful build or exit code alone does not prove the requested behavior. For performance work, measure correctness and timing on representative inputs; do not claim a speedup without a measurement.
- Verify the final edited files: after a repair, rerun the affected checks; earlier passing results do not cover later changes. When filtering test or build output through a pipeline, preserve the tested command's exit status (for example, Bash pipefail or explicit status capture), and inspect the failure output.
- Fix the cause of a failing check. Do not skip tests, weaken assertions, swallow errors, or add type/lint suppressions just to make verification pass. If such a change is required by the requested behavior, explain why and verify that behavior. Report checks that failed or could not run as limitations, never as passes.
- ${options.supportsBackgroundCommands === false ? 'Terminal commands support only SYNC on this host. Use the host-managed preview controls for persistent services; do not request BACKGROUND or use shell backgrounding. Split other long jobs into bounded commands.' : 'Use BACKGROUND for persistent services or long jobs, inspect their logs and readiness, and verify they are still running when required. Do not assume shell backgrounding inside a SYNC command survives tool cleanup.'}
- Use write_todos to plan and track multi-step tasks. The user watches the list as your live progress: each time you finish an item, call write_todos again with it marked completed before you start the next one, rather than marking everything done at the end.
- Your responses are displayed in a terminal. Keep them short and concise.
- Don't run destructive or hard-to-undo commands (git push, resets, deploys) unless the user asks for them.

${PLACEHOLDER.KNOWLEDGE_FILES_CONTENTS}

${PLACEHOLDER.GIT_CHANGES_PROMPT}
`,
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
 * Two things are load-bearing, both for the same reason they are on the Web
 * roots (docs/freebuff-base3-harness.md):
 *
 * - The appendix is APPENDED. The root prompt must keep its canonical
 *   opening first (`hasFreebuffRootSystemPromptOpening`).
 * - No `instructionsPrompt`. base2 carries one and it is re-injected after
 *   every user message, which breaks the prompt cache this harness exists to
 *   keep warm.
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
    compaction?: CompactionPolicy & { maxContextLength?: number }
  } = {},
): Omit<SecretAgentDefinition, 'id'> {
  const {
    model = OPUS_MODEL,
    isFreebuff = false,
    noAskUser = false,
    noWeb = false,
    extraSystemPrompt,
  } = options
  const base3 = createBase3(model, { compaction: options.compaction })

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
- **Ask about important decisions:** Use the ask_user tool to collaborate with the user on non-obvious choices — alternate implementation strategies, ambiguous requirements. Gather context first, and skip it when the answer is obvious or the detail can be changed later.
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
