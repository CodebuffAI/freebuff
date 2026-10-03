import { afterEach, describe, expect, test } from 'bun:test'

import {
  AD_RTT_WINDOW,
  getAdSessionSnapshot,
  getAdTerminalFocus,
  getAdTerminalFocusState,
  getAdTranscriptViewport,
  getAdTurnStartedAt,
  noteAdClicked,
  noteAdTerminalFocus,
  noteAdTurnState,
  noteAdUserSend,
  noteAdsServed,
  noteApiRtt,
  registerAdTranscriptViewport,
  resetAdSignalsForTests,
  subscribeAdUserSend,
  timedApiCall,
  AD_TURN_FAILURE_WINDOW_MS,
  failedToolOutputText,
  getAdTypingSummary,
  getAdWorkSnapshot,
  noteAdKeystroke,
  noteAdQueuedCount,
  noteAdStreamChunk,
  noteAdToolCall,
  noteAdToolResult,
  noteAdTurnFailure,
  subscribeAdAgentCommand,
  subscribeAdKeystroke,
  timedAdFetch,
} from '../ad-signals'

afterEach(() => resetAdSignalsForTests())

describe('ad signals', () => {
  test('terminal focus is unknown until the terminal reports it', () => {
    expect(getAdTerminalFocus()).toBeUndefined()
    expect(getAdTerminalFocusState()).toEqual({
      supported: false,
      focused: null,
    })
    noteAdTerminalFocus(false)
    expect(getAdTerminalFocus()).toBe(false)
    expect(getAdTerminalFocusState()).toEqual({
      supported: true,
      focused: false,
    })
  })

  test('only an observed start stamps the turn', () => {
    noteAdTurnState(true, true, 100)
    expect(getAdTurnStartedAt()).toBeNull()
    noteAdTurnState(true, false, 200)
    expect(getAdTurnStartedAt()).toBe(200)
    noteAdTurnState(false, true, 300)
    expect(getAdTurnStartedAt()).toBeNull()
  })

  test('session counters and the bounded RTT window', () => {
    noteAdsServed(4, 1_000)
    noteAdsServed(0, 2_000)
    noteAdClicked(3_000)
    noteAdUserSend(4_000)
    for (let i = 0; i < AD_RTT_WINDOW + 5; i++) noteApiRtt(i)
    noteApiRtt(Number.NaN)
    const snapshot = getAdSessionSnapshot()
    expect(snapshot).toMatchObject({
      adsServed: 4,
      lastAdAt: 1_000,
      lastClickAt: 3_000,
      lastSendAt: 4_000,
    })
    expect(snapshot.rttSamplesMs).toHaveLength(AD_RTT_WINDOW)
    expect(snapshot.rttSamplesMs[0]).toBe(5)
  })

  test('send listeners hear every send and a throwing one is contained', () => {
    const heard: number[] = []
    subscribeAdUserSend(() => {
      throw new Error('listener')
    })
    subscribeAdUserSend((at) => heard.push(at))
    noteAdUserSend(42)
    expect(heard).toEqual([42])
  })

  test('timedApiCall records a successful round trip and passes failures through', async () => {
    let t = 0
    const now = () => t
    await timedApiCall(async () => {
      t += 75
      return 'ok'
    }, now)
    await expect(
      timedApiCall(async () => {
        throw new Error('offline')
      }, now),
    ).rejects.toThrow('offline')
    expect(getAdSessionSnapshot().rttSamplesMs).toEqual([75])
  })

  test('the transcript viewport is null when unregistered, broken or empty', () => {
    expect(getAdTranscriptViewport()).toBeNull()
    const unregister = registerAdTranscriptViewport(() => ({
      top: 3,
      bottom: 30,
    }))
    expect(getAdTranscriptViewport()).toEqual({ top: 3, bottom: 30 })
    unregister()
    expect(getAdTranscriptViewport()).toBeNull()
    registerAdTranscriptViewport(() => {
      throw new Error('gone')
    })
    expect(getAdTranscriptViewport()).toBeNull()
    registerAdTranscriptViewport(() => ({ top: 3, bottom: 3 }))
    expect(getAdTranscriptViewport()).toBeNull()
  })
})

