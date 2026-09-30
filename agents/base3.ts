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

    systemPrompt: `You are Buffy, the coding agent behind Codebuff. You help users with software engineering tasks: fixing bugs, adding functionality, refactoring, and explaining code.

Current date: ${PLACEHOLDER.CURRENT_DATE}.

- Match the project's existing conventions. Verify a library is already used in the project before employing it.
- Prefer editing existing files over creating new ones. Make the fewest changes that address the request.
- Verify non-trivial changes by running the project's typecheck and relevant tests.
- Use write_todos to plan and track multi-step tasks.
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
 * - The appendix is APPENDED. `hasFreebuffRootSystemPromptOpening` requires a
 *   canonical opening at byte 0, so prepending 403s every free-mode turn.
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
    /** The model's human name, for the meta-information line. A server
     *  catalog root's `model` is an opaque handle, which must not be what the
     *  prompt tells the model it is running on. */
    modelLabel?: string
    /** See createBase3. */
    compaction?: CompactionPolicy & { maxContextLength?: number }
  } = {},
): Omit<SecretAgentDefinition, 'id'> {
  const { model = OPUS_MODEL, isFreebuff = false, noAskUser = false } = options
  const base3 = createBase3(model, { compaction: options.compaction })

  const root: Omit<SecretAgentDefinition, 'id'> = {
    ...base3,
    // Written out rather than spread from `base3.toolNames`, because
    // `foreign-client-shipped-agents.test.ts` scans source for literal
    // toolNames arrays and asserts none of ours reads as a third-party
    // harness — a toolset assembled at runtime is invisible to that scan,
    // which is how `freebuff-desktop-autorun` shipped flagged.
    //
    // The first eight are base3's own. `web_search`/`read_url` replace the
    // researcher subagents base2 spawned. The last five are CLI product
    // surface, not harness: they drive the ask-user panel, the followup
    // cards, service discovery, rendered UI, and skills.
    toolNames: [
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
    ],
    systemPrompt: `${base3.systemPrompt}
${buildCliAppendix({
  isFreebuff,
  model: options.modelLabel ?? model,
  noAskUser,
})}`,
  }

  if (!noAskUser) return root
  return {
    ...root,
    toolNames: root.toolNames?.filter((name) => !HUMAN_TOOL_NAMES.has(name)),
  }
}

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
