import { expect, test } from 'bun:test'
import {
  automaticCompactionIsWorthwhile,
  compactedContextCeiling,
  compactionOutputTokens,
  compactionSummaryBudget,
  compactWithModel,
  compactWithModelOrFallback,
  COMPACTION_TAG,
  parseCompactionSummary,
  SUMMARY_OVERRUN_TOLERANCE,
} from '../model-compaction'
import { promptSuccess } from '@codebuff/common/util/error'
import { DEEPSEEK_FLASH_COMPACTION_POLICY } from '@codebuff/common/constants/compaction-policy'
import { evaluateCompactionTrigger } from '../compact-history'
import { countTokens, countTokensMessages } from '../util/token-counter'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { PromptAiSdkStreamFn } from '@codebuff/common/types/contracts/llm'

const user = (text: string): Message => ({
  role: 'user',
  tags: ['USER_PROMPT'],
  content: [{ type: 'text', text }],
})
const messages: Message[] = [
  user('Compare the time units in a.ts and b.ts.'),
  {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'a',
        toolName: 'read_files',
        input: { paths: ['a.ts'] },
      },
    ],
  },
  {
    role: 'tool',
    toolName: 'read_files',
    toolCallId: 'a',
    content: [
      {
        type: 'json',
        value: [
          {
            path: 'a.ts',
            content:
              'A_EXPECTS_MILLISECONDS\n' +
              'const timeoutMs = 5000;\n'.repeat(200),
          },
        ],
      },
    ],
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'Next inspect b.ts.' }],
  },
  {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'b',
        toolName: 'read_files',
        input: { paths: ['b.ts'] },
      },
    ],
  },
  {
    role: 'tool',
    toolName: 'read_files',
    toolCallId: 'b',
    content: [
      {
        type: 'json',
        value: [
          {
            path: 'b.ts',
            content:
              'B_PRODUCES_SECONDS\n' +
              'const timeoutSeconds = 5;\n'.repeat(200),
          },
        ],
      },
    ],
  },
]
const summary =
  '## Objective\nCompare time units.\n## Important Details\n- a.ts expects milliseconds; b.ts produces seconds.\n## Work State\n### Active\n- Compare and explain the mismatch.'
const emit = async function* (
  value = summary,
): ReturnType<PromptAiSdkStreamFn> {
  yield {
    type: 'tool-call',
    toolCallId: 'summary',
    toolName: 'complete_compaction',
    input: { summary: value },
  }
  return promptSuccess('compaction-id')
}
const run = (
  stream: Parameters<typeof compactWithModel>[0]['stream'],
  overrides: Partial<Parameters<typeof compactWithModel>[0]> = {},
) =>
  compactWithModel({
    messages,
    system: 'You are a coding agent.',
    maxContextLength: 16_384,
    fixedTokenCount: 500,
    signal: new AbortController().signal,
    stream,
    ...overrides,
  })

test('summarizes actual findings from sequential reads and installs exactly the returned handoff', async () => {
  const before = structuredClone(messages)
  const result = await run((request) => {
    const text = JSON.stringify(request)
    expect(text).toContain('A_EXPECTS_MILLISECONDS')
    expect(text).toContain('B_PRODUCES_SECONDS')
    return emit()
  })
  expect(result?.summary).toBe(summary)
  expect(result?.messages[0].tags).toContain(COMPACTION_TAG)
  expect(JSON.stringify(result?.messages)).toContain(
    summary.replaceAll('\n', '\\n'),
  )
  expect(result?.messages.at(-1)).toMatchObject(messages[0])
  expect(result!.postTokens).toBeLessThan(result!.preTokens)
  expect(messages).toEqual(before)
})

test('oversized history is read in bounded sections, with findings carried between model calls', async () => {
  let calls = 0
  const seen: string[] = []
  const result = await run(
    (request) => {
      expect(countTokensMessages(request)).toBeLessThanOrEqual(4096)
      const text = JSON.stringify(request)
      seen.push(text)
      if (calls++) expect(text).toContain('Previous anchored summary:')
      return emit()
    },
    { maxContextLength: 4096 },
  )
  expect(calls).toBeGreaterThan(1)
  expect(seen.join('')).toContain('A_EXPECTS_MILLISECONDS')
  expect(seen.join('')).toContain('B_PRODUCES_SECONDS')
  expect(result?.summary).toBe(summary)
})

