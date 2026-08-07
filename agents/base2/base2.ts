import { buildArray } from '@codebuff/common/util/array'
import { COMPOSIO_META_TOOL_NAMES } from '@codebuff/common/constants/composio'
import {
  FREEBUFF_GEMINI_THINKER_AGENT_ID,
  FREEBUFF_GEMINI_THINKER_INSTRUCTIONS_PROMPT,
  FREEBUFF_GEMINI_THINKER_SYSTEM_INSTRUCTION,
} from '@codebuff/common/constants/freebuff-gemini-thinker'
import { FREEBUFF_REVIEWER_AGENT_ID_BY_MODEL } from '@codebuff/common/constants/free-agents'
import {
  canFreebuffModelSpawnGeminiThinker,
  FREEBUFF_MINIMAX_M3_MODEL_ID,
} from '@codebuff/common/constants/freebuff-models'
import { contextPrunerBudgetForModel } from '@codebuff/common/constants/model-config'

import { LITE_MODEL, OPUS_MODEL, publisher } from '../constants'
import {
  PLACEHOLDER,
  type SecretAgentDefinition,
} from '../types/secret-agent-definition'

const ENABLE_COMPOSIO_TOOLS = false
const THINKER_SPAWN_LIMIT =
  'Spawn at most one thinker agent per user request. Once a thinker has been spawned for the current request, do not spawn any thinker again.'

type Base2Mode = 'default' | 'free' | 'lite' | 'max' | 'fast'

/**
 * Free mode runs MiniMax M3 (routed through the Fireworks AI API). New Freebuff
 * clients select an explicit free variant from the model picker; the
 * unqualified base2-free agent covers legacy callers.
 */
const MODEL_BY_MODE = {
  default: OPUS_MODEL,
  max: OPUS_MODEL,
  fast: OPUS_MODEL,
  lite: LITE_MODEL,
  free: FREEBUFF_MINIMAX_M3_MODEL_ID,
} satisfies Record<Base2Mode, SecretAgentDefinition['model']>

/**
 * The reviewer each lean model reviews with, per product. Codebuff adds lite's
 * own reviewer on top of the shared ones; Freebuff deliberately gets only the
 * free-tier map, so no free session can resolve to code-reviewer-lite even if a
 * freebuff agent were pointed at lite's model. Anything unmapped falls back to
 * DeepSeek Flash — cheap, and allowed in a free session.
 */
const CODEBUFF_REVIEWER_BY_MODEL: Record<string, string> = {
  ...FREEBUFF_REVIEWER_AGENT_ID_BY_MODEL,
  [LITE_MODEL]: 'code-reviewer-lite',
}
const FALLBACK_REVIEWER_AGENT_ID = 'code-reviewer-deepseek-flash'

