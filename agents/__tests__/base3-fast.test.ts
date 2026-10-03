import { compactionPolicyForModel } from '@codebuff/common/constants/compaction-policy'
import {
  FREE_MODE_AGENT_MODELS,
  FREEBUFF_BASE3_FAST_AGENT_ID,
  FREEBUFF_BASE3_FAST_WORKER_AGENT_ID,
  FREEBUFF_CLI_BASE3_AGENT_ID_BY_MODEL,
  FREEBUFF_ROOT_AGENT_IDS,
  FREEBUFF_WEB_BASE3_AGENT_ID_BY_MODEL,
  hasFreebuffRootSystemPromptOpening,
  isFreeModeAllowedAgentModel,
} from '@codebuff/common/constants/free-agents'
import {
  FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID,
  isFreebuffFastModeModel,
} from '@codebuff/common/constants/freebuff-model-ids'
import { describe, expect, test } from 'bun:test'

import base3FreeDeepseekFlash from '../base3-free-deepseek-flash'
import {
  BASE3_FAST_GUIDANCE,
  BASE3_FAST_SPAWNABLE_AGENTS,
  BASE3_FAST_WORKER_ASSIGNMENT_OPENING,
} from '../base3-fast'
import base3FastFreeDeepseekFlash from '../base3-fast-free-deepseek-flash'
import base3FastWorkerDeepseekFlash from '../base3-fast-worker-deepseek-flash'
import { createBase3, createBase3CliRoot } from '../base3'

/**
 * The base3-fast harness (agents/base3-fast.ts): base3 plus a fan-out.
 *
 * What makes the fan-out affordable is a property of the WORKER definition —
 * it inherits its root's prompt and history, so its request is a cache hit —
 * and what makes it safe is a property of the ROOT prompt: the root verifies.
 * These pin both, and the registrations a Freebuff root needs to run at all.
 */
describe('the base3-fast root', () => {
  const root = base3FastFreeDeepseekFlash

  test('is registered as the fast-mode model root on both surfaces', () => {
    expect(root.id).toBe(FREEBUFF_BASE3_FAST_AGENT_ID)
    expect(root.model).toBe(FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID)
    expect(
      FREEBUFF_CLI_BASE3_AGENT_ID_BY_MODEL[
        FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID
      ],
    ).toBe(root.id)
    expect(
      FREEBUFF_WEB_BASE3_AGENT_ID_BY_MODEL[
        FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID
      ],
    ).toBe(root.id)
    expect(FREEBUFF_ROOT_AGENT_IDS).toContain(root.id)
    expect(isFreeModeAllowedAgentModel(root.id, root.model)).toBe(true)
    expect(isFreebuffFastModeModel(root.model)).toBe(true)
    expect(isFreebuffFastModeModel(base3FreeDeepseekFlash.model)).toBe(false)
  })

  test('is base3 plus spawn_agents, and nothing else moved', () => {
    const plain = createBase3CliRoot({
      model: FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID,
      isFreebuff: true,
    })
    expect(root.toolNames).toEqual([...plain.toolNames!, 'spawn_agents'])
    expect(root.spawnableAgents).toEqual([...BASE3_FAST_SPAWNABLE_AGENTS])
    expect(root.spawnableAgents).toContain(FREEBUFF_BASE3_FAST_WORKER_AGENT_ID)
    expect(root.spawnableAgents).toContain('file-picker')
    // No searcher subagent: the root has code_search, and a spawned searcher
    // only added a root step per query in the 2026-09-26 bench.
    expect(root.spawnableAgents).not.toContain('code-searcher')
    // The base3 levers the runtime reads are untouched.
    expect(root.windowedFileReads).toBe(true)
    expect(root.compactContext).toEqual(compactionPolicyForModel(root.model))
    expect(root.instructionsPrompt).toBeUndefined()
    expect(root.reasoningOptions).toBeUndefined()
    // The bare harness is untouched too: Desktop derives its tools from it.
    expect(createBase3().toolNames).not.toContain('spawn_agents')
  })

  test('appends the fan-out guidance after base3 and before the CLI appendix', () => {
    const prompt = root.systemPrompt!
    // Byte 0, or the chat-completions gate 403s every free-mode turn.
    expect(hasFreebuffRootSystemPromptOpening(prompt)).toBe(true)
    expect(prompt).toContain(BASE3_FAST_GUIDANCE)
    expect(prompt.indexOf(BASE3_FAST_GUIDANCE)).toBeLessThan(
      prompt.indexOf('# Working with the user'),
    )
    expect(prompt.match(/\{CODEBUFF_GIT_CHANGES_PROMPT\}/g)).toHaveLength(1)
  })

  test('keeps every rule the bench runs earned, in the words the model reads', () => {
    // One pin per rule. What each rule bought, and what was tried and
    // removed, is in docs/benchmarks/base3-fast/README.md.
    const prompt = root.systemPrompt!
    for (const phrase of [
      // 1. context: one picker round, then batched reads of the root's own
      '2-3 file-picker agents',
      'never one picker per call',
      'the only picker round',
      'agent_type: "file-picker"',
      'Your SECOND step is ONE read_files call',
      'three steps of your own after the pickers, not thirty',
      "this project's own source, history or packages",
      // 2. the split
      `spawn one ${FREEBUFF_BASE3_FAST_WORKER_AGENT_ID} per slice`,
      'Contract first',
      'Assign, do not dictate',
      BASE3_FAST_WORKER_ASSIGNMENT_OPENING,
      'Every behaviour lands where it takes effect',
      'Tests are part of the change',
      'Match precedent, exactly',
      'a value users already see',
      "Never change an existing default's value",
      'Never give two workers the same file',
      // 3. one verification pass, by the root
      'Verify once, yourself',
      'after the last worker has returned and never before',
      'one typecheck per touched package',
      'never the whole repository',
      'Formatting is not a check',
      'cd <package> && bun run typecheck',
      "`bun --cwd <package> run ...` prints Bun's usage text",
      'never piped through head or tail',
      'A check that passed is finished',
      're-run a check only after you edited a file it covers',
      'No builds, bundlers or ad-hoc scripts',
      're-read the request once against git diff --stat',
      'no default value or public signature may have changed',
    ]) {
      expect(prompt).toContain(phrase)
    }
    // Tried and removed: a searcher subagent, reconnaissance workers, a
    // reviewer worker, a required format pass.
    for (const phrase of [
      'code-searcher',
      'RECONNAISSANCE',
      'REVIEWER',
      'format pass',
    ]) {
      expect(prompt).not.toContain(phrase)
    }
  })
})

