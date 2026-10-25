import { isFreebuffLimitedOfferModelId } from '@codebuff/common/constants/freebuff-models'
import {
  FREEBUFF_CLI_BASE3_AGENT_ID_BY_MODEL,
  hasFreebuffRootSystemPromptOpening,
} from '@codebuff/common/constants/free-agents'
import {
  compactionPolicyForModel,
  LEAN_COMPACTION_POLICY,
} from '@codebuff/common/constants/compaction-policy'
import {
  TURN_ENDING_NOTE,
  TURN_ENDING_RULE,
} from '@codebuff/common/constants/turn-ending-rule'
import {
  FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID,
  FREEBUFF_SOLAR_MINI_4_MODEL_ID,
  FREEBUFF_SOLAR_PRO_4_MODEL_ID,
  SUPPORTED_FREEBUFF_MODELS,
} from '@codebuff/common/constants/freebuff-models'
import { describe, test, expect } from 'bun:test'

import base3, { createBase3, createBase3CliRoot } from '../base3'
import base3Evals from '../base3-evals'
import base3FastFreeDeepseekFlash from '../base3-fast-free-deepseek-flash'
import base3FreeDeepseek from '../base3-free-deepseek'
import base3FreeDeepseekFlash from '../base3-free-deepseek-flash'
import base3FreeDeepseekFlashEvals from '../base3-free-deepseek-flash-evals'
import base3FreeGlm from '../base3-free-glm'
import base3FreeGlmV53Flash from '../base3-free-glm-5-3-flash'
import base3FreeLuna from '../base3-free-luna'
import base3FreeLuna6 from '../base3-free-luna-6'
import base3FreeGpt61Sol from '../base3-free-gpt-6-1-sol'
import base3FreeMimo from '../base3-free-mimo'
import base3FreeMimo26Pro from '../base3-free-mimo-2-6-pro'
import base3FreeMinimaxM3 from '../base3-free-minimax-m3'
import base3FreeMuseSpark from '../base3-free-muse-spark'
import base3FreeMuseSpark13 from '../base3-free-muse-spark-1-3'
import base3FreeOxAlpha from '../base3-free-ox-alpha'
import base3FreeGemini38Flash from '../base3-free-gemini-3-8-flash'
import base3FreeGemini4Argon from '../base3-free-gemini-4-argon'
import base3FreeSolarPro4 from '../base3-free-solar-pro4'
import base3FreeSolarMini4 from '../base3-free-solar-mini4'
import base3FreeSpaceBunnyAlpha from '../base3-free-space-bunny-alpha'
import base3Lite from '../base3-lite'

/**
 * The CLI's base3 roots.
 *
 * `CLI_HARNESS` routes DEFAULT, LITE, and Freebuff turns here. These definitions
 * ship compiled into the CLI binary, so a regression requires a new release to
 * repair rather than a server-side kill switch (see
 * docs/freebuff-base3-harness.md).
 *
 * What makes base3 cheaper rides on the DEFINITION, not the call site — the
 * runtime reads `windowedFileReads` and `compactContext` straight off the agent
 * template. A root that loses one keeps working and quietly costs base2 money
 * again. The Web bundle has the same assertions for its own roots
 * (freebuff_bundled_agents.test.ts); these are the CLI's, which ship compiled
 * into the binary instead.
 */
const CLI_ROOTS = [
  base3,
  base3Lite,
  base3Evals,
  // The benchmark's own arm. If it lost a lever, the next run would compare
  // base3-minus-that-lever against base2 and report it as base3's score.
  base3FreeDeepseekFlashEvals,
  base3FreeDeepseek,
  base3FreeDeepseekFlash,
  base3FreeMinimaxM3,
  base3FreeMimo,
  base3FreeMimo26Pro,
  base3FreeGlm,
  base3FreeGlmV53Flash,
  base3FreeLuna,
  base3FreeLuna6,
  base3FreeGpt61Sol,
  base3FreeOxAlpha,
  base3FreeSolarPro4,
  base3FreeSolarMini4,
  base3FreeSpaceBunnyAlpha,
  base3FreeGemini38Flash,
  base3FreeGemini4Argon,
  base3FreeMuseSpark,
  base3FreeMuseSpark13,
]