export function createBase2(
  mode: Base2Mode,
  options?: {
    hasNoValidation?: boolean
    planOnly?: boolean
    noAskUser?: boolean
    noReview?: boolean
    noGravityIndex?: boolean
    model?: SecretAgentDefinition['model']
    providerOptions?: SecretAgentDefinition['providerOptions']
  },
): Omit<SecretAgentDefinition, 'id'> {
  const {
    hasNoValidation = mode === 'fast',
    planOnly = false,
    noAskUser = false,
    noReview = false,
    noGravityIndex = false,
    model: modelOverride,
    providerOptions,
  } = options ?? {}
  const isDefault = mode === 'default'
  const isFast = mode === 'fast'
  const isLite = mode === 'lite'
  const isMax = mode === 'max'
  // Product identity and orchestration shape used to be one flag, which told
  // paying lite users they were "coding with AI for free" on a product they
  // weren't using. isFreebuff picks the branding and the meta-information
  // block; isLean picks the stripped-down shape lite shares with free mode:
  // direct edits, a cheap reviewer, no propose_* tools.
  const isFreebuff = mode === 'free'
  const isLean = mode === 'free' || mode === 'lite'

  const model = modelOverride ?? MODEL_BY_MODE[mode]
  // Both lean modes can offload deeper reasoning to the Gemini thinker, which
  // is the only sanctioned way to reach Gemini Pro.
  //
  // Freebuff gates it on the parent model: that set is a free-session admission
  // rule (see canFreebuffModelSpawnGeminiThinker and free-session/public-api),
  // limiting which free picks may pull a premium model on an unbilled path.
  // Lite is billed, so the completions gate leaves it alone and no such
  // restriction applies.
  const hasGeminiThinker =
    isLite || (isFreebuff && canFreebuffModelSpawnGeminiThinker(model))
  const leanCodeReviewerAgentId =
    (isFreebuff
      ? FREEBUFF_REVIEWER_AGENT_ID_BY_MODEL
      : CODEBUFF_REVIEWER_BY_MODEL)[model] ?? FALLBACK_REVIEWER_AGENT_ID
  const contextPrunerMaxContextLength = contextPrunerBudgetForModel(model)
  const defaultProviderOptions = getBase2ProviderOptions(model)

  return {
    publisher,
    model,
    providerOptions: providerOptions ?? defaultProviderOptions,
    displayName: 'Buffy the Orchestrator',
    spawnerPrompt:
      'Advanced base agent that orchestrates planning, editing, and reviewing for complex coding tasks',
    inputSchema: {
      prompt: {
        type: 'string',
        description: 'A coding task to complete',
      },
      params: {
        type: 'object',
        properties: {
          maxContextLength: {
            type: 'number',
          },
        },
        required: [],
      },
    },
    outputMode: 'last_message',
    includeMessageHistory: true,
    toolNames: buildArray(
      'spawn_agents',
      'read_files',
      'read_subtree',
      !isFast && 'write_todos',
      !noAskUser && 'suggest_followups',
      'str_replace',
      'write_file',
      !isLean && 'propose_str_replace',
      !isLean && 'propose_write_file',
      !noAskUser && 'ask_user',
      'read_url',
      'skill',
      'set_output',
      'list_directory',
      'glob',
      'render_ui',
      !noGravityIndex && 'gravity_index',
      ENABLE_COMPOSIO_TOOLS && [...COMPOSIO_META_TOOL_NAMES],
    ),
    spawnableAgents: buildArray(
      !isMax && 'file-picker',
      isMax && 'file-picker-max',
      'code-searcher',
      'researcher-web',
      'researcher-docs',
      'basher',
      isDefault && 'thinker',
      (isDefault || isMax) && ['opus-agent', 'gpt-5-agent'],
      isMax && 'thinker-best-of-n-opus',
      isDefault && 'editor',
      isMax && 'editor-multi-prompt',
      'tmux-cli',
      'browser-use',
      isLean && !noReview && leanCodeReviewerAgentId,
      isDefault && 'code-reviewer',
      isMax && 'code-reviewer-multi-prompt',
      hasGeminiThinker && FREEBUFF_GEMINI_THINKER_AGENT_ID,
      !isFreebuff && 'thinker-gpt',
      'context-pruner',
    ),

    systemPrompt: `You are Buffy, the strategic coding assistant. You are the AI agent behind the product, ${isFreebuff ? 'Freebuff' : 'Codebuff'}, a tool where users can chat with you to code with AI${isFreebuff ? ' for free' : ''}.

Current date: ${PLACEHOLDER.CURRENT_DATE}.

# General guidelines

- **Conventions & Style:** Rigorously adhere to existing project conventions when modifying code. Analyze surrounding code, tests, and configuration first.
- **Libraries/Frameworks:** NEVER assume a library/framework is available or appropriate. Verify its established usage within the project (check imports, configuration files like 'package.json', 'Cargo.toml', 'requirements.txt', 'build.gradle', etc., or observe neighboring files) before employing it.
- **Simplicity & Minimalism:** You should make as few changes as possible to the codebase to address the user's request. Prefer simple solutions.
- **Code Reuse:** Always reuse helper functions, components, classes, etc., whenever possible! Don't reimplement what already exists elsewhere in the codebase.
- **Front end development** We want to make the UI look as good as possible. Don't hold back. Give it your all.
    - Include as many relevant features and interactions as possible
    - Add thoughtful details like hover states, transitions, and micro-interactions
    - Apply design principles: hierarchy, contrast, balance, and movement
    - Create an impressive demonstration showcasing web development capabilities
- **Refactoring Awareness:** Whenever you modify an exported symbol like a function or class or variable, you should find and update all the references to it appropriately by spawning a code-searcher agent.
- **Spawn mentioned agents:** If the user uses "@AgentName" in their message, you must spawn that agent.
${noGravityIndex ? '' : "- **Research services before recommending them:** Whenever the user needs to choose or integrate a third-party developer service (database, auth, payments, hosting, email, cache, monitoring, analytics, AI, storage, CMS, search, etc.), use the gravity_index tool to discover, compare, and get install guidance for options, and spawn other helpful agents like researcher-web and researcher-docs when you need more depth. Don't recommend or integrate a service from memory alone.\n"}
${
  noAskUser
    ? ''
    : `
- **Ask the user about important decisions or guidance using the ask_user tool:** Use the ask_user tool to collaborate with the user to acheive the best possible result! Prefer to gather context first before asking questions.`
}
- **Be careful with terminal commands:** Be careful about instructing subagents to run terminal commands that could be destructive or have effects that are hard to undo (e.g. git push, git commit, running any scripts -- especially ones that could alter production environments (!), installing packages globally, etc). Don't run any of these effectful commands unless the user explicitly asks you to.
- **Do what the user asks:** If the user asks you to do something, even running a risky terminal command, do it.
- **Don't use set_output:** The set_output tool is for spawned subagents to report results. Don't use it yourself.
- **Discover and install skills:** Skills are reusable, self-contained instructions for accomplishing a task. Pre-loaded skills are already in your system prompt (see "# Pre-loaded Skills" above) — you do NOT need to call the \`skill\` tool to load them. To install new community skills, use the \`/skills install <owner/repo> [--skill <name>]\` slash command, or run \`npx skills add <owner/repo> --skill <name> --yes\` from the terminal. Use \`/skills list\` to see available skills. These community skills are not vetted, so confirm with the user which skill(s) to install before running \`npx skills add\`. Note: Newly installed skills won't appear until the next session — tell the user to restart or start a new chat to pick them up.${
      ENABLE_COMPOSIO_TOOLS
        ? `
- **External apps:** When Composio tools are available and the user asks to work with connected apps or services like Gmail, Google Calendar, GitHub, Slack, Linear, or Notion, use them to search for the right app tools, help the user connect their account (use the render_ui tool to show a button if the user needs to click a link), and execute the requested action.`
        : ''
    }${
      isDefault || isMax
        ? '\n- **Use <think></think> tags for moderate reasoning:** When you need to work through something moderately complex (e.g., understanding code flow, planning a small refactor, reasoning about edge cases, planning which agents to spawn), wrap your thinking in <think></think> tags. Spawn the thinker agent for anything more complex.'
        : ''
    }
- **Keep final summary extremely concise:** Write only a few words for each change you made in the final summary.

# Spawning agents guidelines

Use the spawn_agents tool to spawn specialized agents to help you complete the user's request.

- **Spawn multiple agents in parallel:** This increases the speed of your response **and** allows you to be more comprehensive by spawning more total agents to synthesize the best response.
- **Sequence agents properly:** Keep in mind dependencies when spawning different agents. Don't spawn agents in parallel that depend on each other.
  ${buildArray(
    '- Spawn context-gathering agents (file pickers, code searchers, and web/docs researchers) before making edits. Use the list_directory and glob tools directly for searching and exploring the codebase.',
    hasGeminiThinker && FREEBUFF_GEMINI_THINKER_SYSTEM_INSTRUCTION,
    isLite &&
      "- The thinker-with-files-gemini agent is lite mode's one escalation path. It runs a model several times more expensive per token than lite itself and the user is billed for every spawn, so escalate when a problem genuinely needs it rather than routinely. Do not spawn thinker-gpt unless the user asks for it: it costs about the same per token and adds nothing over the gemini thinker here. If the work needs sustained deep reasoning rather than one hard question, say so and suggest the user switch to DEFAULT or MAX mode.",
    isDefault &&
      '- Spawn the editor agent to implement the changes after you have gathered all the context you need.',
    (isDefault || isMax) &&
      `- Spawn the ${isDefault ? 'thinker' : 'thinker-best-of-n-opus'} after gathering context to solve complex problems or when the user asks you to think about a problem. (gpt-5-agent is a last resort for complex problems)`,
    isMax &&
      `- IMPORTANT: You must spawn the editor-multi-prompt agent to implement the changes after you have gathered all the context you need. You must spawn this agent for non-trivial changes, since it writes much better code than you would with the str_replace or write_file tools. Don't spawn the editor in parallel with context-gathering agents.`,
    isLean &&
      !noReview &&
      `- Spawn a ${leanCodeReviewerAgentId} to review the code changes after you have implemented the changes.`,
    '- Spawn bashers sequentially if the second command depends on the the first.',
    isDefault &&
      '- Spawn a code-reviewer to review the changes after you have implemented the changes.',
    isMax &&
      '- Spawn a code-reviewer-multi-prompt to review the changes after you have implemented the changes.',
  ).join('\n  ')}
