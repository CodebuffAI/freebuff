/**
 * Desktop feedback, 2026-09-24 and 09-27: "with BYOK the agent compacts every
 * ~5 minutes", "keeps compressing context every 3-5 turns and produces
 * nothing". A connection saved from the settings form without opening its
 * Advanced section stores the pre-filled 32,768 / 4,096 limits, so a run
 * compacted at 80% of 90% of (32,768 - 4,096) = 20,643 tokens, and a coding
 * agent's system prompt and tool catalog alone are ~15-20k of that.
 *
 * This drives a real SDK run end to end against a scripted OpenAI-compatible
 * provider whose model is in no catalog: a long read-heavy task, then counts
 * how often the run stopped to compact.
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  BYOK_UNKNOWN_REMOTE_CONTEXT_WINDOW,
  clearByokContextWindowCache,
  createByokConnectionStore,
  withEffectiveByokLimits,
  type ByokConnection,
  type ResolvedByokConnection,
} from '../byok'
import { CodebuffClient } from '../client'

import { COMPACTION_SUMMARY_PROMPT_OPENING } from '@codebuff/common/constants/compaction-summary'

import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'

const FILES = 12
const BASE_URL = 'https://llm.example.com/v1'
const MODEL = 'acme/coder-unlisted'

/** ~15k estimated tokens: the order of the Desktop thread agent's system
 *  prompt plus its tool catalog, which are outside the compactable history. */
const agent: AgentDefinition = {
  id: 'byok-long-task-agent',
  displayName: 'BYOK long task',
  model: 'ignored-by-byok',
  toolNames: ['read_files'],
  systemPrompt:
    'Read every file the user names before answering. Follow the project conventions carefully. '.repeat(
      500,
    ),
}

function sse(body: unknown): Response {
  return new Response(`data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function scriptedProvider(modelsBody: unknown) {
  const counts = { work: 0, summaries: 0, modelListings: 0 }
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input)
    if (url === `${BASE_URL}/models`) {
      counts.modelListings++
      return Response.json(modelsBody)
    }
    expect(url).toBe(`${BASE_URL}/chat/completions`)
    const body = JSON.parse(String(init?.body))
    if (JSON.stringify(body.messages.at(-1)).includes(COMPACTION_SUMMARY_PROMPT_OPENING)) {
      counts.summaries++
      return sse({
        id: `summary-${counts.summaries}`, object: 'chat.completion.chunk', created: 1, model: MODEL,
        choices: [{ index: 0, delta: { content: `## Objective\n${'- review the twelve files\n'.repeat(20)}` }, finish_reason: 'stop' }],
      })
    }
    counts.work++
    // A provider that honours `stream_options.include_usage`, as BYOK asks:
    // compaction decides on this count, never on a text estimate.
    const promptTokens = Math.ceil(JSON.stringify(body.messages).length / 3)
    const usage = { prompt_tokens: promptTokens, completion_tokens: 20, total_tokens: promptTokens + 20 }
    if (counts.work <= FILES) {
      return sse({
        id: `work-${counts.work}`, object: 'chat.completion.chunk', created: 1, model: MODEL, usage,
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `read-${counts.work}`, type: 'function',
          function: { name: 'read_files', arguments: JSON.stringify({ paths: [`file${counts.work}.ts`] }) } }] },
          finish_reason: 'tool_calls' }],
      })
    }
    return sse({
      id: 'final', object: 'chat.completion.chunk', created: 1, model: MODEL, usage,
      choices: [{ index: 0, delta: { content: 'FINAL ANSWER: all twelve files reviewed.' }, finish_reason: 'stop' }],
    })
  }) as typeof fetch
  return { counts, fetchImpl }
}

