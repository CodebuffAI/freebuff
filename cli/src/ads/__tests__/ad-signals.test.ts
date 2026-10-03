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