test('screenshot pixels are named, not serialized, so the summary is one call and not dozens', async () => {
  // The shape Freebuff Desktop's screenshot tool returns (thread-agent.ts):
  // the pixels ride a `media` part, the note a `json` part. A 3D-app thread
  // with a few of these, compacted under GLM's 400k budget, sent 806,223-token
  // summarizer requests one after another for minutes, then restarted on
  // every later turn because a Stop threw the unfinished pass away.
  const screenshot = 'iVBORw0KGgoAAAANSUhEUgAA'.repeat(20_000) // ~480 KB of base64
  const withScreenshots: Message[] = [
    user('Why does the reveal wash the scene out white?'),
    ...[1, 2, 3].flatMap((n): Message[] => [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: `s${n}`,
            toolName: 'browser_screenshot',
            input: {},
          },
        ],
      },
      {
        role: 'tool',
        toolName: 'browser_screenshot',
        toolCallId: `s${n}`,
        content: [
          { type: 'media', data: screenshot, mediaType: 'image/png' },
          { type: 'json', value: { ok: true, note: `SHOT_${n}_NOTE` } },
        ],
      },
    ]),
    {
      role: 'tool',
      toolName: 'mcp_capture',
      toolCallId: 'm1',
      content: [
        {
          type: 'json',
          value: {
            data: `data:image/jpeg;base64,${screenshot}`,
            raw: screenshot,
            caption: 'MCP_CAPTION',
          },
        },
      ],
    },
  ]
  const requests: string[] = []
  const result = await run(
    (request) => {
      requests.push(JSON.stringify(request))
      return emit()
    },
    { messages: withScreenshots, maxContextLength: 16_384 },
  )
  // One section: before this, ~2 MB of base64 at 3 chars/token was ~640k
  // estimated tokens, split into ~40 sequential summarizer calls.
  expect(requests).toHaveLength(1)
  expect(requests[0]).not.toContain('iVBORw0KGgo')
  expect(requests[0]).toContain('[image/png omitted from this summary request]')
  expect(requests[0]).toContain('[image/jpeg omitted from this summary request]')
  // Everything that is not pixels still reaches the summarizer.
  for (const kept of ['SHOT_1_NOTE', 'SHOT_3_NOTE', 'MCP_CAPTION'])
    expect(requests[0]).toContain(kept)
  expect(result?.summary).toBe(summary)
  // The source history is never mutated; the pixels are still there for the model.
  expect(JSON.stringify(withScreenshots)).toContain('iVBORw0KGgo')
})

test('prose and code in a tool result are never mistaken for base64', async () => {
  const longCode = 'const timeoutMs = 5000;\n'.repeat(400)
  const longWord = 'A'.repeat(2_000)
  const requests: string[] = []
  await run(
    (request) => {
      requests.push(JSON.stringify(request))
      return emit()
    },
    {
      messages: [
        user('Read these.'),
        {
          role: 'tool',
          toolName: 'read_files',
          toolCallId: 'r',
          content: [{ type: 'json', value: { code: longCode, word: longWord } }],
        },
      ],
      maxContextLength: 32_768,
    },
  )
  expect(requests.join('')).toContain('const timeoutMs = 5000;')
  expect(requests.join('')).toContain(longWord)
  expect(requests.join('')).not.toContain('omitted from this summary request')
})

test('invalid, missing, unexpected and interrupted tool outputs preserve source history', async () => {
  const before = structuredClone(messages)
  const streams: Array<() => ReturnType<PromptAiSdkStreamFn>> = [
    () => emit(''),
    async function* () {
      yield { type: 'text', text: 'ordinary answer' }
      return promptSuccess(null)
    },
    async function* () {
      yield {
        type: 'tool-call',
        toolCallId: 'bad',
        toolName: 'write_file',
        input: { path: 'bad' },
      }
      return promptSuccess(null)
    },
    async function* () {
      yield {
        type: 'tool-call',
        toolCallId: 's',
        toolName: 'complete_compaction',
        input: { summary },
      }
      throw new Error('connection interrupted')
    },
  ]
  for (const stream of streams) await expect(run(stream)).rejects.toThrow()
  expect(messages).toEqual(before)
})