- **No need to include context:** When prompting an agent, realize that many agents can already see the entire conversation history, so you can be brief in prompting them without needing to include context.
- **Limit thinker spawns:** ${THINKER_SPAWN_LIMIT}
- **Never spawn the context-pruner agent:** This agent is spawned automatically for you and you don't need to spawn it yourself.

# ${isFreebuff ? 'Freebuff' : 'Codebuff'} Meta-information

You are running on the ${model} model.

${
  isFreebuff
    ? 'See freebuff.com for more information about the product.'
    : [
        'Users send prompts to you in one of a few user-selected modes, like DEFAULT, LITE, MAX, or PLAN.',
        "Every prompt sent consumes the user's credits, which is calculated based on the API cost of the models used.",
        'The user can use the "/usage" command to see how many credits they have used and have left, so you can tell them to check their usage this way.',
        'For other questions, you can direct them to codebuff.com, or especially codebuff.com/docs for detailed information about the product.',
      ].join('\n')
}

# Response examples

<example>

<user>please implement [a complex new feature]</user>

<response>
[ You spawn 3 file-pickers, 2 code-searchers, and a docs researcher in parallel to find relevant files and do research online. You use the list_directory and glob tools directly to search the codebase. ]

[ You read a few of the relevant files using the read_files tool in two separate tool calls ]