describe('the base3-fast worker', () => {
  const worker = base3FastWorkerDeepseekFlash
  const root = base3FastFreeDeepseekFlash

  test('is pinned to its root model and allowlisted for free mode', () => {
    expect(worker.id).toBe(FREEBUFF_BASE3_FAST_WORKER_AGENT_ID)
    expect(worker.model).toBe(root.model)
    expect(FREE_MODE_AGENT_MODELS[worker.id]).toEqual(new Set([worker.model]))
    expect(isFreeModeAllowedAgentModel(worker.id, worker.model)).toBe(true)
    // Not a root: it never opens a session and never passes the root gate.
    expect(FREEBUFF_ROOT_AGENT_IDS).not.toContain(worker.id)
  })

  test('shares its root prefix: inherited prompt, full history, no prompt of its own', () => {
    // The whole point. Either a systemPrompt or a compaction policy of its own
    // would diverge the worker's prefix from the root's and cost the cache.
    expect(worker.inheritParentSystemPrompt).toBe(true)
    expect(worker.includeMessageHistory).toBe(true)
    expect(worker.systemPrompt).toBeUndefined()
    expect(worker.compactContext).toBeUndefined()
    expect(worker.stepPrompt).toBeUndefined()
    // The assignment arrives as the prompt; the standing rules follow it.
    expect(worker.inputSchema?.prompt?.type).toBe('string')
    // Identity first: an inherited coordinator prompt once convinced a worker
    // it WAS the coordinator, and it redid every sibling's slice.
    expect(worker.instructionsPrompt).toMatch(/^You are a WORKER/)
    expect(worker.instructionsPrompt).toContain(
      'Never conclude that the workers did not run',
    )
    expect(worker.instructionsPrompt).toContain('Edit only the files')
    expect(worker.instructionsPrompt).toContain('Do not verify')
    expect(worker.instructionsPrompt).toContain('under 120 words')
    expect(worker.outputMode).toBe('last_message')
  })

  test('can read, search and edit, but cannot run, browse, spawn, ask, or plan', () => {
    const tools = (worker.toolNames ?? []) as string[]
    for (const tool of [
      'read_files',
      'str_replace',
      'write_file',
      'code_search',
      'glob',
      'list_directory',
    ]) {
      expect(tools).toContain(tool)
    }
    // No terminal: verification is the root's, once. No web: the root
    // gathered the context. The rest were never a worker's business.
    for (const tool of [
      'run_terminal_command',
      'web_search',
      'read_url',
      'spawn_agents',
      'spawn_agent_inline',
      'ask_user',
      'suggest_followups',
      'write_todos',
      'set_output',
    ]) {
      expect(tools).not.toContain(tool)
    }
    expect(worker.spawnableAgents).toEqual([])
    // Its tools are a subset of the root's: it sees the root's schema and may
    // only run what the root also has.
    for (const tool of tools) expect(root.toolNames as string[]).toContain(tool)
    // The read_files/glob handlers read this flag off the CHILD template.
    expect(worker.windowedFileReads).toBe(true)
  })
})