/** A connection exactly as the settings form saves it with Advanced untouched. */
async function savedWithFormDefaults(): Promise<ResolvedByokConnection> {
  let rows: ByokConnection[] = []
  const secrets = new Map<string, string>()
  const store = createByokConnectionStore({
    metadataStore: {
      get: async () => structuredClone(rows),
      set: async (value) => { rows = structuredClone(value) },
    },
    secretStore: {
      get: async (ref) => secrets.get(ref),
      set: async (ref, value) => { secrets.set(ref, value) },
      delete: async (ref) => { secrets.delete(ref) },
    },
  })
  const created = await store.create({
    name: 'Acme', provider: 'openai-compatible', baseUrl: BASE_URL, model: MODEL,
    apiKey: 'acme-key', contextWindow: 32_768, maxOutputTokens: 4_096,
  })
  expect(created).toMatchObject({ contextWindow: 32_768, maxOutputTokens: 4_096 })
  return store.resolve(created)
}

async function longTask(byok: ResolvedByokConnection, fetchImpl: typeof fetch) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'freebuff-byok-compaction-'))
  for (let i = 1; i <= FILES; i++) {
    // ~2k estimated tokens each: a modest source file.
    await writeFile(path.join(cwd, `file${i}.ts`), `export const value${i} = ${i} // keep this line\n`.repeat(150))
  }
  globalThis.fetch = fetchImpl
  const client = new CodebuffClient({ cwd, agentDefinitions: [agent], byok })
  const passes: Array<{ trigger: string }> = []
  const lifecycle: string[] = []
  const result = await client.run({
    agent: agent.id,
    prompt: `Review file1.ts through file${FILES}.ts.`,
    onCompaction: (receipt) => {
      passes.push(receipt)
      lifecycle.push('receipt')
    },
    onCompactionStart: ({ trigger }) => lifecycle.push(`start:${trigger}`),
    onCompactionEnd: () => lifecycle.push('end'),
  })
  return { result, passes, lifecycle }
}

describe('BYOK compaction on an unlisted model', () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => clearByokContextWindowCache())
  afterEach(() => { globalThis.fetch = originalFetch })

  test('the untouched 32k default keeps hitting its limit, and each time swaps in a summary', async () => {
    const { counts, fetchImpl } = scriptedProvider({ data: [] })
    const { result, passes, lifecycle } = await longTask(await savedWithFormDefaults(), fetchImpl)
    // Twelve ordinary reads keep this window at its limit, over and over.
    // Each time the history is replaced by a summary; one that was ready in
    // the background is used with no wait, so only the others show
    // "Compacting…", and each of those is closed after its receipt.
    expect(passes.length).toBeGreaterThanOrEqual(2)
    expect(passes.every((pass) => pass.trigger === 'context_limit')).toBe(true)
    expect(lifecycle.filter((entry) => entry === 'receipt')).toHaveLength(
      passes.length,
    )
    let open = false
    for (const entry of lifecycle) {
      if (entry.startsWith('start:')) {
        expect(open).toBe(false)
        open = true
      } else if (entry === 'end') {
        expect(open).toBe(true)
        open = false
      }
    }
    expect(open).toBe(false)
    expect(counts.summaries).toBeGreaterThanOrEqual(passes.length)
    expect(counts.work).toBe(FILES + 1)
    expect(result.output.type).not.toBe('error')
  }, 60_000)

  test('the effective window lets the same task run without compacting and still answer', async () => {
    const { counts, fetchImpl } = scriptedProvider({ data: [{ id: 'someone/else', context_length: 8_192 }] })
    const effective = await withEffectiveByokLimits(await savedWithFormDefaults(), { fetch: fetchImpl })
    expect(effective.contextWindow).toBe(BYOK_UNKNOWN_REMOTE_CONTEXT_WINDOW)
    expect(effective.apiKey).toBe('acme-key')
    expect(Object.keys(effective)).not.toContain('apiKey')
    expect(counts.modelListings).toBe(1)

    const { result, passes, lifecycle } = await longTask(effective, fetchImpl)
    expect(passes).toEqual([])
    expect(lifecycle).toEqual([])
    expect(counts.work).toBe(FILES + 1)
    expect(result.output.type).not.toBe('error')
    expect(JSON.stringify(result.output)).toContain('FINAL ANSWER: all twelve files reviewed.')
  }, 60_000)
})
