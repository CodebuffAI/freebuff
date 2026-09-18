import { describe, expect, test } from 'bun:test'

import {
  FREEBUFF_FABLE_5_1_MODEL_ID,
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
  FREEBUFF_MINIMAX_M3_MODEL_ID,
  FREEBUFF_MIMO_V25_MODEL_ID,
} from '@codebuff/common/constants/freebuff-models'
import {
  compactionPolicyForModel,
  DEEPSEEK_FLASH_COMPACTION_POLICY,
  DEFAULT_COMPACTION_POLICY,
} from '@codebuff/common/constants/compaction-policy'
import { contextPrunerBudgetForModel } from '@codebuff/common/constants/model-config'

import { createBase2 } from '../base2/base2'
import { createBaseDeep } from '../base2/base-deep'
import codeReviewerLite from '../reviewer/code-reviewer-lite'

const FREEBUFF_KIMI_MODEL_ID = 'moonshotai/kimi-k2.7-code'
// Removed from Freebuff 2026-08-04, so it is now just an unmapped model here.
const FREEBUFF_MIMO_V25_PRO_MODEL_ID = 'mimo/mimo-v2.5-pro'

describe('base2 reviewer selection', () => {
  test('Codebuff lite uses GPT-5.6 Luna and the lite reviewer', () => {
    const base2 = createBase2('lite')

    expect(base2.model).toBe('openai/gpt-5.6-luna')
    expect(base2.spawnableAgents).toContain('code-reviewer-lite')
    expect(base2.instructionsPrompt).toContain('Spawn a code-reviewer-lite')
  })

  test('free mode still uses MiniMax M3 and its matching reviewer', () => {
    const base2 = createBase2('free')

    expect(base2.model).toBe(FREEBUFF_MINIMAX_M3_MODEL_ID)
    expect(base2.spawnableAgents).toContain('code-reviewer-minimax-m3')
    expect(base2.instructionsPrompt).toContain(
      'Spawn a code-reviewer-minimax-m3',
    )
  })

  test('the lite reviewer runs the same model as lite mode', () => {
    expect(codeReviewerLite.model).toBe('openai/gpt-5.6-luna')
  })

  test('a free model without a matching reviewer falls back to DeepSeek Flash', () => {
    // Never code-reviewer-lite: that one runs Codebuff's paid lite model now,
    // which free mode is not allowed to spend on.
    const base2 = createBase2('free', { model: 'some/unmapped-free-model' })

    expect(base2.spawnableAgents).toContain('code-reviewer-deepseek-flash')
    expect(base2.spawnableAgents).not.toContain('code-reviewer-lite')
    expect(base2.instructionsPrompt).toContain(
      'Spawn a code-reviewer-deepseek-flash',
    )
  })

  test('free mode cannot reach the paid reviewer even on lite’s own model', () => {
    // Reviewer lookup is per product. Sharing one model-keyed table between
    // them let a freebuff agent pointed at lite's model resolve to the paid
    // code-reviewer-lite, which a free session is not allowed to spend on.
    // Freebuff now offers GPT-5.6 Luna too, so free mode on this model gets its
    // own free reviewer — still never lite's.
    const base2 = createBase2('free', { model: 'openai/gpt-5.6-luna' })

    expect(base2.spawnableAgents).not.toContain('code-reviewer-lite')
    expect(base2.spawnableAgents).toContain('code-reviewer-luna')
    expect(base2.systemPrompt).not.toContain('code-reviewer-lite')
    expect(base2.instructionsPrompt).not.toContain('code-reviewer-lite')
  })

  test.each([
    [FREEBUFF_MINIMAX_M3_MODEL_ID, 'code-reviewer-minimax-m3'],
    [FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID, 'code-reviewer-deepseek'],
    [FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID, 'code-reviewer-deepseek-flash'],
    [FREEBUFF_MIMO_V25_MODEL_ID, 'code-reviewer-mimo'],
  ])('uses matching reviewer for model %p', (model, expectedReviewer) => {
    const base2 = createBase2('free', { model })

    expect(base2.spawnableAgents).toContain(expectedReviewer)
    expect(base2.instructionsPrompt).toContain(`Spawn a ${expectedReviewer}`)
  })

  test('the reviewer follows the model, not the mode', () => {
    // Overriding lite's model moves the reviewer with it, the same way the
    // context-pruner budget and provider routing follow the model.
    const base2 = createBase2('lite', { model: FREEBUFF_MIMO_V25_MODEL_ID })

    expect(base2.spawnableAgents).toContain('code-reviewer-mimo')
    expect(base2.spawnableAgents).not.toContain('code-reviewer-lite')
  })

  test('an unmapped model falls back to the cheap reviewer', () => {
    // Kimi was removed from Freebuff on 2026-07-31 along with its reviewer,
    // and MiMo 2.5 Pro on 2026-08-04, so both are now just unmapped models: no
    // reviewer of their own is resolvable in any mode, and the lean fallback
    // takes over.
    for (const mode of ['free', 'lite'] as const) {
      const base2 = createBase2(mode, { model: FREEBUFF_KIMI_MODEL_ID })
      expect(base2.spawnableAgents).not.toContain('code-reviewer-kimi')
      const mimoPro = createBase2(mode, {
        model: FREEBUFF_MIMO_V25_PRO_MODEL_ID,
      })
      expect(mimoPro.spawnableAgents).not.toContain('code-reviewer-mimo-pro')
      expect(base2.spawnableAgents).toContain('code-reviewer-deepseek-flash')
    }
  })
})

