import { describe, expect, it } from 'bun:test'

import {
  compactMessages,
  DEFAULT_CACHE_EXPIRY_MIN_TOKENS,
  DEFAULT_CACHE_EXPIRY_MS,
  evaluateCompactionTrigger,
  maybeCompactHistory,
  promptCacheGapMs,
} from '../compact-history'

import { compactionPolicyForModel } from '@codebuff/common/constants/compaction-policy'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

const MINUTE = 60 * 1000

const user = (text: string, tags?: string[]): Message => ({
  role: 'user',
  content: [{ type: 'text', text }],
  ...(tags ? { tags } : {}),
  sentAt: 1,
})

const assistant = (text: string): Message => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  sentAt: 1,
})

const assistantToolCall = (
  toolName: string,
  input: Record<string, unknown>,
): Message => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: 'c1', toolName, input }],
  sentAt: 1,
})

const toolResult = (toolName: string, value: unknown): Message => ({
  role: 'tool',
  toolCallId: 'c1',
  toolName,
  content: [{ type: 'json', value: value as any }],
})

/** A user prompt that landed `gapMinutes` after the assistant's last message. */
const idleTurn = (gapMinutes: number): Message[] => [
  { ...assistant('previous turn answer'), sentAt: 1_000_000 },
  {
    ...user('the new question', ['USER_PROMPT']),
    sentAt: 1_000_000 + gapMinutes * MINUTE,
  },
]

const textOf = (message: Message): string =>
  Array.isArray(message.content)
    ? message.content
        .map((part) => ('text' in part ? part.text : ''))
        .join('\n')
    : String(message.content)

const compact = (messages: Message[]) => compactMessages({ messages }).messages