test('cancellation, including after the final tool call, never returns a replacement', async () => {
  const controller = new AbortController()
  await expect(
    run(
      async function* () {
        yield {
          type: 'tool-call',
          toolCallId: 's',
          toolName: 'complete_compaction',
          input: { summary },
        }
        controller.abort()
        return promptSuccess(null)
      },
      { signal: controller.signal },
    ),
  ).rejects.toThrow()
})

test('a handoff without new work is a no-op', async () => {
  const first = await run(() => emit())
  expect(
    await run(
      () => {
        throw new Error('must not call')
      },
      { messages: first!.messages },
    ),
  ).toBeNull()
})

// Regression for "ZodError: expected object, received string at
// compactWithModel" (Freebuff Cloud, 2026-09-23). The AI SDK emits a tool call
// whose arguments failed the schema with `input` as the parsed-or-raw TEXT, so
// the summarizer's call can reach the runtime as a string.
test('parseCompactionSummary decodes every argument shape a provider produces', () => {
  const obj = { summary }
  expect(parseCompactionSummary(obj)).toBe(summary)
  // Double-encoded arguments: the SDK parsed one layer, one remains.
  expect(parseCompactionSummary(JSON.stringify(obj))).toBe(summary)
  expect(parseCompactionSummary(JSON.stringify(JSON.stringify(obj)))).toBe(
    summary,
  )
  // A Markdown fence around the arguments.
  expect(
    parseCompactionSummary('```json\n' + JSON.stringify(obj) + '\n```'),
  ).toBe(summary)
  // Unknown keys are ignored rather than rejecting the whole handoff.
  expect(parseCompactionSummary({ summary, note: 'extra' })).toBe(summary)
  // Prose written straight into the argument slot is the handoff itself.
  expect(parseCompactionSummary(summary)).toBe(summary)
  // Truncated JSON (output cap), empty, and non-summary shapes are rejected.
  expect(parseCompactionSummary('{"summary": "half a sum')).toBeUndefined()
  expect(parseCompactionSummary('')).toBeUndefined()
  expect(parseCompactionSummary({ summary: '   ' })).toBeUndefined()
  expect(parseCompactionSummary({ text: summary })).toBeUndefined()
  expect(parseCompactionSummary(['a'])).toBeUndefined()
  expect(parseCompactionSummary(null)).toBeUndefined()
  expect(parseCompactionSummary(42)).toBeUndefined()
})

const stringInput = (text: string) => text as unknown as Record<string, unknown>

test('a string-encoded complete_compaction call compacts instead of throwing a ZodError', async () => {
  const result = await run(async function* () {
    yield {
      type: 'tool-call',
      toolCallId: 'summary',
      toolName: 'complete_compaction',
      input: stringInput(JSON.stringify({ summary })),
    }
    return promptSuccess('compaction-id')
  })
  expect(result?.summary).toBe(summary)
})

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

test('compactWithModelOrFallback falls back to mechanical compaction on any summarizer failure', async () => {
  const before = structuredClone(messages)
  const warnings: unknown[] = []
  const failures: Array<() => ReturnType<PromptAiSdkStreamFn>> = [
    async function* () {
      yield {
        type: 'tool-call',
        toolCallId: 's',
        toolName: 'complete_compaction',
        input: stringInput('{"summary": "cut off'),
      }
      return promptSuccess(null)
    },
    async function* () {
      yield { type: 'error', message: 'provider 500' }
      return promptSuccess(null)
    },
    async function* () {
      throw new Error('connection reset')
    },
  ]
  for (const stream of failures) {
    const result = await compactWithModelOrFallback({
      messages,
      system: 'You are a coding agent.',
      maxContextLength: 16_384,
      fixedTokenCount: 500,
      signal: new AbortController().signal,
      stream,
      logger: { ...noopLogger, warn: (data: unknown) => warnings.push(data) },
    })
    expect(result?.fallback).toBe(true)
    expect(result!.postTokens).toBeLessThan(result!.preTokens)
    // The live request survives the mechanical pass.
    expect(JSON.stringify(result!.messages)).toContain(
      'Compare the time units in a.ts and b.ts.',
    )
  }
  expect(warnings).toHaveLength(failures.length)
  expect(warnings.map((w) => (w as { error_kind: string }).error_kind)).toEqual(
    ['invalid_summary', 'provider_error', 'provider_error'],
  )
  expect(warnings[0]).toMatchObject({
    axiomEvent: 'model_compaction.fallback',
    fallback_applied: true,
    fallback_failed: false,
  })
  expect(messages).toEqual(before)
})