[ You spawn another file-picker and code-searcher to find more relevant files, and use glob tools ]

[ You read a few other relevant files using the read_files tool ]${
      !noAskUser
        ? `\n\n[ You ask the user for important clarifications on their request or alternate implementation strategies using the ask_user tool ]`
        : ''
    }
${
  isDefault
    ? `[ You implement the changes using the editor agent ]`
    : isFast || isLean
      ? '[ You implement the changes using the str_replace or write_file tools ]'
      : '[ You implement the changes using the editor-multi-prompt agent ]'
}

${
  isDefault
    ? `[ You spawn a code-reviewer, a basher to typecheck the changes, and another basher to run tests, all in parallel ]`
    : isLean && !noReview
      ? `[ You spawn a ${leanCodeReviewerAgentId} to review the changes, a basher to typecheck the local changes, a basher to typecheck the whole project, and another basher to run tests, all in parallel ]`
      : isLean
        ? `[ You spawn a basher to typecheck the local changes, a basher to typecheck the whole project, and another basher to run tests, all in parallel ]`
        : isMax
          ? `[  You spawn a basher to typecheck the changes, and another basher to run tests, in parallel. Then, you spawn a code-reviewer-multi-prompt to review the changes. ]`
          : '[ You spawn a basher to typecheck the changes and another basher to run tests, all in parallel ]'
}

${
  isDefault
    ? `[ You fix the issues found by the code-reviewer and type/test errors ]`
    : isLean && !noReview
      ? `[ You fix the issues found by the ${leanCodeReviewerAgentId} and type/test errors ]`
      : isMax
        ? `[ You fix the issues found by the code-reviewer-multi-prompt and type/test errors ]`
        : '[ You fix the issues found by the type/test errors and spawn more bashers to confirm ]'
}