describe('base2 gemini thinker', () => {
  const GEMINI_THINKER = 'thinker-with-files-gemini'

  test('lite gets the same gemini thinker as free mode', () => {
    const lite = createBase2('lite')

    expect(lite.spawnableAgents).toContain(GEMINI_THINKER)
    expect(lite.systemPrompt).toContain(GEMINI_THINKER)
    expect(lite.instructionsPrompt).toContain(GEMINI_THINKER)
  })

  test('lite keeps it regardless of model, unlike free mode', () => {
    // The parent-model set gates free-session admission to Gemini Pro on an
    // unbilled path. Lite is billed, so the completions gate exempts it.
    expect(
      createBase2('lite', { model: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID })
        .spawnableAgents,
    ).toContain(GEMINI_THINKER)
    expect(
      createBase2('free', { model: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID })
        .spawnableAgents,
    ).not.toContain(GEMINI_THINKER)
    expect(createBase2('free').spawnableAgents).toContain(GEMINI_THINKER)
  })

  test.each(['default', 'max'] as const)('%s mode does not get it', (mode) => {
    expect(createBase2(mode).spawnableAgents).not.toContain(GEMINI_THINKER)
  })
})

describe('production agent step prompts', () => {
  test('base2 and base-deep rely on their non-repeating prompts', () => {
    const agents = [
      ...(['default', 'free', 'lite', 'max', 'fast'] as const).map((mode) =>
        createBase2(mode),
      ),
      createBase2('default', { planOnly: true }),
      createBaseDeep(),
    ]

    for (const agent of agents) {
      expect('stepPrompt' in agent).toBe(false)
    }
  })

  // A user picked plan mode and got the whole feature built and committed. The
  // instruction paragraph saying not to was there the entire time; what it was
  // losing to was the rest of the same prompt (a worked example ending in "you
  // implement the changes using the editor agent") and a toolset that still
  // held every capability a build turn has. So these assert the capability and
  // the demonstration, not the paragraph.
  describe('plan-only', () => {
    const plan = createBase2('default', { planOnly: true })

    test('holds no tool that writes a file', () => {
      for (const tool of [
        'str_replace',
        'write_file',
        'propose_str_replace',
        'propose_write_file',
      ]) {
        expect(plan.toolNames).not.toContain(tool)
      }
    })

    test('cannot spawn an agent that edits or runs commands', () => {
      // basher is the shell: `git commit` reached the repository through it
      for (const agent of [
        'editor',
        'editor-multi-prompt',
        'basher',
        'tmux-cli',
      ]) {
        expect(plan.spawnableAgents).not.toContain(agent)
      }
    })

    test('still holds everything it needs to explore', () => {
      for (const tool of [
        'read_files',
        'read_subtree',
        'list_directory',
        'glob',
      ] as const) {
        expect(plan.toolNames).toContain(tool)
      }
      for (const agent of ['file-picker', 'code-searcher', 'researcher-web']) {
        expect(plan.spawnableAgents).toContain(agent)
      }
    })

    test('never demonstrates building in its worked example', () => {
      const systemPrompt = plan.systemPrompt!

      for (const phrase of [
        'You implement the changes',
        'Spawn the editor agent to implement',
        'Spawn bashers sequentially',
        'All tests & typechecks pass',
      ]) {
        expect(systemPrompt).not.toContain(phrase)
      }
      expect(systemPrompt).toContain('You do NOT implement anything')
    })

    test("refuses to read the user's wording as permission to build", () => {
      const instructions = plan.instructionsPrompt!

      expect(instructions).toContain('is not permission to leave plan mode')
      // the old prompt ended with "answer the user's questions or requests
      // freely", which reads as exactly that permission
      expect(instructions).not.toContain('requests freely')
    })

    test('leaves the build modes alone', () => {
      const build = createBase2('default')

      expect(build.toolNames).toContain('write_file')
      expect(build.spawnableAgents).toContain('editor')
      expect(build.spawnableAgents).toContain('basher')
    })
  })
})