describe('compactMessages', () => {
  it('replaces history with a mechanical summary and keeps the live user prompt', () => {
    const result = compact([
      user('old question'),
      assistant('old answer'),
      user('the live question', ['USER_PROMPT']),
    ])

    expect(result).toHaveLength(2)
    expect(textOf(result[0])).toContain('<conversation_summary>')
    expect(textOf(result[0])).toContain('old question')
    expect(textOf(result[0])).toContain('old answer')
    expect(result[1].role).toBe('user')
    expect(textOf(result[1])).toContain('the live question')
  })

  it('keeps the concrete details of the work: files, edits, commands', () => {
    const summary = textOf(
      compact([
        user('fix the bug', ['USER_PROMPT']),
        assistantToolCall('read_files', {
          paths: [{ path: 'src/server.ts', offset: 0, limit: 200 }],
        }),
        assistantToolCall('str_replace', { path: 'src/server.ts' }),
        assistantToolCall('run_terminal_command', { command: 'bun test' }),
        toolResult('run_terminal_command', { exitCode: 1 }),
      ])[0],
    )

    expect(summary).toContain('inspected files: src/server.ts')
    expect(summary).toContain('edited file: src/server.ts')
    expect(summary).toContain('ran command: bun test')
    expect(summary).toContain('Command failed with exit code: 1')
  })

  it('appends a continuation prompt on a mid-turn prune', () => {
    const result = compact([
      user('the live question', ['USER_PROMPT']),
      assistant('working on it'),
    ])

    expect(result).toHaveLength(2)
    expect(textOf(result[1])).toContain('Continue the existing assistant turn')
    // Mid-turn, the live prompt moves into the memory instead of being dropped.
    expect(textOf(result[0])).toContain('the live question')
  })

  it('keeps the live prompt readable mid-turn even when it is enormous', () => {
    // The user budget is what protects the request the agent is working on. It
    // is the newest user entry, so the budget walk reaches it first, and the
    // per-message truncation caps it far below the budget.
    const huge = `IMPORTANT REQUEST ${'x'.repeat(500_000)} FINAL LINE`
    const summary = textOf(
      compact([
        user(huge, ['USER_PROMPT']),
        ...Array.from({ length: 50 }, (_, i) => assistant(`step ${i}`)),
      ])[0],
    )

    expect(summary).toContain('IMPORTANT REQUEST')
    expect(summary).toContain('FINAL LINE')
  })

  it('drops per-step scaffolding and re-appends the instructions prompt', () => {
    const result = compact([
      user('older work'),
      assistant('older answer'),
      user('THE INSTRUCTIONS', ['INSTRUCTIONS_PROMPT']),
      user('THE STEP SCAFFOLD', ['STEP_PROMPT']),
      user('the live question', ['USER_PROMPT']),
    ])

    expect(result).toHaveLength(3)
    expect(textOf(result[0])).not.toContain('THE INSTRUCTIONS')
    expect(textOf(result[0])).not.toContain('THE STEP SCAFFOLD')
    expect(result[1].tags).toContain('INSTRUCTIONS_PROMPT')
    expect(textOf(result[1])).toContain('THE INSTRUCTIONS')
    expect(textOf(result[2])).toContain('the live question')
  })

  it('folds a previous summary back in on a second compaction', () => {
    const first = compact([
      user('the original request', ['USER_PROMPT']),
      assistant('working on it'),
    ])
    const second = compact([...first, assistant('more work')])

    expect(second).toHaveLength(2)
    expect(textOf(second[0])).toContain('the original request')
    expect(textOf(second[0])).toContain('more work')
    // The old summary wrapper is not nested inside the new one.
    expect(textOf(second[0]).match(/<conversation_summary>/g)).toHaveLength(1)
    expect(textOf(second[1])).toContain('Continue the existing assistant turn')
  })

  it('does not mistake a user message that mentions the tag for a summary', () => {
    // A summary is dropped from the history and re-parsed into entries, so a
    // false positive silently eats the user's message. Asking about this very
    // module is an easy way to send the bare tag.
    const asking = user(
      'why does the code emit <conversation_summary> around the memory?',
    )
    const result = compact([
      asking,
      assistant('because the model needs a delimiter'),
      user('got it, now fix the bug', ['USER_PROMPT']),
    ])

    expect(textOf(result[0])).toContain('why does the code emit')
  })

  it('still recognizes a real summary it produced itself', () => {
    const first = compact([
      user('the original request', ['USER_PROMPT']),
      assistant('working on it'),
    ])
    // The genuine artifact carries the header, so it is folded in rather than
    // re-summarized as if it were ordinary user text.
    const second = compactMessages({
      messages: [...first, assistant('more work')],
    })

    expect(second.stats.previous_summary_entry_count).toBeGreaterThan(0)
    expect(
      textOf(second.messages[0]).match(/<conversation_summary>/g),
    ).toHaveLength(1)
  })

  it('does not let a user message quoting the markers steal the summary identity', () => {
    // The 2026-08-31 wipe: a user message containing BOTH the tag and the
    // header (asking about this very mechanism, pasting a summary back)
    // matched isConversationSummary, so findLast picked the quote over the
    // real summary. The real summary was then neither re-parsed nor kept as
    // history — every earlier turn vanished from the model's context.
    const first = compact([
      user('the original request about auth', ['USER_PROMPT']),
      assistant('refactored the auth module'),
    ])
    const quote = user(
      'what is <conversation_summary>? e.g. "This is a summary of the conversation so far. The original messages have been condensed to save context space." — explain it',
      ['USER_PROMPT'],
    )
    const second = compactMessages({
      messages: [...first, assistant('more work'), quote],
    })

    // The real memory survives the second compaction.
    expect(second.stats.previous_summary_entry_count).toBeGreaterThan(0)
    expect(textOf(second.messages[0])).toContain('the original request about auth')
    // The quote is the live prompt, preserved as a real message — not eaten.
    // (It comes back re-stamped with a fresh sentAt, so compare content.)
    expect(textOf(second.messages.at(-1)!)).toContain('what is <conversation_summary>')
  })

  it('still recognizes a legacy summary by its full envelope', () => {
    // Summaries written before the CONVERSATION_SUMMARY tag existed carry no
    // tag, so identity falls back to the full envelope — open tag, header,
    // close tag AND <historical_memory>. A bare tag-plus-header quote must
    // not qualify.
    const legacySummary = user(
      '<conversation_summary>\nThis is a summary of the conversation so far. The original messages have been condensed to save context space.\n\n<historical_memory>\n[USER]\nthe legacy request\n</historical_memory>\n</conversation_summary>',
    )
    const result = compactMessages({
      messages: [legacySummary, assistant('and then some work')],
    })

    expect(result.stats.previous_summary_entry_count).toBeGreaterThan(0)
    expect(textOf(result.messages[0])).toContain('the legacy request')
  })

  it('does not fold in a quote that has the tag and header but no memory block', () => {
    // A tag-plus-header quote reproduces the pre-tag identity check. It lacks
    // <historical_memory>, so the legacy fallback must reject it — the memory
    // it would have "been" belongs to the real, newer summary.
    const first = compact([
      user('the original request', ['USER_PROMPT']),
      assistant('working on it'),
    ])
    const quote = user(
      '<conversation_summary>\nThis is a summary of the conversation so far. The original messages have been condensed to save context space.',
    )
    const result = compactMessages({
      messages: [...first, quote],
    })

    expect(result.stats.previous_summary_entry_count).toBeGreaterThan(0)
    expect(textOf(result.messages[0])).toContain('the original request')
  })

  it('spends the two budgets independently: a flood of tool work keeps user prompts', () => {
    const { messages, stats } = compactMessages({
      messages: [
        user('the first request I made'),
        ...Array.from({ length: 200 }, (_, i) =>
          assistant(`step ${i}: ${'x'.repeat(500)}`),
        ),
        user('the live question', ['USER_PROMPT']),
      ],
      assistantToolBudget: 1_000,
      userBudget: 50_000,
    })

    expect(textOf(messages[0])).toContain('the first request I made')
    expect(stats.dropped_assistant_tool_entry_count).toBeGreaterThan(0)
    expect(stats.dropped_user_entry_count).toBe(0)
  })

  it('always keeps the newest entry even when it alone blows its budget', () => {
    const { messages, stats } = compactMessages({
      messages: [
        user('old', ['USER_PROMPT']),
        assistant(`HUGE ${'y'.repeat(50_000)}`),
      ],
      assistantToolBudget: 10,
      userBudget: 10,
    })

    expect(stats.newest_entry_forced).toBe(true)
    expect(textOf(messages[0])).toContain('HUGE')
  })

  it('carries the most recent images forward as real image parts', () => {
    const withImage: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image', image: 'data:image/png;base64,AAAA' },
      ],
      sentAt: 1,
    }
    const result = compact([
      withImage,
      assistant('I see it'),
      user('now?', ['USER_PROMPT']),
    ])

    const imageParts = (result[0].content as any[]).filter(
      (part) => part.type === 'image',
    )
    expect(imageParts).toHaveLength(1)
    expect(textOf(result[0])).toContain('[image(s) were attached]')
  })

  it('produces a summary well under the budget it was called for', () => {
    const { summaryText } = compactMessages({
      messages: [
        user('do the thing', ['USER_PROMPT']),
        ...Array.from({ length: 400 }, (_, i) =>
          i % 2 === 0
            ? assistant(`assistant turn ${i} ${'z'.repeat(2_000)}`)
            : toolResult('read_files', { content: 'z'.repeat(20_000) }),
        ),
      ],
    })

    // Default budgets are 20k assistant/tool + 50k user estimated tokens.
    expect(Math.ceil(summaryText.length / 3)).toBeLessThan(75_000)
  })
})