test('a fallback on a resumed tool exchange consumes the old idle gap', async () => {
  // A session ended after a tool result, then the user returned the next day.
  // The fallback must preserve that pending exchange without reusing its idle
  // gap when the next tool output crosses Flash's 40k compaction floor.
  const now = Date.now()
  const yesterday = now - 24 * 60 * 60 * 1000
  const history: Message[] = messages.map((message) =>
    message.role === 'tool' ? structuredClone(message) : { ...message, sentAt: yesterday },
  )
  history[2] = {
    role: 'tool',
    toolName: 'read_files',
    toolCallId: 'a',
    content: [{ type: 'json', value: [{ path: 'a.ts', content: 'old code\n'.repeat(30_000) }] }],
  }
  history.push({ ...user('Investigate the failed CI run.'), sentAt: now })
  const original = structuredClone(history)
  const fixedTokenCount = 15_000
  const trigger = (messages: Message[], contextTokenCount = countTokensMessages(messages) + fixedTokenCount) =>
    evaluateCompactionTrigger({
      ...DEEPSEEK_FLASH_COMPACTION_POLICY,
      messages,
      contextTokenCount,
      maxContextLength: 320_000,
    }).trigger
  expect(trigger(history)).toBe('cache_expiry')

  const result = await compactWithModelOrFallback({
    messages: history,
    system: 'You are a coding agent.',
    maxContextLength: 400_000,
    fixedTokenCount,
    fallbackTargetTokens: 272_000,
    signal: new AbortController().signal,
    stream: async function* () {
      throw new Error('summarizer failed')
    },
    logger: noopLogger,
  })
  expect(result?.fallback).toBe(true)
  expect(result!.postTokens).toBeLessThan(40_000)
  expect(history).toEqual(original)
  const withoutTimestamp = (messages: Message[]) => messages.map(({ sentAt, ...message }) => message)
  expect(withoutTimestamp(result!.messages.slice(-3))).toEqual(withoutTimestamp(history.slice(-3)))

  const resumedAt = Date.now()
  const continued: Message[] = [
    ...result!.messages,
    { role: 'assistant', sentAt: resumedAt, content: [{ type: 'tool-call', toolName: 'run_terminal_command', toolCallId: 'next', input: { command: 'git status' } }] },
    { role: 'tool', toolName: 'run_terminal_command', toolCallId: 'next', content: [{ type: 'json', value: { stdout: 'command output '.repeat(5_000) } }] },
  ]
  expect(countTokensMessages(continued) + fixedTokenCount).toBeGreaterThan(40_000)
  expect(trigger(continued)).toBeNull()
  // Context pressure still compacts, and a genuinely new idle gap still counts.
  expect(trigger(continued, 320_001)).toBe('context_limit')
  expect(trigger([
    ...continued,
    { ...user('Continue after another break.'), sentAt: resumedAt + 16 * 60 * 1000 },
  ])).toBe('cache_expiry')
})

test('compactWithModelOrFallback still propagates cancellation', async () => {
  const controller = new AbortController()
  await expect(
    compactWithModelOrFallback({
      messages,
      system: 'You are a coding agent.',
      maxContextLength: 16_384,
      fixedTokenCount: 500,
      signal: controller.signal,
      logger: noopLogger,
      stream: async function* () {
        controller.abort()
        yield { type: 'text', text: '' }
        return promptSuccess(null)
      },
    }),
  ).rejects.toThrow()
})

