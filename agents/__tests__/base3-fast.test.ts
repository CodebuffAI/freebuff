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
import base3FastFreeDeepseekFlashEvals from '../base3-fast-free-deepseek-flash-evals'
import base3FreeDeepseekFlashEvals from '../base3-free-deepseek-flash-evals'
import base3FastWorkerDeepseekFlash from '../base3-fast-worker-deepseek-flash'
import { createBase3, createBase3CliRoot } from '../base3'

/**
 * The base3-fast harness (agents/base3-fast.ts): base3 plus a fan-out.
 *
 * What makes the fan-out affordable is a property of the WORKER definition —
 * it inherits its root's prompt and history, so its request is a cache hit —
 * and what makes it safe is a property of the ROOT prompt: the root reconciles
 * and verifies. These pin both, the registrations a Freebuff root needs to run
 * at all, and the shape of the guidance: short, suggestive, and firm about
 * exactly two things.
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

  test('is the CLI root plus spawn_agents, assembled from it, and nothing else moved', () => {
    const plain = createBase3CliRoot({
      model: FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID,
      isFreebuff: true,
    })
    expect(root.toolNames).toEqual([...plain.toolNames!, 'spawn_agents'])
    expect(root.spawnableAgents).toEqual([...BASE3_FAST_SPAWNABLE_AGENTS])
    // Pickers and searchers for context, in parallel; the worker for slices.
    expect(root.spawnableAgents).toContain('file-picker')
    expect(root.spawnableAgents).toContain('code-searcher')
    expect(root.spawnableAgents).toContain(FREEBUFF_BASE3_FAST_WORKER_AGENT_ID)
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

  test('keeps the guidance short, suggestive, and firm about two things', () => {
    const guidance = BASE3_FAST_GUIDANCE
    // Short: a few guidelines the model can apply to a question, a one-line
    // fix or a cross-cutting change alike (the previous version ran to 1,300
    // words of rules tuned to the eval set; pass 2.2 added back the
    // fix-and-rerun loop, about 90 words).
    expect(guidance.split(/\s+/).length).toBeLessThan(600)
    // Firm about parallel helpers, and about reconciling what they produce.
    expect(guidance).toContain('really, really helpful')
    expect(guidance).toContain('file-pickers')
    expect(guidance).toContain('code-searchers')
    expect(guidance).toContain('coherence is your job')
    expect(guidance).toContain('names the files it edited')
    // Suggestive everywhere else: questions get answers, exploration is
    // open-ended, searching can be repeated.
    expect(guidance).toContain('just answer or make it')
    expect(guidance).toContain('Follow up with another round of code-searchers')
    // Pass 2.1 clamped verification ("a check that passed is finished") and
    // pushed the split to "more than two files" to win back speed; on all 62
    // tasks that cost 0.4 against base3, almost all of it on the dozen hard
    // tasks where the root used to iterate with tests and typechecks, and the
    // newly split tasks fell 0.6. Pass 2.2 keeps the two cuts that were pure
    // waste (no web search of the repository in front of it, every query in
    // the first searcher round), restores fix-and-rerun, and splits only a
    // change that spans many cleanly partitioned files.
    expect(guidance).toContain('Fix what fails and re-run what you changed')
    // Pass 2.3 tried batching the checks and capping the exploration rounds
    // for speed; on the fair bench it saved five steps a task and no time, and
    // the hard tasks lost 0.7 again. Reverted: pass 2.2 is the shipped text.
    expect(guidance).not.toContain('Batch the checks')
    expect(guidance).toContain(
      'already passed on files you have not edited since',
    )
    expect(guidance).not.toContain('a check that passed is finished')
    expect(guidance).toContain(
      "do not search the web for this project's own code",
    )
    // Pass 2.4: the root implements by default. Across five 62-task runs the
    // tasks it split were the ones it did worst on (0.3-0.8 below base3) and
    // no faster than base3; workers stay spawnable for the one shape of work
    // they suit, and the guidance says which.
    expect(guidance).toContain('Make the change yourself')
    expect(guidance).toContain('repeated across many independent files')
    expect(guidance).not.toContain('spans many files that partition cleanly')
    expect(guidance).not.toContain('more than two files')
    expect(guidance).toContain(
      'put every query you can already think of into that first round',
    )
    for (const absolute of [
      'the only picker round',
      'ONE read_files call',
      'not thirty',
      'bun --cwd',
      'Formatting is not a check',
    ]) {
      expect(guidance).not.toContain(absolute)
    }
    // The split still names the worker and opens every assignment with its role.
    expect(guidance).toContain(
      `spawn one ${FREEBUFF_BASE3_FAST_WORKER_AGENT_ID} per slice`,
    )
    expect(guidance).toContain(BASE3_FAST_WORKER_ASSIGNMENT_OPENING)
    expect(guidance).toContain('Never give two workers the same file')
  })
})

describe('the buffbench arms', () => {
  test('neither arm has the web, and both lost it the same way', () => {
    // read_url is refused by the bench guard; web_search returns snippets,
    // and on a public repository those quote the answer. Withheld from both
    // arms so the comparison measures the harness, not the fetch.
    for (const arm of [
      base3FreeDeepseekFlashEvals,
      base3FastFreeDeepseekFlashEvals,
    ]) {
      expect(arm.toolNames).not.toContain('web_search')
      expect(arm.toolNames).not.toContain('read_url')
      expect(arm.toolNames).not.toContain('ask_user')
    }
    // Otherwise the fast arm is the fast root: the same tools plus spawn_agents.
    expect(base3FastFreeDeepseekFlashEvals.toolNames).toEqual([
      ...base3FreeDeepseekFlashEvals.toolNames!,
      'spawn_agents',
    ])
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
  })

  test('reports in its last message which files it edited', () => {
    // The root reconciles the slices by reading the files the reports name:
    // no git diff step, and no git needed. (A runtime feature that appended
    // the diffs of its edits to the report was tried and removed to keep the
    // runtime simple.)
    expect(worker.outputMode).toBe('last_message')
    expect('includeFileChangesInOutput' in worker).toBe(false)
    expect(worker.instructionsPrompt).toContain(
      'every file you edited and what changed in each',
    )
  })

  test("runs base3's own tools minus the terminal and the todo list, derived not restated", () => {
    const tools = (worker.toolNames ?? []) as string[]
    const base3Tools = createBase3(worker.model).toolNames as string[]
    expect(tools).toEqual(
      base3Tools.filter(
        (name) => name !== 'run_terminal_command' && name !== 'write_todos',
      ),
    )
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
    // No terminal: verification is the root's, once. No web, no spawning, no
    // human: those were never a worker's business.
    for (const tool of [
      'run_terminal_command',
      'write_todos',
      'web_search',
      'read_url',
      'spawn_agents',
      'ask_user',
      'suggest_followups',
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