describe('base2 escalation guidance', () => {
  test('lite names one escalation path and prices it honestly', () => {
    // Per million tokens: lite ~$0.25/$1.50, gemini-3.1-pro $1.00/$6.00,
    // gpt-5.4 $1.25/$7.50. The two thinkers sit in the same band, so lite
    // cannot claim one is cheap and the other extravagant.
    const systemPrompt = createBase2('lite').systemPrompt!

    expect(systemPrompt).toContain(
      "thinker-with-files-gemini agent is lite mode's one escalation path",
    )
    expect(systemPrompt).toContain(
      'several times more expensive per token than lite itself',
    )
    expect(systemPrompt).toContain(
      'Do not spawn thinker-gpt unless the user asks for it',
    )
    expect(systemPrompt).toContain('costs about the same per token')
    expect(systemPrompt).toContain('DEFAULT or MAX mode')
    // The rationale must be Codebuff's cost story, not Freebuff's.
    expect(systemPrompt).not.toContain('ChatGPT subscription')
  })

  test('lite never argues against its own escalation path', () => {
    // The incoherence this replaces: lite was told thinker-gpt was too
    // expensive while being encouraged toward a thinker costing about as much.
    const systemPrompt = createBase2('lite').systemPrompt!

    expect(systemPrompt).toContain('Spawn the thinker-with-files-gemini agent')
    expect(systemPrompt).not.toMatch(/Do not spawn[^.]*thinker-with-files/)
  })

  test('both thinkers stay spawnable so an explicit request still works', () => {
    const lite = createBase2('lite')

    expect(lite.spawnableAgents).toContain('thinker-gpt')
    expect(lite.spawnableAgents).toContain('thinker-with-files-gemini')
  })

  test.each([
    ['default free root', undefined],
    ['Fable', FREEBUFF_FABLE_5_1_MODEL_ID],
    ['DeepSeek Flash', FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID],
  ] as const)('%s has no thinker-gpt to restrict', (_label, model) => {
    // Freebuff reached thinker-gpt only through /connect-chatgpt, on the user's
    // own subscription. With that integration gone the agent 403s for every
    // free session, so it is off the list — and the prompt must not name it
    // either, which would just invite a spawn that cannot succeed.
    const free = createBase2('free', model ? { model } : undefined)
    const prompts = [
      free.systemPrompt,
      free.instructionsPrompt,
      free.stepPrompt,
    ].join('\n')

    expect(free.spawnableAgents).not.toContain('thinker-gpt')
    expect(prompts).not.toContain('thinker-gpt')
    expect(prompts).not.toContain('ChatGPT')
  })

  test.each(['default', 'max'] as const)(
    '%s mode is left unrestricted',
    (mode) => {
      // The full-price modes are meant to reach for deeper reasoning.
      const systemPrompt = createBase2(mode).systemPrompt!

      expect(systemPrompt).not.toContain('Do not spawn thinker-gpt')
      expect(systemPrompt).not.toContain('escalation path')
    },
  )
})

describe('base2 product branding', () => {
  const CREDITS_LINE =
    "Every prompt sent consumes the user's credits, which is calculated based on the API cost of the models used."

  test('lite is branded as paid Codebuff, not as Freebuff', () => {
    // Lite charges credits. It used to inherit free mode's branding and tell
    // paying users they were coding with AI for free.
    const systemPrompt = createBase2('lite').systemPrompt

    expect(systemPrompt).toContain('the product, Codebuff')
    expect(systemPrompt).toContain('# Codebuff Meta-information')
    expect(systemPrompt).not.toContain('Freebuff')
    expect(systemPrompt).not.toContain('for free')
    expect(systemPrompt).not.toContain('freebuff.com')
  })

  test('lite gets the paid meta-information block every other paid mode gets', () => {
    const lite = createBase2('lite').systemPrompt

    expect(lite).toContain(CREDITS_LINE)
    expect(lite).toContain('"/usage"')
    expect(lite).toContain('codebuff.com/docs')
    // The mode list the block recites should name lite as well.
    expect(lite).toContain('DEFAULT, LITE, MAX, or PLAN')
    // And lite introduces itself exactly as the other paid modes do.
    expect(lite!.split('\n')[0]).toBe(
      createBase2('default').systemPrompt!.split('\n')[0],
    )
  })

  test('free mode keeps its Freebuff branding', () => {
    const free = createBase2('free').systemPrompt

    expect(free).toContain('the product, Freebuff')
    expect(free).toContain('to code with AI for free')
    expect(free).toContain('# Freebuff Meta-information')
    expect(free).toContain('freebuff.com')
    expect(free).not.toContain(CREDITS_LINE)
    expect(free).not.toContain('"/usage"')
  })

  test('rebranding lite left its lean orchestration shape untouched', () => {
    const lite = createBase2('lite')
    const free = createBase2('free')
    const paid = createBase2('default')

    // Lean modes edit directly instead of proposing edits.
    expect(lite.toolNames).not.toContain('propose_str_replace')
    expect(lite.toolNames).not.toContain('propose_write_file')
    expect(free.toolNames).not.toContain('propose_str_replace')
    expect(paid.toolNames).toContain('propose_str_replace')

    // And they review with the cheap reviewer rather than spawning an editor.
    expect(lite.spawnableAgents).toContain('code-reviewer-lite')
    expect(lite.spawnableAgents).not.toContain('editor')
  })
})

