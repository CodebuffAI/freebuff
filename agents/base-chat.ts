import { FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID } from '@codebuff/common/constants/freebuff-models'

import { publisher } from './constants'

import type { SecretAgentDefinition } from './types/secret-agent-definition'

/**
 * Conversational agent behind freebuff.com/chat. Runs with no filesystem, but
 * can spawn researcher-web to look things up on the live internet and call
 * gravity_index to recommend third-party developer services. The chat server
 * overrides `model` with the user's resolved chat selection on every request.
 */
const definition: SecretAgentDefinition = {
  id: 'base-chat',
  publisher,
  model: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  displayName: 'Freebuff Chat',
  spawnerPrompt: 'General-purpose chat assistant for freebuff.com/chat.',
  inputSchema: {
    prompt: {
      type: 'string',
      description: 'The user message to respond to.',
    },
  },
  outputMode: 'last_message',
  toolNames: [
    'spawn_agents',
    'gravity_index',
    'render_ui',
    'suggest_followups',
  ],
  spawnableAgents: ['researcher-web', 'thinker-gemini', 'context-pruner'],

  systemPrompt: `You are Freebuff Chat, a friendly, sharp assistant made by Freebuff (freebuff.com), the home of free AI coding tools. You are chatting with a user in a web interface that renders markdown.`,
  instructionsPrompt: `Be direct and helpful. Use markdown when it improves clarity (code blocks, lists, tables), and keep answers as short as they can be while fully answering the question.

When the user is choosing a third-party developer service (database, auth, payments, hosting, email, monitoring, analytics, AI APIs, storage, CMS, search, etc.) or asks what provider to use for something, use the gravity_index tool instead of answering from memory: \`search\` with a query that includes their stack and constraints when they want a recommendation, or \`browse\`/\`list_categories\`/\`get_service\` to explore options. Ground your answer in the result. A Gravity search can return several options and you may search more than once. Decide which single service you are actually recommending, then call render_ui exactly once with a gravity_index link reference containing the exact \`search_id\` and selected \`service_slug\`; never transcribe the opaque URL. The runtime verifies the selection and substitutes the exact tracked click URL. Since you can't edit the user's files, share the relevant setup steps and env vars in chat instead of trying to install anything.

You can search the live internet by spawning the researcher-web agent. Spawn it whenever the answer depends on current or recent information (news, prices, releases, versions, schedules, scores, docs), whenever the user asks you to look something up, or whenever you are not confident in your knowledge. Give it a focused question; you can spawn several in parallel for independent questions. After it reports back, answer the user in your own words and cite source URLs when useful. Don't spawn it for questions you can already answer well (general knowledge, coding help, writing, math).

Whenever a question needs real reasoning, spawn the thinker-gemini agent and let it do the thinking — do not reason it out yourself in your reply. This is your default for anything beyond a quick lookup: math or logic problems, puzzles, debugging, code design, architecture and trade-off decisions, planning, comparisons, "why/how" explanations, estimates, or any multi-step question. When in doubt, spawn the thinker. First gather any context you need (spawn researcher-web for current info, call gravity_index for service questions), then spawn the thinker. It sees the full conversation, including everything your tools returned, so give it a short, focused prompt naming the problem — don't repeat the gathered context. It is fine (often good) to spawn the thinker even when you think you know the answer; let it verify the reasoning. Wait for its conclusion, then write the final answer to the user in your own words. Skip the thinker only for trivial, purely factual, or conversational messages (greetings, simple definitions, quick lookups) where there is nothing to reason about.

You do not have access to the user's files or a filesystem — if asked to do something that requires those, say so briefly and help with what you can instead.

Never spawn the context-pruner agent: it is spawned automatically for you before each step.

End every response by calling the suggest_followups tool with exactly 3 followups the user is likely to want next — natural next questions, deeper dives, or related directions that build on what you just said. Make them specific to this conversation, not generic. For each followup give a short \`label\` (2–5 words, the card title) and a \`prompt\` (the message sent verbatim when the user clicks it, phrased in the user's first-person voice, e.g. "Show me how to…"). Keep the prompt short and goal-oriented — usually one sentence naming what the user wants to know, not a spec for how you should answer it. Call it last, after your written answer (and after any tool/subagent calls). Skip it only when there is no sensible next step (e.g. the user said goodbye).`,

  handleSteps: function* ({ model, contextPruning }) {
    // Constants live inside handleSteps because it is serialized with
    // toString() and re-evaluated standalone — nothing outside this body,
    // imports included, is in scope. CONTEXT_WINDOWS mirrors
    // FREEBUFF_MODEL_CONTEXT_WINDOWS (common/src/constants/freebuff-models.ts);
    // agents/__tests__/base-chat.test.ts fails if the two drift.

    /** Hard context window (tokens) per backend model id. */
    const CONTEXT_WINDOWS: Record<string, number> = {
      'minimax/minimax-m3': 524_288,
      'deepseek/deepseek-v4-flash': 1_048_576,
      'deepseek/deepseek-v4-pro': 1_048_576,
      // 1_050_000 per OpenRouter's endpoints API; entered low, so the 0.4
      // budget below lands on exactly 400k. Without this Luna took
      // DEFAULT_CONTEXT_WINDOW and got a 52k budget on a million-token model.
      'openai/gpt-5.6-luna': 1_000_000,
      'openai/gpt-5.6-luna-es': 372_000,
      'meta/muse-spark-1.2-contributor': 1_000_000,
      'google/gemini-3.8-flash': 1_000_000,
      'meta/muse-spark-1.3-contributor': 1_000_000,
      // Ox Alpha: 1,048,576 published, entered low for the same reason.
      'stealth/ox-alpha': 1_000_000,
      // GLM 5.3 Flash: 1,310,720 published, entered low for the same reason.
      'z-ai/glm-5.3-flash': 1_000_000,
      // Solar Pro 4: 524,288 published, entered low for the same reason.
      'upstage/solar-pro4': 500_000,
    }

    /** For any model not listed above. Assuming a window is smaller than it is
     *  only prunes early; assuming it is larger wedges the thread forever, so
     *  unmeasured models get a deliberately small one. */
    const DEFAULT_CONTEXT_WINDOW = 131_072

    /** Share of the window the conversation may occupy before we summarize.
     *
     *  This is deliberately low because contextTokenCount is NOT the provider's
     *  count — it is a local estimate (GPT-4o tokenizer times a fixed fudge
     *  factor) applied to models with their own tokenizers, and it can run well
     *  under the real number. Measured against the threads that actually wedged
     *  in prod: MiniMax charged 1.68–3.35 chars/token (median 2.60), while the
     *  local estimator yields 1.95 (JSON) to 3.33 (English prose) on comparable
     *  content. Worst case the estimate is ~half the provider's count, so a
     *  budget above 0.5 would only trip after the request was already
     *  rejectable — the exact failure this pruning exists to prevent. 0.4
     *  leaves headroom for that skew plus the response, and still admits a very
     *  long conversation (~200k estimated tokens on a 512k model). */
    const CONTEXT_BUDGET_FRACTION = 0.4

    /** The pruner also prunes on a prompt-cache miss, defaulting to a 5-minute
     *  gap. Chat tabs idle for hours, so that would re-summarize a short
     *  conversation after any coffee break — context loss for a product whose
     *  job is remembering. Set high to leave the context limit as the only
     *  trigger. */
    const CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000

    /** DeepSeek Flash is the exception: its Luminal lane forgets the prefix
     *  in ~15 minutes, so past that the compaction only shrinks a cold prefill
     *  that was coming anyway. Gap and floor arrive via the runtime's
     *  `contextPruning` (see common/src/constants/compaction-policy.ts). */
    const compaction =
      model === 'deepseek/deepseek-v4-flash' && contextPruning
        ? {
            cacheExpiryMs: contextPruning.cacheExpiryMs,
            cacheExpiryMinTokens: contextPruning.cacheExpiryMinTokens,
          }
        : { cacheExpiryMs: CACHE_EXPIRY_MS }

    // `model` is absent only when the generator is driven directly (tests) or
    // by a runtime predating AgentStepContext.model.
    const contextWindow =
      (model && CONTEXT_WINDOWS[model]) ?? DEFAULT_CONTEXT_WINDOW
    const maxContextLength = Math.floor(contextWindow * CONTEXT_BUDGET_FRACTION)

    while (true) {
      // Prune before every step, budgeted to the model this step will actually
      // use. That ordering is what makes a mid-thread model switch survivable:
      // a thread grown on a 512k model gets summarized down on the first step
      // after switching to a 256k one, instead of being rejected forever.
      yield {
        toolName: 'spawn_agent_inline',
        input: {
          agent_type: 'context-pruner',
          params: { maxContextLength, ...compaction },
        },
        includeToolCall: false,
      } as any

      const { stepsComplete } = yield 'STEP'
      if (stepsComplete) break
    }
  },
}

export default definition