describe('promptCacheGapMs', () => {
  it('measures from the last assistant message to the live prompt', () => {
    expect(promptCacheGapMs(idleTurn(42))).toBe(42 * MINUTE)
  })

  it('skips tool messages, which carry no timestamp', () => {
    const [prevAssistant, prompt] = idleTurn(10)
    expect(
      promptCacheGapMs([
        prevAssistant,
        { role: 'tool', toolCallId: 'c1', toolName: 'read_files', content: [] },
        prompt,
      ]),
    ).toBe(10 * MINUTE)
  })

  it('is null when there is nothing to measure between', () => {
    expect(promptCacheGapMs([])).toBeNull()
    expect(
      promptCacheGapMs([user('only a prompt', ['USER_PROMPT'])]),
    ).toBeNull()
    expect(
      promptCacheGapMs([user('untagged'), user('prompt', ['USER_PROMPT'])]),
    ).toBeNull()
    expect(
      promptCacheGapMs([
        { ...assistant('no timestamp'), sentAt: undefined },
        user('prompt', ['USER_PROMPT']),
      ]),
    ).toBeNull()
  })
})

describe('evaluateCompactionTrigger', () => {
  /** Over the size floor, still well under the context limit. */
  const WORTH_COMPACTING = DEFAULT_CACHE_EXPIRY_MIN_TOKENS + 1

  const triggerFor = (
    messages: Message[],
    contextTokenCount: number,
    cacheExpiryMs?: number | null,
  ) =>
    evaluateCompactionTrigger({
      messages,
      contextTokenCount,
      maxContextLength: 400_000,
      cacheExpiryMs,
    }).trigger

  it('does nothing while the context fits and the cache is warm', () => {
    expect(triggerFor(idleTurn(5), WORTH_COMPACTING)).toBeNull()
  })

  it('fires on the context limit even with a warm cache', () => {
    expect(triggerFor(idleTurn(5), 500_000)).toBe('context_limit')
  })

  it('fires on a cold cache even when the context still fits', () => {
    const result = evaluateCompactionTrigger({
      messages: idleTurn(90),
      contextTokenCount: WORTH_COMPACTING,
      maxContextLength: 400_000,
    })
    expect(result.trigger).toBe('cache_expiry')
    expect(result.cacheGapMs).toBe(90 * MINUTE)
    expect(result.cacheExpiryMs).toBe(DEFAULT_CACHE_EXPIRY_MS)
    expect(result.cacheExpiryMinTokens).toBe(DEFAULT_CACHE_EXPIRY_MIN_TOKENS)
  })

  it('leaves a small conversation alone however cold the cache is', () => {
    // Compaction always costs detail; below the floor there is too little to
    // reclaim to be worth it, and the budget walk would evict nothing anyway.
    const result = evaluateCompactionTrigger({
      messages: idleTurn(600),
      contextTokenCount: DEFAULT_CACHE_EXPIRY_MIN_TOKENS - 1,
      maxContextLength: 400_000,
    })
    expect(result.trigger).toBeNull()
    // No point measuring a gap that cannot fire.
    expect(result.cacheGapMs).toBeNull()

    // One token more and it is worth doing.
    expect(triggerFor(idleTurn(600), DEFAULT_CACHE_EXPIRY_MIN_TOKENS)).toBe(
      'cache_expiry',
    )
  })

  it('honours a custom floor, and null removes it', () => {
    const tiny = 1_000
    expect(triggerFor(idleTurn(90), tiny)).toBeNull()
    expect(
      evaluateCompactionTrigger({
        messages: idleTurn(90),
        contextTokenCount: tiny,
        maxContextLength: 400_000,
        cacheExpiryMinTokens: 500,
      }).trigger,
    ).toBe('cache_expiry')
    expect(
      evaluateCompactionTrigger({
        messages: idleTurn(90),
        contextTokenCount: tiny,
        maxContextLength: 400_000,
        cacheExpiryMinTokens: null,
      }).trigger,
    ).toBe('cache_expiry')
  })

  it('the floor never blocks the context-limit trigger', () => {
    // A context over the limit must be compacted whatever the floor says.
    expect(
      evaluateCompactionTrigger({
        messages: idleTurn(45),
        contextTokenCount: 500_000,
        maxContextLength: 400_000,
        cacheExpiryMinTokens: 10_000_000,
      }).trigger,
    ).toBe('context_limit')
  })

  it('reports both when both are true', () => {
    expect(triggerFor(idleTurn(90), 500_000)).toBe(
      'context_limit_and_cache_expiry',
    )
  })

  it('honours a custom TTL in both directions', () => {
    expect(triggerFor(idleTurn(10), WORTH_COMPACTING)).toBeNull()
    expect(triggerFor(idleTurn(10), WORTH_COMPACTING, 5 * MINUTE)).toBe(
      'cache_expiry',
    )
    expect(triggerFor(idleTurn(45), WORTH_COMPACTING, 60 * MINUTE)).toBeNull()
  })

  it('a null TTL disables the opportunistic trigger entirely', () => {
    const result = evaluateCompactionTrigger({
      messages: idleTurn(600),
      contextTokenCount: WORTH_COMPACTING,
      maxContextLength: 400_000,
      cacheExpiryMs: null,
    })
    expect(result.trigger).toBeNull()
    expect(result.cacheGapMs).toBeNull()
    // The context limit still fires.
    expect(triggerFor(idleTurn(600), 500_000, null)).toBe('context_limit')
  })

  it('does not re-fire on the steps that follow a cache-expiry compaction', () => {
    const history = idleTurn(90)
    expect(triggerFor(history, WORTH_COMPACTING)).toBe('cache_expiry')

    // Compaction restamps every surviving message and drops the assistant
    // messages that preceded the live prompt, so the gap is gone.
    const compacted = compact(history)
    expect(triggerFor(compacted, WORTH_COMPACTING)).toBeNull()

    // ...and stays gone as the turn accumulates more work.
    expect(
      triggerFor(
        [...compacted, assistant('one'), assistant('two')],
        WORTH_COMPACTING,
      ),
    ).toBeNull()
  })

  it('fires again on the next turn if the user idles again', () => {
    const nextTurn: Message[] = [
      ...compact(idleTurn(90)),
      { ...assistant('done'), sentAt: 2_000_000 },
      {
        ...user('another question', ['USER_PROMPT']),
        sentAt: 2_000_000 + 90 * MINUTE,
      },
    ]
    expect(triggerFor(nextTurn, WORTH_COMPACTING)).toBe('cache_expiry')
  })
})

