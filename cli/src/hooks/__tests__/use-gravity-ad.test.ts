import { describe, expect, test } from 'bun:test'

import {
  claimAdImpression,
  dispatchFirstPartyViewAcknowledgement,
  isAnswerMessage,
  isInlineAdEligibleAnswer,
  NO_RESPONSE_ADS,
  renderDelaySinceReceipt,
  visibleResponseAds,
} from '../use-gravity-ad'

import type { ChatMessage } from '../../types/chat'
import type { FirstPartyViewAckRequest } from '@codebuff/common/ads/first-party-view-ack'

const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: 'user-1',
  variant: 'user',
  content: 'hello',
  timestamp: '',
  ...over,
})

// Only genuine streamed LLM answers (id 'ai-…', top-level) receive
// interspersed ads — not bash echoes or system notices.
describe('isAnswerMessage', () => {
  const aiMsg = (over: Partial<ChatMessage>): ChatMessage =>
    msg({ id: 'ai-1', variant: 'ai', content: '', ...over })

  test('accepts a top-level streamed answer (even mid-stream)', () => {
    expect(isAnswerMessage(aiMsg({}))).toBe(true)
    expect(isAnswerMessage(aiMsg({ isComplete: false }))).toBe(true)
  })

  test('rejects bash echoes, system notices, and nested messages', () => {
    expect(isAnswerMessage(aiMsg({ id: 'bash-result-x' }))).toBe(false)
    expect(isAnswerMessage(aiMsg({ id: 'sys-1' }))).toBe(false)
    expect(isAnswerMessage(aiMsg({ parentId: 'ai-0' }))).toBe(false)
    expect(isAnswerMessage(msg({}))).toBe(false)
  })
})

describe('isInlineAdEligibleAnswer', () => {
  test('only accepts live response shells', () => {
    expect(
      isInlineAdEligibleAnswer(
        msg({
          id: 'ai-live',
          variant: 'ai',
          metadata: { allowInlineAds: true },
        }),
      ),
    ).toBe(true)
    expect(
      isInlineAdEligibleAnswer(msg({ id: 'ai-restored', variant: 'ai' })),
    ).toBe(false)
    expect(
      isInlineAdEligibleAnswer(
        msg({
          id: 'sys-1',
          variant: 'ai',
          metadata: { allowInlineAds: true },
        }),
      ),
    ).toBe(false)
  })
})

describe('renderDelaySinceReceipt (COD-365)', () => {
  test('measures from the auction-response receipt stamp, floored at zero', () => {
    expect(renderDelaySinceReceipt({ receivedAtMs: 1_000 }, 1_234)).toBe(234)
    expect(renderDelaySinceReceipt({ receivedAtMs: 2_000 }, 1_000)).toBe(0)
    expect(renderDelaySinceReceipt({ receivedAtMs: 1_000 }, 1_000.4)).toBe(0)
  })

  test('an ad without a stamp reports unknown rather than a guess', () => {
    expect(renderDelaySinceReceipt({})).toBeUndefined()
    expect(renderDelaySinceReceipt({ receivedAtMs: NaN })).toBeUndefined()
  })
})

describe('claimAdImpression', () => {
  test('claims each distinct ad once even when its card is repeated', () => {
    const fired = new Set<string>()

    expect(claimAdImpression(fired, 'imp-1')).toBe(true)
    expect(claimAdImpression(fired, 'imp-2')).toBe(true)
    expect(claimAdImpression(fired, 'imp-1')).toBe(false)
    expect(fired).toEqual(new Set(['imp-1', 'imp-2']))
  })
})

describe('dispatchFirstPartyViewAcknowledgement', () => {
  const request: Omit<FirstPartyViewAckRequest, 'onAttempt'> = {
    token: 'opaque-imp-url',
    url: 'https://app.codebuff.com/api/v1/ads/impression',
    init: {
      method: 'POST',
      headers: {
        Authorization: 'Bearer cli-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ impUrl: 'opaque-imp-url' }),
    },
    surface: 'waiting_room',
    placementId: 'waiting-room-1',
    clientFamily: 'cli',
  }

  test('uses shared acknowledgement with immutable bearer request/context for first-party ads', () => {
    const calls: FirstPartyViewAckRequest[] = []
    const telemetry: unknown[] = []
    const dispatched = dispatchFirstPartyViewAcknowledgement(
      'first_party',
      request,
      (event) => telemetry.push(event),
      ((params: FirstPartyViewAckRequest) => {
        calls.push(params)
        params.onAttempt?.({
          surface: 'waiting_room',
          placement_id: 'waiting-room-1',
          outcome: 'accepted',
          attempt: 1,
          duration_ms: 4,
          client_family: 'cli',
        })
        return Promise.resolve()
      }) as typeof import('@codebuff/common/ads/first-party-view-ack').acknowledgeFirstPartyView,
    )
    expect(dispatched).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      token: 'opaque-imp-url',
      surface: 'waiting_room',
      placementId: 'waiting-room-1',
      clientFamily: 'cli',
    })
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer cli-token' },
    })
    expect(telemetry).toHaveLength(1)
  })

  test('leaves third-party impressions on the legacy path and caller dedupe remains impUrl based', () => {
    let calls = 0
    const acknowledge = (() => {
      calls++
      return Promise.resolve()
    }) as typeof import('@codebuff/common/ads/first-party-view-ack').acknowledgeFirstPartyView
    expect(
      dispatchFirstPartyViewAcknowledgement(
        'gravity',
        request,
        () => {},
        acknowledge,
      ),
    ).toBe(false)
    const fired = new Set<string>()
    expect(claimAdImpression(fired, 'opaque-imp-url')).toBe(true)
    expect(claimAdImpression(fired, 'opaque-imp-url')).toBe(false)
    expect(calls).toBe(0)
  })
})

describe('visibleResponseAds', () => {
  // Chat's layout effect depends on this value and writes it to the
  // message-block store. A fresh `{}` per render re-ran the effect after every
  // commit while ads were hidden, feeding React's nested-update limit (#185).
  test('hidden ads are one stable value across renders', () => {
    const first = visibleResponseAds(false, { 'ai-1': [] })
    const second = visibleResponseAds(false, {})
    expect(first).toBe(NO_RESPONSE_ADS)
    expect(second).toBe(first)
    expect(Object.keys(first)).toEqual([])
  })

  test('visible ads pass through unchanged', () => {
    const ads = { 'ai-1': [] }
    expect(visibleResponseAds(true, ads)).toBe(ads)
  })
})
