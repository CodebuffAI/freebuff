import { promptSuccess } from '@codebuff/common/util/error'
import { assistantMessage, userMessage } from '@codebuff/common/util/messages'
import { beforeEach, describe, expect, it } from 'bun:test'

import {
  applyConversationSummary,
  conversationSummaries,
  generateConversationSummary,
  isIdleReturn,
  messageFingerprint,
  resetConversationSummariesForTest,
  summaryIsDue,
  summaryReasoningOptions,
  summaryRequestHistory,
  summaryThresholds,
} from '../conversation-summary'

import type { SummaryStream } from '../conversation-summary'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { ConversationSummary } from '@codebuff/common/types/session-state'

const MINUTE = 60_000
const TEXT = `## Objective\n- ${'keep going '.repeat(30)}`

const prompt = (text: string, sentAt: number): Message => ({
  ...userMessage(text),
  tags: ['USER_PROMPT'],
  sentAt,
})

const streamOf =
  (chunks: unknown[], finishReason = 'stop'): SummaryStream =>
  (request) =>
    (async function* () {
      for (const chunk of chunks) yield chunk as any
      request.onFinishReason(finishReason)
      return promptSuccess('id')
    })()

const generate = (history: Message[], stream: SummaryStream) =>
  generateConversationSummary({
    history,
    system: 'system',
    contextTokens: 50_000,
    targetTokens: 6_000,
    stream,
    signal: new AbortController().signal,
  })

describe('summaryThresholds', () => {
  it('uses 40k and 30k for large windows, shares for small ones', () => {
    expect(summaryThresholds(200_000)).toEqual({
      first: 40_000,
      growth: 30_000,
    })
    expect(summaryThresholds(32_000)).toEqual({ first: 6_400, growth: 4_800 })
  })

  it('makes the first summary at the floor and the next after growth', () => {
    const due = (contextTokens: number, latestContextTokens?: number) =>
      summaryIsDue({
        contextTokens,
        maxContextLength: 200_000,
        latestContextTokens,
      })
    expect(due(39_999)).toBe(false)
    expect(due(40_000)).toBe(true)
    expect(due(69_999, 40_000)).toBe(false)
    expect(due(70_000, 40_000)).toBe(true)
  })
})

describe('summaryReasoningOptions', () => {
  it('asks a high-effort model to think less for a summary', () => {
    expect(
      summaryReasoningOptions('deepseek/deepseek-v4-flash', {
        effort: 'high',
        exclude: false,
      }),
    ).toEqual({ effort: 'low', exclude: false })
  })

  it('keeps Anthropic thinking, whose change would drop the cached messages', () => {
    const reasoning = { effort: 'high' as const }
    expect(
      summaryReasoningOptions('anthropic/claude-opus-4.8', reasoning),
    ).toBe(reasoning)
  })

  it('leaves no effort, or one already low, as it is', () => {
    expect(summaryReasoningOptions('openai/gpt-6', undefined)).toBeUndefined()
    const none = { effort: 'none' as const }
    expect(summaryReasoningOptions('openai/gpt-6', none)).toBe(none)
  })
})

describe('isIdleReturn', () => {
  const history = (gap: number): Message[] => [
    prompt('first', 0),
    { ...assistantMessage('answer'), sentAt: 1_000 },
    prompt('next', 1_000 + gap),
  ]

  it('is true only past five minutes', () => {
    expect(isIdleReturn(history(5 * MINUTE))).toBe(false)
    expect(isIdleReturn(history(5 * MINUTE + 1))).toBe(true)
  })

  it('is false once the assistant answered the prompt', () => {
    expect(
      isIdleReturn([...history(60 * MINUTE), assistantMessage('working')]),
    ).toBe(false)
  })
})

describe('applyConversationSummary', () => {
  const history: Message[] = [
    prompt('first', 0),
    { ...assistantMessage('answer'), sentAt: 1 },
    prompt('next', 2),
  ]
  const summary: ConversationSummary = {
    text: TEXT,
    coveredMessages: 2,
    anchor: messageFingerprint(history[1]),
    contextTokens: 1,
    createdAt: 1,
  }

  it('keeps the messages after the summary', () => {
    const applied = applyConversationSummary({
      messages: history,
      summary,
    })!
    expect(applied.messages).toHaveLength(2)
    expect(JSON.stringify(applied.messages[0])).toContain('keep going')
    expect(applied.messages[1]).toBe(history[2])
    // Re-anchored on itself; sized only by the next provider response.
    expect(applied.summary.coveredMessages).toBe(1)
    expect(applied.summary.contextTokens).toBeUndefined()
  })

  it('keeps the covered messages `keep` names, right after the summary', () => {
    const live = history[2]
    const applied = applyConversationSummary({
      messages: history,
      summary: {
        ...summary,
        anchor: messageFingerprint(live),
        coveredMessages: 3,
      },
      keep: (m) => m === live,
    })!
    expect(applied.messages).toHaveLength(2)
    expect(applied.messages[1]).toBe(live)
  })

  it('finds the anchor when earlier scaffolding was dropped', () => {
    const applied = applyConversationSummary({
      messages: history.slice(1),
      summary,
    })!
    expect(applied.messages.at(-1)).toBe(history[2])
  })

  it('is null when an edit removed the last covered message', () => {
    expect(
      applyConversationSummary({
        messages: [history[0], prompt('edited', 3)],
        summary,
      }),
    ).toBeNull()
  })
})