describe('ad signals: wave 2', () => {
  test('TTFT is the first chunk after an observed turn start, once', () => {
    noteAdStreamChunk(500)
    expect(getAdSessionSnapshot().lastTtftMs).toBeNull()
    noteAdTurnState(true, false, 1_000)
    noteAdStreamChunk(3_500)
    noteAdStreamChunk(9_000)
    expect(getAdSessionSnapshot().lastTtftMs).toBe(2_500)
    // a turn that ends without streaming keeps the last known value
    noteAdTurnState(false, true, 10_000)
    noteAdTurnState(true, false, 11_000)
    noteAdTurnState(false, true, 12_000)
    noteAdStreamChunk(13_000)
    expect(getAdSessionSnapshot().lastTtftMs).toBe(2_500)
  })

  test('timedApiCall counts throws and non-ok responses as failed requests', async () => {
    await timedApiCall(async () => ({ ok: true }))
    await timedApiCall(async () => ({ ok: false, status: 503 }))
    await expect(
      timedApiCall(async () => {
        throw new Error('offline')
      }),
    ).rejects.toThrow('offline')
    expect(getAdSessionSnapshot().failedRequests).toBe(2)
  })

  test('timedAdFetch records the previous ad request duration', async () => {
    let t = 0
    const now = () => t
    expect(getAdSessionSnapshot().lastAdFetchMs).toBeNull()
    await timedAdFetch(async () => {
      t += 640
      return { ok: true }
    }, now)
    expect(getAdSessionSnapshot().lastAdFetchMs).toBe(640)
    await timedAdFetch(async () => {
      t += 90
      return { ok: false }
    }, now)
    expect(getAdSessionSnapshot()).toMatchObject({
      lastAdFetchMs: 90,
      failedRequests: 1,
    })
    await expect(
      timedAdFetch(async () => {
        throw new Error('dns')
      }, now),
    ).rejects.toThrow('dns')
    expect(getAdSessionSnapshot()).toMatchObject({
      lastAdFetchMs: 90,
      failedRequests: 2,
    })
  })

  test('typing is unknown until a keystroke, then only buckets', () => {
    expect(getAdTypingSummary()).toBeNull()
    let heard = 0
    subscribeAdKeystroke(() => heard++)
    for (let i = 0; i < 30; i++) noteAdKeystroke(i % 10 === 0)
    const summary = getAdTypingSummary()!
    expect(heard).toBe(30)
    expect(Object.keys(summary).sort()).toEqual(
      expect.arrayContaining(['editRatio', 'typingSpeed']),
    )
    expect(summary.editRatio).toBe('5-15%')
    expect(summary.typingSpeed).not.toBe('none')
  })

  test('tool calls keep a category; commands reach listeners only', () => {
    const commands: string[] = []
    subscribeAdAgentCommand((c) => commands.push(c))
    expect(getAdWorkSnapshot().tool).toBeNull()
    noteAdToolCall('run_terminal_command', 'npm i stripe')
    expect(getAdWorkSnapshot().tool).toBe('shell')
    noteAdToolCall('read_files')
    expect(getAdWorkSnapshot().tool).toBe('read')
    expect(commands).toEqual(['npm i stripe'])
    expect(JSON.stringify(getAdWorkSnapshot())).not.toContain('stripe')
  })

  test('failed tool results keep only their error class', () => {
    expect(failedToolOutputText([{ type: 'json', value: { exitCode: 0 } }])).toBe(
      undefined,
    )
    expect(
      failedToolOutputText([
        { type: 'json', value: { exitCode: 1, stderr: 'Error: Cannot find module "left-pad"' } },
      ]),
    ).toContain('Cannot find module')
    expect(
      failedToolOutputText([{ type: 'json', value: { errorMessage: 'EACCES: /etc/x' } }]),
    ).toBe('EACCES: /etc/x')
    expect(failedToolOutputText('nope')).toBeUndefined()

    expect(getAdWorkSnapshot().lastError).toBe('none')
    noteAdToolResult([
      { type: 'json', value: { exitCode: 1, stderr: 'Error: Cannot find module "left-pad"' } },
    ])
    expect(getAdWorkSnapshot().lastError).toBe('module-not-found')
    // a successful result does not clear it
    noteAdToolResult([{ type: 'json', value: { exitCode: 0, stdout: 'ok' } }])
    expect(getAdWorkSnapshot().lastError).toBe('module-not-found')
    expect(JSON.stringify(getAdWorkSnapshot())).not.toContain('left-pad')
  })

  test('turn failures: class of the message, counted over the trailing hour', () => {
    noteAdTurnFailure('429 Too Many Requests from upstream', 0)
    expect(getAdWorkSnapshot(1).lastError).toBe('rate-limited')
    noteAdTurnFailure(undefined, 1_000)
    expect(getAdWorkSnapshot(2_000)).toMatchObject({
      lastError: 'other',
      turnFailuresLastHour: 2,
    })
    expect(
      getAdWorkSnapshot(AD_TURN_FAILURE_WINDOW_MS + 500).turnFailuresLastHour,
    ).toBe(1)
    for (let i = 0; i < 100; i++) noteAdTurnFailure('boom', 5_000)
    expect(getAdWorkSnapshot(6_000).turnFailuresLastHour).toBe(32)
  })

  test('queue length', () => {
    expect(getAdWorkSnapshot().queued).toBeNull()
    noteAdQueuedCount(3)
    expect(getAdWorkSnapshot().queued).toBe(3)
    noteAdQueuedCount(Number.NaN)
    expect(getAdWorkSnapshot().queued).toBe(3)
  })
})