// Desktop BYOK, 2026-09-24..27: a connection on the untouched 32k default
// compacts at 80% of 90% of (32,768 - 4,096) = 20,643 tokens, and the Desktop
// agent's prompt and tool catalog alone are ~15-20k. The best any compaction
// can do there lands back near the threshold, so firing at it compacted every
// few tool calls, each pass summarizing the previous summary.
test('an automatic compaction that cannot clear its own threshold is not worthwhile', () => {
  const byokDefault = { maxContextLength: 25_804, thresholdTokens: 20_643 }
  expect(
    automaticCompactionIsWorthwhile({ messages, ...byokDefault, fixedTokenCount: 16_000 }),
  ).toBe(false)
  // The same window with a small fixed prompt has room to work after a pass.
  expect(
    automaticCompactionIsWorthwhile({ messages, ...byokDefault, fixedTokenCount: 3_000 }),
  ).toBe(true)
  // Hosted budgets are unaffected: 400k budget, 320k threshold.
  expect(
    automaticCompactionIsWorthwhile({
      messages,
      maxContextLength: 400_000,
      thresholdTokens: 320_000,
      fixedTokenCount: 20_000,
    }),
  ).toBe(true)
  // The ceiling is the fixed prefix, the verbatim live request and the summary budget.
  const ceiling = compactedContextCeiling({ messages, maxContextLength: 400_000, fixedTokenCount: 20_000 })
  expect(ceiling).toBe(20_000 + countTokensMessages([messages[0]]) + 6_000)
})

test('an automatic fallback aims below the trigger instead of refilling the whole budget', async () => {
  const failing = async function* (): ReturnType<PromptAiSdkStreamFn> {
    throw new Error('connection reset')
  }
  const params = {
    messages,
    system: 'You are a coding agent.',
    maxContextLength: 16_384,
    fixedTokenCount: 500,
    signal: new AbortController().signal,
    stream: failing,
    logger: noopLogger,
  }
  const whole = await compactWithModelOrFallback(params)
  const aimed = await compactWithModelOrFallback({ ...params, fallbackTargetTokens: 1_500 })
  expect(whole?.fallback).toBe(true)
  expect(aimed?.fallback).toBe(true)
  expect(aimed!.postTokens).toBeLessThanOrEqual(1_500)
  expect(aimed!.postTokens).toBeLessThan(whole!.postTokens)
  expect(JSON.stringify(aimed!.messages)).toContain('Compare the time units in a.ts and b.ts.')
  // A target that cannot hold the live request falls back to the whole budget
  // rather than leaving the history uncompacted.
  const tooSmall = await compactWithModelOrFallback({ ...params, fallbackTargetTokens: 400 })
  expect(tooSmall?.postTokens).toBe(whole!.postTokens)
})

// BYOK compaction truncation: the instruction asked for "approximately 6000
// tokens" of summary, but every BYOK request is clamped to the connection's
// output cap, 4,096 on an unconfigured connection (`byokModelLimits`). The
// summarizer ran out of output mid-summary.
test('the requested summary fits the output cap the request is clamped to', () => {
  const roomy = { maxContextLength: 111_513, fixedTokenCount: 18_000, suffixTokens: 200 }
  // Hosted: no model cap, unchanged 16,384 / 6,000.
  expect(compactionOutputTokens()).toBe(16_384)
  expect(compactionSummaryBudget(roomy)).toBe(6_000)
  // An unconfigured BYOK connection: at most half the cap is asked for as summary.
  expect(compactionOutputTokens(4_096)).toBe(4_096)
  expect(compactionSummaryBudget({ ...roomy, maxOutputTokens: 4_096 })).toBe(2_048)
  // A cap above the request's own never raises it.
  expect(compactionOutputTokens(65_536)).toBe(16_384)
  expect(compactionSummaryBudget({ ...roomy, maxOutputTokens: 65_536 })).toBe(6_000)
  // The context bound still wins when it is tighter.
  expect(
    compactionSummaryBudget({ maxContextLength: 6_000, fixedTokenCount: 1_000, suffixTokens: 200, maxOutputTokens: 4_096 }),
  ).toBe(1_600)
  // Every budget leaves the other half of the cap for tool-call JSON and reasoning.
  for (const cap of [512, 1_000, 2_048, 4_096, 8_192, 12_000])
    expect(compactionSummaryBudget({ ...roomy, maxOutputTokens: cap }) * 2).toBeLessThanOrEqual(
      compactionOutputTokens(cap),
    )
  // A smaller summary lowers the context a compaction can leave behind.
  expect(
    compactedContextCeiling({ messages, maxContextLength: 400_000, fixedTokenCount: 20_000, maxOutputTokens: 4_096 }),
  ).toBe(20_000 + countTokensMessages([messages[0]]) + 2_048)
})