/**
 * Every root the CLI map names, including the one that is NOT a single loop:
 * the base3-FAST root (agents/base3-fast.ts) fans out to parallel workers by
 * design and is pinned by agents/__tests__/base3-fast.test.ts. It joins the
 * registration checks below and stays out of the no-subagents loop.
 */
const ALL_CLI_ROOTS = [...CLI_ROOTS, base3FastFreeDeepseekFlash]

describe('base3 CLI roots', () => {
  test('keeps the efficiency flags the runtime reads', () => {
    // Fable 5.1 deliberately runs base2 for the trace campaign. The
    // count is asserted so a root added without the flags below cannot slip in
    // unnoticed.
    expect(CLI_ROOTS.length).toBe(22)
    for (const agent of CLI_ROOTS) {
      // Windowed reads + the 100-entry glob cap + search-first tool wording.
      expect(agent.windowedFileReads).toBe(true)
      // Mechanical compaction in-process, instead of spawning context-pruner —
      // with the idle trigger sized per model: an hour for most, so a coffee
      // break never rewrites the history, and 15 minutes for DeepSeek Flash,
      // whose Luminal lane forgets the prefix by then anyway (see base3.ts).
      expect(agent.compactContext).toEqual(
        compactionPolicyForModel(agent.model),
      )
      // Single loop: no subagents at all, which is what the harness IS.
      expect(agent.spawnableAgents ?? []).toEqual([])
      expect(agent.toolNames ?? []).not.toContain('spawn_agents')
      // No per-turn instructions but the turn-ending note, and only for the
      // models that end turns on a status line. Written as a literal set, so a
      // refactor of base3's own list cannot move both sides at once.
      expect(agent.instructionsPrompt).toBe(
        [
          FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID,
          FREEBUFF_SOLAR_PRO_4_MODEL_ID,
          FREEBUFF_SOLAR_MINI_4_MODEL_ID,
        ].includes(agent.model as string)
          ? TURN_ENDING_NOTE
          : undefined,
      )
    }
  })

  // Solar Pro 4 and Solar Mini 4 ended 24.0% and 18.8% of their completed
  // Desktop turns in prose with no tool call over the 24h to 2026-10-14,
  // against DeepSeek V4 Flash's 1.7% — and 41.7% vs 17.1% zero-tool among the
  // 402 users who used both. Named here as well as in the loop above: a root
  // that disappears from CLI_ROOTS must fail, not pass silently.
  test('the Solar roots and Muse Spark 1.3 carry the turn-ending note', () => {
    for (const agent of [
      base3FreeSolarPro4,
      base3FreeSolarMini4,
      base3FreeMuseSpark13,
    ]) {
      expect(agent.instructionsPrompt).toBe(TURN_ENDING_NOTE)
    }
    // And the comparison that made it measurable stays off it.
    expect(base3FreeDeepseekFlash.instructionsPrompt).toBeUndefined()
  })

  test('DeepSeek Flash roots get 15 minutes / 40k, the rest the hour / 140k', () => {
    // Literal values, so a refactor of the policy table cannot move both
    // sides of the loop above at once (common/src/constants/compaction-policy.ts).
    expect(base3FreeDeepseekFlash.compactContext).toEqual({
      cacheExpiryMs: 15 * 60 * 1000,
      cacheExpiryMinTokens: 40_000,
    })
    expect(base3FreeDeepseek.compactContext).toEqual({
      cacheExpiryMs: 60 * 60 * 1000,
      cacheExpiryMinTokens: 140_000,
    })
  })

  test('declares no reasoning, leaving the catalog the single authority', () => {
    // An agent-declared reasoning reaches the wire as `body.reasoning`, which
    // makes the agent the authority on effort and leaves
    // applyFreebuffReasoningDefaults unable to tell a model default apart from
    // a user's pick — so the effort control silently does nothing on exactly
    // the models people most want to tune. The Web roots make this structural
    // by having no such parameter; the CLI roots spread object literals, so
    // this test is what stops the next one reintroducing it.
    for (const agent of CLI_ROOTS) {
      expect(agent.reasoningOptions).toBeUndefined()
    }
  })

  test('opens with a prompt the free-mode gate accepts', () => {
    // The appendix is appended, never prepended: the canonical opening must
    // stay first.
    for (const agent of CLI_ROOTS) {
      expect(hasFreebuffRootSystemPromptOpening(agent.systemPrompt!)).toBe(true)
      expect(
        agent.systemPrompt!.match(/\{CODEBUFF_GIT_CHANGES_PROMPT\}/g),
      ).toHaveLength(1)
    }
  })

  test('every Freebuff root is pinned to the model its id is registered under', () => {
    const byId = new Map(ALL_CLI_ROOTS.map((a) => [a.id, a]))
    for (const [model, agentId] of Object.entries(
      FREEBUFF_CLI_BASE3_AGENT_ID_BY_MODEL,
    )) {
      // A root whose model disagrees with the allowlist cannot run.
      expect(byId.get(agentId)?.model).toBe(model)
    }
  })

  test('ships a root for every model the picker offers', () => {
    for (const model of SUPPORTED_FREEBUFF_MODELS) {
      if (isFreebuffLimitedOfferModelId(model.id)) continue
      const agentId = FREEBUFF_CLI_BASE3_AGENT_ID_BY_MODEL[model.id]
      expect(agentId).toBeDefined()
      expect(ALL_CLI_ROOTS.some((a) => a.id === agentId)).toBe(true)
    }
  })

  test('leaves the bare harness alone, so Desktop does not inherit CLI tools', () => {
    // freebuff-desktop builds THREAD_AGENT_TOOLS by unioning
    // createBase3().toolNames with its own extras, so anything added to the
    // base factory lands on every Desktop thread silently.
    expect(createBase3().toolNames).toEqual([
      'read_files',
      'str_replace',
      'write_file',
      'run_terminal_command',
      'code_search',
      'glob',
      'list_directory',
      'write_todos',
    ])
  })

  test('noWeb drops web_search and read_url and nothing else', () => {
    // The eval harness withholds the web from BOTH arms: the evaluated
    // repositories are public, and a search result quoting their current
    // code is the answer key (2026-10-04: 36% of base3's search results in
    // the bench cited the repository under evaluation).
    const withWeb = createBase3CliRoot({ noAskUser: true })
    const withoutWeb = createBase3CliRoot({ noAskUser: true, noWeb: true })
    expect(withWeb.toolNames).toContain('web_search')
    expect(withWeb.toolNames).toContain('read_url')
    expect(withoutWeb.toolNames).toEqual(
      withWeb.toolNames!.filter(
        (name) => name !== 'web_search' && name !== 'read_url',
      ),
    )
    expect(withoutWeb.systemPrompt).toBe(withWeb.systemPrompt)
  })

  test('noAskUser drops the human tools from the prompt as well as the toolset', () => {
    // The two have to move together. A prompt telling the model to call
    // ask_user when the tool is absent is a wasted step every eval run.
    const withUser = createBase3CliRoot()
    const withoutUser = createBase3CliRoot({ noAskUser: true })

    expect(withUser.toolNames).toContain('ask_user')
    expect(withUser.toolNames).toContain('suggest_followups')
    // The prompt deliberately says nothing about ask_user; the tool's own
    // description says when to use it.
    expect(withUser.systemPrompt).toContain('suggest_followups')

    expect(withoutUser.toolNames).not.toContain('ask_user')
    expect(withoutUser.toolNames).not.toContain('suggest_followups')
    expect(withoutUser.systemPrompt).not.toContain('ask_user')
    expect(withoutUser.systemPrompt).not.toContain('suggest_followups')

    // Otherwise identical: the eval variant must stay a like-for-like
    // comparison against base2-evals, not a differently-equipped agent.
    expect(withoutUser.toolNames).toEqual(
      withUser.toolNames!.filter(
        (name) => name !== 'ask_user' && name !== 'suggest_followups',
      ),
    )
  })

  // Freebuff users reported models refusing work because they were "running
  // out of time" after deadline wording reached every root's system prompt.
  // Only a host that supplies `deadlineAt` may talk about time.
  test('never tells the model it is short on time', () => {
    const prompts = [
      ...ALL_CLI_ROOTS.map((root) => root.systemPrompt!),
      createBase3().systemPrompt!,
      createBase3(undefined, { supportsBackgroundCommands: false })
        .systemPrompt!,
    ]
    for (const prompt of prompts) {
      expect(prompt).not.toMatch(
        /deadline|time runs low|reserve time|minimal working result|remaining budget/i,
      )
    }
  })

  // docs/freebuff-muse-spark.md: Muse Spark ended turns on "let me check…".
  test('states that a message without a tool call ends the turn', () => {
    for (const prompt of [
      createBase3().systemPrompt!,
      ...ALL_CLI_ROOTS.map((root) => root.systemPrompt!),
    ]) {
      expect(prompt).toContain(TURN_ENDING_RULE)
    }
  })

  // Flash on this prompt read every verification and planning rule as a
  // standing order and built far past small asks, and built a large version of
  // open-ended asks instead of settling scope (docs/freebuff-base3-harness.md,
  // "Scope discipline"). The completeness half stays: base3 once lost to base2
  // on Flash for leaving requested work undone.
  test('sizes the work to the request, without dropping completeness', () => {
    for (const prompt of [
      createBase3().systemPrompt!,
      ...ALL_CLI_ROOTS.map((root) => root.systemPrompt!),
    ]) {
      expect(prompt).toContain('Size the work to the request')
      expect(prompt).toContain('Do everything the user asked for, completely')
      expect(prompt).toContain('settle the scope yourself')
      expect(prompt).toContain('Keep verification minimal')
      expect(prompt).toContain('Work through related tool calls as a group')
      expect(prompt).toContain('Avoid tool-by-tool narration, filler, and repeating an unchanged plan')
      expect(prompt).toContain('If about a minute has passed without a visible update')
      expect(prompt).toContain('Use normal assistant text, not thinking/reasoning')
      expect(prompt).toContain('Do not test every UI element')
      // Unasked screenshots cost minutes a turn: a local loop of 19 captures
      // on a "make it full screen" ask, and Cloud turns rebuilding Chromium.
      expect(prompt).toContain(
        'Take screenshots or drive a browser for visual inspection only when the user explicitly asks',
      )
      expect(prompt).not.toContain('through the interface the user will use')
    }
  })

  test('brands Freebuff roots as Freebuff, and Codebuff roots as Codebuff', () => {
    expect(base3FreeDeepseek.systemPrompt).toContain('Freebuff')
    expect(base3FreeDeepseek.systemPrompt).not.toContain('/usage')
    // Codebuff's paid modes explain credits; Freebuff has none to explain.
    expect(base3.systemPrompt).toContain('/usage')
  })
})

describe('a lean compaction policy', () => {
  const { lean: _, ...runtimePolicy } = LEAN_COMPACTION_POLICY
  const lean = createBase3('anthropic/claude-haiku-5.5', {
    compaction: LEAN_COMPACTION_POLICY,
  })
  const plain = createBase3('anthropic/claude-haiku-5.5', {
    compaction: runtimePolicy,
  })

  test('adds the context-budget section, naming where compaction fires', () => {
    expect(lean.systemPrompt).toContain('# Context budget')
    expect(lean.systemPrompt).toContain('past ~88k tokens')
    expect(plain.systemPrompt).not.toContain('# Context budget')
  })

  test('keeps `lean` out of compactContext, whose schema is strict', () => {
    expect(lean.compactContext).toEqual(runtimePolicy)
  })
})