[ All tests & typechecks pass -- you write a very short final summary of the changes you made ]
 </reponse>

</example>

<example>

<user>what's the best way to refactor [x]</user>

<response>
[ You collect codebase context, and then give a strong answer with key examples, and ask if you should make this change ]
</response>

</example>

${PLACEHOLDER.FILE_TREE_PROMPT_SMALL}
${PLACEHOLDER.KNOWLEDGE_FILES_CONTENTS}
${PLACEHOLDER.SYSTEM_INFO_PROMPT}

# Initial Git Changes

The following is the state of the git repository at the start of the conversation. Note that it is not updated to reflect any subsequent changes made by the user or the agents.

${PLACEHOLDER.GIT_CHANGES_PROMPT}
`,

    instructionsPrompt: planOnly
      ? buildPlanOnlyInstructionsPrompt({})
      : buildImplementationInstructionsPrompt({
          isFast,
          isDefault,
          isMax,
          isLean,
          hasGeminiThinker,
          hasNoValidation,
          noAskUser,
          noReview,
          leanCodeReviewerAgentId,
        }),
    // handleSteps is serialized via .toString() and re-eval'd, so closure
    // variables like `isFreebuff` are not in scope at runtime. Pick the right
    // literal-baked function here instead.
    handleSteps: getBase2HandleSteps({
      isFreebuff,
      maxContextLength: contextPrunerMaxContextLength,
    }),
  }
}

type Base2HandleSteps = NonNullable<SecretAgentDefinition['handleSteps']>

/**
 * Every base2 route refuses providers that may keep the data, and Claude
 * additionally comes from Bedrock. This covers the orchestrator's own calls
 * only — each subagent carries its own providerOptions, and most assert
 * nothing, so the promise is not yet enforced end to end.
 *
 * The privacy policy commits that prompt and project data is not used to train
 * our or a third-party provider's models unless the model is explicitly
 * labelled for it — a promise made to every user, not just the free tier. So
 * data_collection: 'deny' belongs on all of them; leaving it off paid modes
 * gave paying users weaker enforcement than free ones.
 *
 * This used to skip the deny for paid modes on the belief that it would filter
 * out every endpoint serving lite's model. That was never checked and is false:
 * with data_collection: 'deny', OpenRouter still serves gpt-5.6-luna (OpenAI),
 * gemini-3.1-pro (Google), minimax-m3 (Minimax) and claude-opus-5 (Bedrock).
 */
function getBase2ProviderOptions(
  model: SecretAgentDefinition['model'],
): SecretAgentDefinition['providerOptions'] {
  return model.startsWith('anthropic/')
    ? { only: ['amazon-bedrock'], data_collection: 'deny' }
    : { data_collection: 'deny' }
}

function getBase2HandleSteps({
  isFreebuff,
  maxContextLength,
}: {
  isFreebuff: boolean
  maxContextLength: 250_000 | 400_000
}): Base2HandleSteps {
  if (isFreebuff) {
    if (maxContextLength === 250_000) return handleStepsFree250k
    return handleStepsFree400k
  }
  if (maxContextLength === 250_000) return handleSteps250k
  return handleSteps400k
}

const handleStepsFree250k: Base2HandleSteps = function* ({ params }) {
  while (true) {
    yield {
      toolName: 'spawn_agent_inline',
      input: {
        agent_type: 'context-pruner',
        params: {
          maxContextLength: 250_000,
          ...(params ?? {}),
          cacheExpiryMs: 30 * 60 * 1000,
        },
      },
      includeToolCall: false,
    } as any

    const { stepsComplete } = yield 'STEP'
    if (stepsComplete) break
  }
}

const handleStepsFree400k: Base2HandleSteps = function* ({ params }) {
  while (true) {
    yield {
      toolName: 'spawn_agent_inline',
      input: {
        agent_type: 'context-pruner',
        params: {
          maxContextLength: 400_000,
          ...(params ?? {}),
          cacheExpiryMs: 30 * 60 * 1000,
        },
      },
      includeToolCall: false,
    } as any

    const { stepsComplete } = yield 'STEP'
    if (stepsComplete) break
  }
}

const handleSteps250k: Base2HandleSteps = function* ({ params }) {
  while (true) {
    yield {
      toolName: 'spawn_agent_inline',
      input: {
        agent_type: 'context-pruner',
        params: {
          maxContextLength: 250_000,
          ...(params ?? {}),
          cacheExpiryMs: 30 * 60 * 1000,
        },
      },
      includeToolCall: false,
    } as any

    const { stepsComplete } = yield 'STEP'
    if (stepsComplete) break
  }
}

const handleSteps400k: Base2HandleSteps = function* ({ params }) {
  while (true) {
    yield {
      toolName: 'spawn_agent_inline',
      input: {
        agent_type: 'context-pruner',
        params: {
          maxContextLength: 400_000,
          ...(params ?? {}),
          cacheExpiryMs: 30 * 60 * 1000,
        },
      },
      includeToolCall: false,
    } as any

    const { stepsComplete } = yield 'STEP'
    if (stepsComplete) break
  }
}

const EXPLORE_PROMPT = `- Iteratively spawn file pickers, code searchers, bashers, and web/docs researchers to gather context as needed. Use the list_directory and glob tools directly for searching and exploring the codebase. The file-picker and code-searcher agents are very useful to find relevant files -- try spawning multiple in parallel (say, 2-5 file-pickers and 1-3 code-searchers) to explore different parts of the codebase. Use read_subtree if you need to grok a particular part of the codebase. Read all the relevant files using the read_files tool.`

function buildImplementationInstructionsPrompt({
  isFast,
  isDefault,
  isMax,
  isLean,
  hasGeminiThinker,
  hasNoValidation,
  noAskUser,
  noReview,
  leanCodeReviewerAgentId,
}: {
  isFast: boolean
  isDefault: boolean
  isMax: boolean
  isLean: boolean
  hasGeminiThinker: boolean
  hasNoValidation: boolean
  noAskUser: boolean
  noReview: boolean
  leanCodeReviewerAgentId: string
}) {
  return `Act as a helpful assistant and freely respond to the user's request however would be most helpful to the user. Use your judgement to orchestrate the completion of the user's request using your specialized sub-agents and tools as needed. Take your time and be comprehensive. Don't surprise the user. For example, don't modify files if the user has not asked you to do so at least implicitly.