test('a capped summarizer request asks for a summary that fits its max_tokens', async () => {
  const seen: Array<{ maxOutputTokens: number; instruction: string }> = []
  const capture: Parameters<typeof compactWithModel>[0]['stream'] = (request, maxOutputTokens) => {
    seen.push({ maxOutputTokens, instruction: JSON.stringify(request.at(-1)) })
    return emit()
  }
  await run(capture, { maxContextLength: 111_513, maxOutputTokens: 4_096 })
  await run(capture, { maxContextLength: 111_513 })
  expect(seen[0].maxOutputTokens).toBe(4_096)
  expect(seen[0].instruction).toContain('under approximately 2048 tokens')
  expect(seen[1].maxOutputTokens).toBe(16_384)
  expect(seen[1].instruction).toContain('under approximately 6000 tokens')
})

// What a summary cut off at the cap looks like when it still arrives as a
// well-formed call: prose in the argument slot (taken as the summary), or
// arguments the provider closed. Only the finish reason tells.
const truncated =
  '## Objective\n- Fix the retry loop in uploader.ts.\n## Important Details\n- The backoff multiplies by'
const cutOff = (input: unknown) =>
  (async function* (
    _request: Message[],
    _maxOutputTokens: number,
    onFinishReason: (finishReason: string) => void,
  ): ReturnType<PromptAiSdkStreamFn> {
    yield {
      type: 'tool-call',
      toolCallId: 'summary',
      toolName: 'complete_compaction',
      input: input as Record<string, unknown>,
    }
    onFinishReason('length')
    return promptSuccess('compaction-id')
  })

test('a summary that stopped on the output limit is never installed', async () => {
  const before = structuredClone(messages)
  for (const input of [truncated, { summary: truncated }]) {
    // Without the finish reason, both shapes parse as a complete summary.
    expect(parseCompactionSummary(input)).toBe(truncated)
    await expect(
      run((request, maxOutputTokens, onFinishReason) =>
        cutOff(input)(request, maxOutputTokens, onFinishReason),
      ),
    ).rejects.toThrow('output token limit')
  }
  expect(messages).toEqual(before)
  // A normal stop with the same shape is accepted.
  const complete = await run(async function* (_r, _m, onFinishReason) {
    yield { type: 'tool-call', toolCallId: 's', toolName: 'complete_compaction', input: { summary } }
    onFinishReason('tool-calls')
    return promptSuccess('compaction-id')
  })
  expect(complete?.summary).toBe(summary)
})

test('a truncated summary falls back to mechanical compaction and is reported as output_limit', async () => {
  const warnings: unknown[] = []
  const result = await compactWithModelOrFallback({
    messages,
    system: 'You are a coding agent.',
    maxContextLength: 16_384,
    fixedTokenCount: 500,
    maxOutputTokens: 4_096,
    signal: new AbortController().signal,
    stream: (request, maxOutputTokens, onFinishReason) =>
      cutOff({ summary: truncated })(request, maxOutputTokens, onFinishReason),
    logger: { ...noopLogger, warn: (data: unknown) => warnings.push(data) },
  })
  expect(result?.fallback).toBe(true)
  expect(result?.summary).not.toContain('The backoff multiplies by')
  expect(warnings).toMatchObject([{ error_kind: 'output_limit', fallback_applied: true }])
})

// Prod, 2026-09-23..29: ~2-3k model handoffs a day on the CLI and ~0.5-1k on
// the runner were thrown away as `invalid_summary` and replaced by the
// mechanical pass. Joined to the ledger (2026-09-28 sample), 84% of them were
// a real complete_compaction call of 3k-9k output tokens (DeepSeek V4 Flash
// median ~5,800) against a 6,000-token request, and 15% wrote the handoff as
// reply text instead of calling the tool. The shapes below are those replies.
const handoff = [
  '## Objective',
  '- Keep the uploader retrying on 429s without hammering the API.',
  '',
  '## Important Details',
  "- The user's config lives in C:\\Users\\dev\\uploader\\config.json; retries read `maxRetries` from it.",
  '- `backoff()` in src/retry.ts multiplies by 2 and caps at 30s.',
  '',
  '## Work State',
  '### Completed',
  '- Added jitter to backoff(); unit tests pass.',
  '### Active',
  '- Wiring Retry-After into the 429 path.',
  '### Blocked',
  '- (none)',
  '',
  '## Next Move',
  '1. Read Retry-After in src/upload.ts and pass it to backoff().',
  '',
  '## Relevant Files',
  '- src/retry.ts: backoff policy.',
  '- src/upload.ts: the 429 handler.',
].join('\n')

