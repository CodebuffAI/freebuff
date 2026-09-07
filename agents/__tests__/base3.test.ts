import {
  FREEBUFF_CLI_BASE3_AGENT_ID_BY_MODEL,
  hasFreebuffRootSystemPromptOpening,
} from '@codebuff/common/constants/free-agents'
import { compactionPolicyForModel } from '@codebuff/common/constants/compaction-policy'
import { SUPPORTED_FREEBUFF_MODELS } from '@codebuff/common/constants/freebuff-models'
import { describe, test, expect } from 'bun:test'

import base3, { createBase3, createBase3CliRoot } from '../base3'
import base3Evals from '../base3-evals'
import base3FreeDeepseek from '../base3-free-deepseek'
import base3FreeDeepseekFlash from '../base3-free-deepseek-flash'
import base3FreeDeepseekFlashEvals from '../base3-free-deepseek-flash-evals'
import base3FreeFable from '../base3-free-fable'
import base3FreeGlm from '../base3-free-glm'
import base3FreeGlmV53Flash from '../base3-free-glm-5-3-flash'
import base3FreeLuna from '../base3-free-luna'
import base3FreeMimo from '../base3-free-mimo'
import base3FreeMinimaxM3 from '../base3-free-minimax-m3'
import base3FreeMuseSpark from '../base3-free-muse-spark'
import base3FreeMuseSpark13 from '../base3-free-muse-spark-1-3'
import base3FreeOxAlpha from '../base3-free-ox-alpha'
import base3FreeGemini38Flash from '../base3-free-gemini-3-8-flash'
import base3FreeSolarPro4 from '../base3-free-solar-pro4'
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
  base3FreeGlm,
  base3FreeGlmV53Flash,
  base3FreeLuna,
  base3FreeFable,
  base3FreeOxAlpha,
  base3FreeSolarPro4,
  base3FreeGemini38Flash,
  base3FreeMuseSpark,
  base3FreeMuseSpark13,
]

describe('base3 CLI roots', () => {
  test('keeps the efficiency flags the runtime reads', () => {
    // 17 since Muse Spark 1.2 was restored beside the withdrawn 1.3 root (the
    // paused id stays a recognised pick for binaries already shipped). The
    // count is asserted so a root added without the flags below cannot slip in
    // unnoticed.
    expect(CLI_ROOTS.length).toBe(17)
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
      // No per-turn instructions prompt: re-injecting one after every user
      // message breaks the prompt cache the harness is built to keep warm.
      expect(agent.instructionsPrompt).toBeUndefined()
    }
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
    // The appendix is appended, never prepended: the chat-completions gate
    // requires a canonical opening at byte 0, so prepending 403s every turn.
    for (const agent of CLI_ROOTS) {
      expect(hasFreebuffRootSystemPromptOpening(agent.systemPrompt!)).toBe(true)
      expect(
        agent.systemPrompt!.match(/\{CODEBUFF_GIT_CHANGES_PROMPT\}/g),
      ).toHaveLength(1)
    }
  })

  test('every Freebuff root is pinned to the model its id is registered under', () => {
    const byId = new Map(CLI_ROOTS.map((a) => [a.id, a]))
    for (const [model, agentId] of Object.entries(
      FREEBUFF_CLI_BASE3_AGENT_ID_BY_MODEL,
    )) {
      // A root whose model disagrees with the allowlist 403s with
      // free_mode_invalid_agent_model on every request.
      expect(byId.get(agentId)?.model).toBe(model)
    }
  })

  test('ships a root for every model the picker offers', () => {
    for (const model of SUPPORTED_FREEBUFF_MODELS) {
      const agentId = FREEBUFF_CLI_BASE3_AGENT_ID_BY_MODEL[model.id]
      expect(agentId).toBeDefined()
      expect(CLI_ROOTS.some((a) => a.id === agentId)).toBe(true)
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

  test('noAskUser drops the human tools from the prompt as well as the toolset', () => {
    // The two have to move together. A prompt telling the model to call
    // ask_user when the tool is absent is a wasted step every eval run.
    const withUser = createBase3CliRoot()
    const withoutUser = createBase3CliRoot({ noAskUser: true })

    expect(withUser.toolNames).toContain('ask_user')
    expect(withUser.toolNames).toContain('suggest_followups')
    expect(withUser.systemPrompt).toContain('ask_user')

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

  test('brands Freebuff roots as Freebuff, and Codebuff roots as Codebuff', () => {
    expect(base3FreeDeepseek.systemPrompt).toContain('Freebuff')
    expect(base3FreeDeepseek.systemPrompt).not.toContain('/usage')
    // Codebuff's paid modes explain credits; Freebuff has none to explain.
    expect(base3.systemPrompt).toContain('/usage')
  })
})