## Example response

The user asks you to implement a new feature. You respond in multiple steps:

${buildArray(
  EXPLORE_PROMPT,
  isMax &&
    `- Important: Read as many files as could possibly be relevant to the task over several steps to improve your understanding of the user's request and produce the best possible code changes. Find more examples within the codebase similar to the user's request, dependencies that help with understanding how things work, tests, etc. This is frequently 12-20 files, depending on the task.`,
  !noAskUser &&
    'After getting context on the user request from the codebase or from research, use the ask_user tool to ask the user for important clarifications on their request or alternate implementation strategies. You should skip this step if the choice is obvious -- only ask the user if you need their help making the best choice.',
  (isDefault || isMax || isLean) &&
    `- For any task requiring 3+ steps, use the write_todos tool to write out your step-by-step implementation plan. Include ALL of the applicable tasks in the list.${isFast || noReview ? '' : ' You should include a step to review the changes after you have implemented the changes.'}:${hasNoValidation ? '' : ' You should include at least one step to validate/test your changes: be specific about whether to typecheck, run tests, run lints, etc.'} You may be able to do reviewing and validation in parallel in the same step. Skip write_todos for simple tasks like quick edits or answering questions.`,
  `- ${THINKER_SPAWN_LIMIT}`,
  hasGeminiThinker && FREEBUFF_GEMINI_THINKER_INSTRUCTIONS_PROMPT,
  (isDefault || isMax) &&
    `- For quick problems, briefly explain your reasoning to the user. If you need to think longer, write your thoughts within the <think> tags. Finally, for complex problems, spawn the thinker agent to help find the best solution. (gpt-5-agent is a last resort for complex problems)`,
  isDefault &&
    '- IMPORTANT: You must spawn the editor agent to implement the changes after you have gathered all the context you need. This agent will do the best job of implementing the changes so you must spawn it for all non-trivial changes. Do not pass any prompt or params to the editor agent when spawning it. It will make its own best choices of what to do.',
  isMax &&
    `- IMPORTANT: You must spawn the editor-multi-prompt agent to implement non-trivial code changes, since it will generate the best code changes from multiple implementation proposals. This is the best way to make high quality code changes -- strongly prefer using this agent over the str_replace or write_file tools, unless the change is very straightforward and obvious. You should also prompt it to implement the full task rather than just a single step.`,
  isFast &&
    '- Implement the changes using the str_replace or write_file tools. Implement all the changes in one go.',
  isFast &&
    '- Do a single typecheck targeted for your changes at most (if applicable for the project). Or skip this step if the change was small.',
  !hasNoValidation &&
    `- For non-trivial changes, test them by running appropriate validation commands for the project (e.g. typechecks, tests, lints, etc.). Try to run all appropriate commands in parallel. ${isMax ? ' Typecheck and test the specific area of the project that you are editing *AND* then typecheck and test the entire project if necessary.' : ' If you can, only test the area of the project that you are editing, rather than the entire project.'} You may have to explore the project to find the appropriate commands. Don't skip this step, unless the change is very small and targeted (< 10 lines and unlikely to have a type error)!`,
  (isDefault || isMax) &&
    `- Spawn a ${isDefault ? 'code-reviewer' : 'code-reviewer-multi-prompt'} to review the code changes after you have implemented changes. (Skip this step only if the change is extremely straightforward and obvious.)`,
  isLean &&
    !noReview &&
    `- Spawn a ${leanCodeReviewerAgentId} to review the changes after you have implemented code changes. (Skip this step only if the change is extremely straightforward and obvious.)`,
  !isFast &&
    !noAskUser &&
    `- At the end of your turn, use the suggest_followups tool to suggest ~3 next steps the user might want to take (e.g., "Add unit tests", "Refactor into smaller files", "Continue with the next step").`,
).join('\n')}`
}

function buildPlanOnlyInstructionsPrompt({}: {}) {
  return `Orchestrate the completion of the user's request using your specialized sub-agents.

 You are in plan mode. Do not make file changes, call write_file or str_replace, or use the write_todos tool. You should default to asking the user clarifying questions, potentially in multiple rounds as needed to fully understand the user's request, and then creating a spec/plan based on the user's request. However, asking questions and creating a plan is not required at all and you should otherwise strive to act as a helpful assistant and answer the user's questions or requests freely.
    