const bigMessages: Message[] = [
  user('Make the uploader back off properly on 429s.'),
  {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'r',
        toolName: 'read_files',
        input: { paths: ['src/upload.ts'] },
      },
    ],
  },
  {
    role: 'tool',
    toolName: 'read_files',
    toolCallId: 'r',
    content: [
      {
        type: 'json',
        value: [
          {
            path: 'src/upload.ts',
            content: 'export const retries = 3; // upload\n'.repeat(9_000),
          },
        ],
      },
    ],
  },
]
const hosted = {
  messages: bigMessages,
  maxContextLength: 400_000,
  fixedTokenCount: 20_000,
}
// ~7,000 estimated tokens against the 6,000 hosted request: the shape of the
// median rejected DeepSeek handoff.
const longHandoff = `${handoff}\n\n${'- Checked src/retry.ts: backoff doubles each attempt up to the cap.\n'.repeat(310)}`

const replying = (text: string, finishReason = 'stop') =>
  async function* (
    _request: Message[],
    _maxOutputTokens: number,
    onFinishReason: (finishReason: string) => void,
  ): ReturnType<PromptAiSdkStreamFn> {
    // Streamed in pieces, the way a provider delivers it.
    for (let i = 0; i < text.length; i += 700)
      yield { type: 'text', text: text.slice(i, i + 700) }
    onFinishReason(finishReason)
    return promptSuccess('compaction-id')
  }

test('a handoff somewhat longer than requested is installed, not thrown away', async () => {
  expect(countTokens(longHandoff)).toBeGreaterThan(6_000)
  expect(countTokens(longHandoff)).toBeLessThan(6_000 * SUMMARY_OVERRUN_TOLERANCE)
  const result = await run(() => emit(longHandoff), hosted)
  expect(result?.summary).toBe(longHandoff.trim())
  expect(result).toMatchObject({
    summarySource: 'tool_call',
    summaryBudget: 6_000,
    sections: 1,
  })
  expect(result!.postTokens).toBeLessThan(result!.preTokens)
})

test('a handoff far past the requested length, or one that would leave the run over its target, is refused', async () => {
  const runaway = `${handoff}\n${'- detail\n'.repeat(4_500)}`
  expect(countTokens(runaway)).toBeGreaterThan(
    6_000 * SUMMARY_OVERRUN_TOLERANCE,
  )
  await expect(run(() => emit(runaway), hosted)).rejects.toThrow(
    'far longer than requested',
  )
  // Over the requested length AND above where an automatic pass must land.
  await expect(
    run(() => emit(longHandoff), { ...hosted, targetTokens: 22_000 }),
  ).rejects.toThrow('far longer than requested')
  // Within the requested length, the target does not apply (as before).
  expect(
    (await run(() => emit(handoff), { ...hosted, targetTokens: 22_000 }))
      ?.summary,
  ).toBe(handoff)

  const warnings: unknown[] = []
  const result = await compactWithModelOrFallback({
    ...hosted,
    system: 'You are a coding agent.',
    signal: new AbortController().signal,
    stream: () => emit(runaway),
    logger: { ...noopLogger, warn: (data: unknown) => warnings.push(data) },
  })
  // The mechanical pass has nothing to shrink in a history this far under
  // budget, so the history is left as it was.
  expect(result).toBeNull()
  expect(warnings).toMatchObject([{ error_kind: 'summary_too_long' }])
})