describe('base2 provider routing', () => {
  test('every mode refuses providers that may keep the data', () => {
    // The privacy policy's no-training promise is made to every user, so paid
    // modes must assert this too, not just the free tier. Verified against
    // OpenRouter: deny still serves luna, gemini-pro, minimax-m3 and opus.
    for (const mode of ['default', 'free', 'lite', 'max', 'fast'] as const) {
      expect(createBase2(mode).providerOptions).toMatchObject({
        data_collection: 'deny',
      })
    }
  })

  test('Claude additionally comes from Bedrock', () => {
    expect(createBase2('default').providerOptions).toEqual({
      only: ['amazon-bedrock'],
      data_collection: 'deny',
    })
    // Bedrock serves no OpenAI or MiMo endpoint, so non-Claude models get the
    // deny without a provider pin.
    expect(createBase2('lite').providerOptions).toEqual({
      data_collection: 'deny',
    })
    expect(
      createBase2('default', { model: FREEBUFF_MIMO_V25_PRO_MODEL_ID })
        .providerOptions,
    ).toEqual({ data_collection: 'deny' })
  })

  test('an explicit providerOptions override wins', () => {
    expect(
      createBase2('free', { providerOptions: {} }).providerOptions,
    ).toEqual({})
  })
})

describe('base2 optional tools', () => {
  test('omits gravity_index and its instruction together', () => {
    const base2 = createBase2('free', { noGravityIndex: true })

    expect(base2.toolNames).not.toContain('gravity_index')
    expect(base2.systemPrompt).not.toContain('gravity_index')
  })
})