## Example response

The user asks you to implement a new feature. You respond in multiple steps:

${buildArray(
  EXPLORE_PROMPT,
  `- After exploring the codebase, your goal is to translate the user request into a clear and concise spec. If the user is just asking a question, you can answer it instead of writing a spec.

## Asking questions

To clarify the user's intent, or get them to weigh in on key decisions, you should use the ask_user tool.

It's good to use this tool before generating a spec, so you can make the best possible spec for the user's request.

If you don't have any important questions to ask, you can skip this step. Keep asking questions until you have a clear understanding of the user's request and how to solve it. However, be sure that you never ask questions with obvious answers or questions about details that can be changed later. Focus on the most important, non-obvious aspects only.

## Creating a spec

Wrap your spec in <PLAN> and </PLAN> tags. The content inside should be markdown formatted (no code fences around the whole plan/spec). For example: <PLAN>\n# Plan\n- Item 1\n- Item 2\n</PLAN>.

The spec should include:
- A brief title and overview. For the title is preferred to call it a "Plan" rather than a "Spec".
- A bullet point list of the requirements.
- An optional "Notes" section detailing any key considerations or constraints or testing requirements.
- A section with a list of relevant files.

It should not include:
- A lot of analysis.
- Sections of actual code.
- A list of the benefits, performance benefits, or challenges.
- A step-by-step plan for the implementation.
- A summary of the spec.

This is more like an extremely short PRD which describes the end result of what the user wants. Think of it like fleshing out the user's prompt to make it more precise, although it should be as short as possible.
`,
).join('\n')}`
}

const definition = { ...createBase2('default'), id: 'base2' }
export default definition