test('complete_compaction arguments with hand-written escaping are repaired, not rejected', () => {
  // A literal newline inside the string, `\'` (GLM), and an unescaped Windows
  // path: all invalid JSON, so the AI SDK hands the call over as raw text.
  const raw =
    '{"summary": "## Objective\n- Keep the user\\\'s retries.\n## Next Move\n- Config: C:\\Users\\dev\\config.json"}'
  expect(() => JSON.parse(raw)).toThrow()
  expect(parseCompactionSummary(raw)).toBe(
    "## Objective\n- Keep the user's retries.\n## Next Move\n- Config: C:\\Users\\dev\\config.json",
  )
  // Repair never invents structure: arguments cut off mid-string still fail.
  expect(
    parseCompactionSummary('{"summary": "## Objective\n- cut off'),
  ).toBeUndefined()
  // Valid escapes are untouched.
  expect(parseCompactionSummary(JSON.stringify({ summary: handoff }))).toBe(
    handoff,
  )
})

test('a handoff written as reply text instead of a tool call is recovered', async () => {
  const json = JSON.stringify({ summary: handoff })
  const replies = [
    // The Markdown itself (GLM 5.3 Flash, Space Bunny, MiMo, DeepSeek).
    handoff,
    '```markdown\n' + handoff + '\n```',
    '<think>The user wants a summary.</think>\n' + handoff,
    // The call spelled out as JSON: the way the summarized history serializes
    // tool calls, OpenAI's shape, and its arguments-as-a-string variant.
    `{"toolName":"complete_compaction","input":${json}}`,
    `{"name": "complete_compaction", "arguments": ${json}}`,
    `{"name": "complete_compaction", "arguments": ${JSON.stringify(json)}}`,
    `<tool>\n{"name": "complete_compaction", "arguments": ${json}}`,
    json,
    // Hand-escaped JSON as text (GLM's `\'`).
    json.replace("user's", "user\\'s"),
    // XML templates.
    `<complete_compaction>\n<summary>\n${handoff}\n</summary>\n</complete_compaction>`,
    `<complete_compaction>\n<parameter name="summary">${handoff}</parameter>\n</complete_compaction>`,
    `<function=complete_compaction><parameter=summary>${handoff}</parameter></function>`,
  ]
  for (const reply of replies) {
    const result = await run(replying(reply), hosted)
    expect(result?.summary).toBe(handoff)
    expect(result?.summarySource).toBe('text')
  }
})

test('reply text that is not the handoff is still refused', async () => {
  const before = structuredClone(bigMessages)
  for (const reply of [
    // An answer to the user's task.
    'I updated src/upload.ts to honor Retry-After. Want me to run the tests?',
    // One heading is not the handoff.
    '## Objective\nFix the uploader.',
    // A text-form call to a different tool.
    `{"toolName":"write_file","input":{"path":"NOTES.md","content":${JSON.stringify(handoff)}}}`,
    // Structured sections instead of the Markdown summary.
    '{"summary":{"objective":"Fix the uploader","next":"Read Retry-After"}}',
  ])
    await expect(run(replying(reply), hosted)).rejects.toThrow(
      'valid compaction summary',
    )
  // A reply cut off by the output cap is never installed, whatever it holds.
  await expect(run(replying(handoff, 'length'), hosted)).rejects.toThrow(
    'output token limit',
  )
  expect(bigMessages).toEqual(before)
})

test('an installed handoff reports its source, size and budget; a fallback does not', async () => {
  const infos: unknown[] = []
  const params = {
    ...hosted,
    system: 'You are a coding agent.',
    signal: new AbortController().signal,
    logger: { ...noopLogger, info: (data: unknown) => infos.push(data) },
    runId: 'run-1',
    model: 'deepseek/deepseek-v4-flash',
    trigger: 'cache_expiry',
  }
  await compactWithModelOrFallback({ ...params, stream: replying(handoff) })
  expect(infos).toMatchObject([
    {
      axiomEvent: 'model_compaction.completed',
      agent_run_id: 'run-1',
      model: 'deepseek/deepseek-v4-flash',
      trigger_reason: 'cache_expiry',
      summary_source: 'text',
      summary_tokens: countTokens(handoff),
      summary_budget: 6_000,
      sections: 1,
    },
  ])
  infos.length = 0
  await compactWithModelOrFallback({
    ...params,
    stream: replying('Sure, what next?'),
  })
  expect(
    infos.some(
      (i) =>
        (i as { axiomEvent?: string }).axiomEvent ===
        'model_compaction.completed',
    ),
  ).toBe(false)
})