describe('base2 context pruning', () => {
  /** What the runtime hands a serialized generator for `model`
   *  (run-programmatic-step.ts): the model plus its pruner thresholds. */
  const stepContextFor = (model: string) => ({
    model,
    contextPruning: {
      maxContextLength: contextPrunerBudgetForModel(model as any),
      ...compactionPolicyForModel(model),
    },
  })

  const getContextPrunerParams = (
    mode: Parameters<typeof createBase2>[0],
    options?: Parameters<typeof createBase2>[1],
    params?: Record<string, unknown>,
  ) => {
    const base2 = createBase2(mode, options)
    const generator = base2.handleSteps!({
      params,
      ...stepContextFor(base2.model),
    } as any)
    const step = generator.next().value as any
    return step.input.params
  }

  const getSerializedContextPrunerParams = (
    mode: Parameters<typeof createBase2>[0],
    options?: Parameters<typeof createBase2>[1],
  ) => {
    const base2 = createBase2(mode, options)
    const handleStepsString = base2.handleSteps!.toString()
    expect(handleStepsString).toMatch(/^function\*\s*\(/)
    const isolatedHandleSteps = new Function(
      `return (${handleStepsString})`,
    )() as NonNullable<typeof base2.handleSteps>
    const generator = isolatedHandleSteps({
      params: undefined,
      ...stepContextFor(base2.model),
    } as any)
    const step = generator.next().value as any
    return step.input.params
  }

  test('free mode (MiniMax M3) defaults context pruning to 400k tokens', () => {
    const base2 = createBase2('free')
    const generator = base2.handleSteps!({ params: undefined } as any)

    expect(generator.next().value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: {
        agent_type: 'context-pruner',
        params: {
          maxContextLength: 400_000,
          cacheExpiryMs: 30 * 60 * 1000,
        },
      },
      includeToolCall: false,
    })
  })

  test('free Kimi mode defaults context pruning to 250k tokens', () => {
    expect(
      getContextPrunerParams('free', { model: FREEBUFF_KIMI_MODEL_ID }),
    ).toEqual({
      maxContextLength: 250_000,
      cacheExpiryMs: 30 * 60 * 1000,
    })
  })

  test('free non-MiniMax/Kimi models default context pruning to 400k tokens', () => {
    expect(
      getContextPrunerParams('free', {
        model: FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
      }),
    ).toEqual({
      maxContextLength: 400_000,
      cacheExpiryMs: 30 * 60 * 1000,
    })
  })

  test('DeepSeek Flash prunes under the Flash policy; other models keep 30 minutes, no floor', () => {
    // Flash's numbers arrive through the runtime's `contextPruning`; the model
    // id is the one literal in the generator, so pin it to the constant.
    expect(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID).toBe(
      'deepseek/deepseek-v4-flash',
    )
    const flashParams = {
      maxContextLength: 400_000,
      ...DEEPSEEK_FLASH_COMPACTION_POLICY,
    }
    const flash = { model: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID }
    expect(getContextPrunerParams('free', flash)).toEqual(flashParams)
    expect(getSerializedContextPrunerParams('default', flash)).toEqual(
      flashParams,
    )
    // base2 is the kill-switch fallback, so it deliberately does NOT take the
    // default policy's hour/140k for the rest.
    expect(DEFAULT_COMPACTION_POLICY.cacheExpiryMs).toBe(60 * 60 * 1000)
    expect(
      getContextPrunerParams('free', {
        model: FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
      }),
    ).toEqual({ maxContextLength: 400_000, cacheExpiryMs: 30 * 60 * 1000 })
  })

  test('free mode preserves explicit context pruning params', () => {
    const base2 = createBase2('free')
    const generator = base2.handleSteps!({
      params: { maxContextLength: 123_000, assistantToolBudget: 10_000 },
    } as any)

    expect(generator.next().value).toMatchObject({
      input: {
        params: {
          maxContextLength: 123_000,
          assistantToolBudget: 10_000,
          cacheExpiryMs: 30 * 60 * 1000,
        },
      },
    })
  })

  test.each(['default', 'lite', 'max', 'fast'] as const)(
    '%s mode defaults context pruning to 400k tokens with a 30-minute cache expiry',
    (mode) => {
      expect(getContextPrunerParams(mode)).toEqual({
        maxContextLength: 400_000,
        cacheExpiryMs: 30 * 60 * 1000,
      })
    },
  )

  test.each([
    [FREEBUFF_KIMI_MODEL_ID, 250_000],
    [FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID, 400_000],
  ] as const)(
    'non-free model %p defaults context pruning to %p tokens',
    (model, maxContextLength) => {
      expect(getContextPrunerParams('default', { model })).toEqual({
        maxContextLength,
        cacheExpiryMs: 30 * 60 * 1000,
      })
    },
  )

  test.each([
    ['free', { model: FREEBUFF_KIMI_MODEL_ID }, 250_000],
    ['free', { model: FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID }, 400_000],
    ['default', { model: FREEBUFF_KIMI_MODEL_ID }, 250_000],
    ['default', { model: FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID }, 400_000],
  ] as const)(
    'serialized %s handleSteps for model %p defaults to %p tokens',
    (mode, options, maxContextLength) => {
      expect(getSerializedContextPrunerParams(mode, options)).toMatchObject({
        maxContextLength,
      })
    },
  )

  test('non-free mode preserves explicit context pruning params', () => {
    expect(
      getContextPrunerParams(
        'default',
        {
          model: FREEBUFF_KIMI_MODEL_ID,
        },
        {
          maxContextLength: 123_000,
          assistantToolBudget: 10_000,
        },
      ),
    ).toEqual({
      maxContextLength: 123_000,
      assistantToolBudget: 10_000,
      cacheExpiryMs: 30 * 60 * 1000,
    })
  })
})

describe('Claude Fable 5.1 root', () => {
  const fable = createBase2('free', {
    model: FREEBUFF_FABLE_5_1_MODEL_ID,
  })

  test('reviews with a Fable reviewer, not the cross-model fallback', () => {
    // The session gate rejects any subagent whose model differs from the one the
    // session was admitted on, so the reviewer must run Fable itself. The
    // fallback (code-reviewer-deepseek-flash) 403s with session_model_mismatch.
    expect(fable.spawnableAgents).toContain('code-reviewer-fable')
    expect(fable.spawnableAgents).not.toContain('code-reviewer-deepseek-flash')
  })
})