describe('maybeCompactHistory', () => {
  const overBudget = {
    contextTokenCount: 500_000,
    maxContextLength: 400_000,
  }

  it('returns null when no trigger fires', () => {
    expect(
      maybeCompactHistory({
        messages: idleTurn(5),
        contextTokenCount: DEFAULT_CACHE_EXPIRY_MIN_TOKENS,
        maxContextLength: 400_000,
      }),
    ).toBeNull()
  })

  it('compacts when a trigger fires', () => {
    const result = maybeCompactHistory({
      messages: [user('question', ['USER_PROMPT']), assistant('answer')],
      ...overBudget,
    })
    expect(result).not.toBeNull()
    expect(textOf(result![0])).toContain('<conversation_summary>')
  })

  it('logs the trigger, the cache gap and the pruner-compatible stats', () => {
    const logs: Array<Record<string, any>> = []
    const logger = {
      debug: () => {},
      info: (data: Record<string, any>) => logs.push(data),
      warn: () => {},
      error: () => {},
    } as any

    maybeCompactHistory({
      messages: idleTurn(90),
      contextTokenCount: DEFAULT_CACHE_EXPIRY_MIN_TOKENS,
      maxContextLength: 400_000,
      logger,
      runId: 'run-1',
    })

    expect(logs).toHaveLength(1)
    const [event] = logs
    expect(event.axiomEvent).toBe('context_compaction_completed')
    expect(event.agent_run_id).toBe('run-1')
    expect(event.trigger_reason).toBe('cache_expiry')
    expect(event.cache_gap_ms).toBe(90 * MINUTE)
    expect(event.cache_expiry_ms).toBe(DEFAULT_CACHE_EXPIRY_MS)
    // Field names the context-pruner already emits, so the two can be queried
    // as one series. Every key must be snake_case.
    for (const key of [
      'mid_turn',
      'user_budget',
      'assistant_tool_budget',
      'previous_summary_entry_count',
      'user_entry_count',
      'dropped_user_entry_count',
      'assistant_tool_entry_count',
      'dropped_assistant_tool_entry_count',
      'newest_entry_forced',
      'live_user_prompt_found',
      'summary_estimated_tokens',
      'cache_expiry_min_tokens',
    ]) {
      expect(event).toHaveProperty(key)
    }
    expect(Object.keys(event).filter((k) => /[A-Z]/.test(k))).toEqual([
      'axiomEvent',
    ])
  })

  it('omits the cache fields when the trigger is disabled', () => {
    const logs: Array<Record<string, any>> = []
    const logger = {
      debug: () => {},
      info: (data: Record<string, any>) => logs.push(data),
      warn: () => {},
      error: () => {},
    } as any

    maybeCompactHistory({
      messages: idleTurn(600),
      ...overBudget,
      cacheExpiryMs: null,
      logger,
    })

    expect(logs[0].trigger_reason).toBe('context_limit')
    expect(logs[0]).not.toHaveProperty('cache_gap_ms')
    expect(logs[0]).not.toHaveProperty('cache_expiry_ms')
  })

  it('never throws when the logger does', () => {
    const brokenLogger = {
      debug: () => {},
      info: () => {
        throw new Error('logger unavailable')
      },
      warn: () => {},
      error: () => {},
    } as any

    expect(() =>
      maybeCompactHistory({
        messages: [user('question', ['USER_PROMPT']), assistant('answer')],
        ...overBudget,
        logger: brokenLogger,
      }),
    ).not.toThrow()
  })
})