describe('generateConversationSummary', () => {
  const history: Message[] = [
    prompt('first', 0),
    { ...assistantMessage('answer'), sentAt: 1 },
    { ...userMessage('step scaffolding'), tags: ['STEP_PROMPT'] },
  ]

  it('anchors on the last real message and strips thinking', async () => {
    const { summary } = await generate(
      history,
      streamOf([
        { type: 'text', text: '<think>planning</think>' },
        { type: 'text', text: TEXT },
      ]),
    )
    expect(summary.text).toBe(TEXT.trim())
    expect(summary.coveredMessages).toBe(2)
    expect(summary.anchor).toBe(messageFingerprint(history[1]))
  })

  it('appends the instruction after the same history', async () => {
    let sent: Message[] = []
    let metadata: Record<string, string> = {}
    const { summary } = await generate(history, (request) => {
      sent = request.messages
      metadata = request.extraCodebuffMetadata
      return streamOf([{ type: 'text', text: TEXT }])(request)
    })
    expect(sent.slice(1, -1)).toEqual(history)
    expect(JSON.stringify(sent.at(-1))).toContain('structured summary')
    expect(metadata).toEqual({
      compaction_summary: '1',
      compaction_summary_id: summary.id!,
      compaction_request_id: summary.id!,
      compaction_request_group: 'summary',
    })
    expect(summary.id).toBeTruthy()
  })

  it('drops a preamble before the first heading', async () => {
    const { summary } = await generate(
      history,
      streamOf([
        { type: 'text', text: `Sure, here is the summary.\n\n${TEXT}` },
      ]),
    )
    expect(summary.text).toBe(TEXT.trim())
  })

  it('keeps a summary whose headings the model translated', async () => {
    const translated = [
      'Tujuan',
      'Persyaratan',
      'Keputusan',
      'Status Pekerjaan',
      'Langkah Selanjutnya',
      'File yang Relevan',
      'Konteks Penting',
      'Pertukaran Terakhir',
    ]
      .map((heading) => `## ${heading}\n- ${'lanjutkan '.repeat(10)}\n`)
      .join('\n')
    const { summary } = await generate(
      history,
      streamOf([{ type: 'text', text: `Berikut ringkasannya.\n\n${translated}` }]),
    )
    expect(summary.text).toBe(translated.trim())
  })

  it('rejects a long reply with a few headings of its own', async () => {
    const reply = ['Plan', 'Steps', 'Risks']
      .map((heading) => `## ${heading}\n${'next I will edit it. '.repeat(10)}\n`)
      .join('\n')
    await expect(
      generate(history, streamOf([{ type: 'text', text: reply }])),
    ).rejects.toMatchObject({ kind: 'unrecognized' })
  })

  it('rejects a reply without the summary format', async () => {
    await expect(
      generate(
        history,
        streamOf([{ type: 'text', text: 'done. '.repeat(100) }]),
      ),
    ).rejects.toThrow('no summary')
  })

  it('rejects a summary cut off by the output limit', async () => {
    await expect(
      generate(history, streamOf([{ type: 'text', text: TEXT }], 'length')),
    ).rejects.toThrow('output limit')
  })

  it('rejects a reply with no summary', async () => {
    await expect(
      generate(
        history,
        streamOf([{ type: 'tool-call', toolName: 'read_files', input: {} }]),
      ),
    ).rejects.toMatchObject({ kind: 'empty' })
  })

  it('rejects a provider error', async () => {
    await expect(
      generate(history, streamOf([{ type: 'error', message: 'down' }])),
    ).rejects.toThrow('down')
  })
})

describe('summaryRequestHistory', () => {
  it('drops what the next request would not send', () => {
    const step = {
      ...userMessage('step'),
      timeToLive: 'agentStep' as const,
    }
    const history = [prompt('first', 0), step]
    expect(summaryRequestHistory(history)).toEqual([history[0]])
  })
})

describe('conversationSummaries', () => {
  beforeEach(() => resetConversationSummariesForTest())

  const history: Message[] = [prompt('first', 0)]
  const summary = (createdAt: number): ConversationSummary => ({
    text: TEXT,
    coveredMessages: 1,
    anchor: messageFingerprint(history[0]),
    contextTokens: 40_000,
    createdAt,
  })

  it('runs one summary at a time and keeps the newest', async () => {
    const store = conversationSummaries('thread')
    let release: (value: ConversationSummary) => void = () => {}
    const first = store.start(
      40_000,
      () => new Promise((resolve) => (release = resolve)),
    )
    const second = store.start(60_000, async () => summary(9))
    expect(second).toBe(first)
    expect(store.pending()?.contextTokens).toBe(40_000)
    release(summary(2))
    await first
    expect(store.pending()).toBeUndefined()
    expect(store.latest(summary(1), history)?.createdAt).toBe(2)
    expect(store.latest(summary(3), history)?.createdAt).toBe(3)
  })

  it('forgets a failed summary', async () => {
    const store = conversationSummaries('thread')
    await store.start(40_000, async () => {
      throw new Error('down')
    })
    expect(store.pending()).toBeUndefined()
    expect(store.latest(undefined, history)).toBeUndefined()
  })

  it('keeps conversations apart', async () => {
    await conversationSummaries('a').start(1, async () => summary(1))
    expect(
      conversationSummaries('b').latest(undefined, history),
    ).toBeUndefined()
  })
})