describe('per-model compaction policies at the runtime entry point', () => {
  const resumedHistory = (gapMinutes: number): Message[] => [
    { ...assistant('done for now'), sentAt: 1_000_000 },
    {
      ...user('back after a break', ['USER_PROMPT']),
      sentAt: 1_000_000 + gapMinutes * MINUTE,
    },
  ]
  const compacts = (model: string, gapMinutes: number, tokens: number) =>
    maybeCompactHistory({
      ...compactionPolicyForModel(model),
      messages: resumedHistory(gapMinutes),
      contextTokenCount: tokens,
      maxContextLength: 400_000,
    }) !== null

  it('the runtime default floor is two summary ceilings (20k + 50k, doubled)', () => {
    expect(DEFAULT_CACHE_EXPIRY_MIN_TOKENS).toBe(2 * (20_000 + 50_000))
    expect(DEFAULT_CACHE_EXPIRY_MS).toBe(60 * MINUTE)
  })

  it('DeepSeek Flash compacts a 60k thread after 16 minutes, not 14, and never under 40k', () => {
    const flash = 'deepseek/deepseek-v4-flash'
    expect(compacts(flash, 16, 60_000)).toBe(true)
    expect(compacts(flash, 14, 60_000)).toBe(false)
    expect(compacts(flash, 30, 39_999)).toBe(false)
  })

  it('every other model stays on the hour / 140k', () => {
    const pro = 'deepseek/deepseek-v4-pro'
    expect(compacts(pro, 61, 60_000)).toBe(false)
    expect(compacts(pro, 61, 200_000)).toBe(true)
  })
})
