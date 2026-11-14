import { afterEach, describe, expect, test } from 'bun:test'

import {
  registerAdTranscriptViewport,
  resetAdSignalsForTests,
} from '../../ads/ad-signals'
import {
  AD_ROTATION_TICK_SLACK_MS,
  adFocusAllows,
  answerEndVisible,
  handleAdFocusReturn,
  claimAdImpression,
  impressionDisposition,
  inlineRequestDisposition,
  rotationDueOnFocus,
  rotationTickPlan,
  applySlotYield,
  deliverRotation,
  dispatchFirstPartyViewAcknowledgement,
  drawnAdImpUrls,
  isAnswerMessage,
  resumeRotationAfterYield,
  isInlineAdEligibleAnswer,
  isWithheldAdResponse,
  NO_RESPONSE_ADS,
  renderDelaySinceReceipt,
  rotationStep,
  sendClickAfterView,
  shouldHideGravityAds,
  visibleResponseAds,
} from '../use-gravity-ad'

import type { AdResponse, FocusReturnState } from '../use-gravity-ad'
import type { ChatMessage } from '../../types/chat'
import {
  acknowledgeFirstPartyView,
  resetFirstPartyViewAckRegistryForTests,
} from '@codebuff/common/ads/first-party-view-ack'

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

describe('shouldHideGravityAds', () => {
  test('a disabled hook is hidden at every height, Freebuff included', () => {
    // The landing screen relies on this to stop fetching for a slot it does
    // not draw: Freebuff ignores the compact-height rule, `enabled` does not.
    for (const isFreeMode of [true, false]) {
      for (const terminalHeight of [10, 17, 18, 60]) {
        expect(
          shouldHideGravityAds({ enabled: false, terminalHeight, isFreeMode }),
        ).toBe(true)
      }
    }
  })

  test('Freebuff keeps ads on compact terminals; Codebuff drops them', () => {
    expect(
      shouldHideGravityAds({
        enabled: true,
        terminalHeight: 17,
        isFreeMode: true,
      }),
    ).toBe(false)
    expect(
      shouldHideGravityAds({
        enabled: true,
        terminalHeight: 17,
        isFreeMode: false,
      }),
    ).toBe(true)
    expect(
      shouldHideGravityAds({
        enabled: true,
        terminalHeight: 18,
        isFreeMode: false,
      }),
    ).toBe(false)
  })
})

// Ad click IVT: a real click must not reach the server ahead of its own view,
// or the sweep would later read it as a view that never arrived.
describe('sendClickAfterView', () => {
  test('sends the click only after the in-flight view ack settles', async () => {
    resetFirstPartyViewAckRegistryForTests()
    const order: string[] = []
    let answerView!: (response: Response) => void
    void acknowledgeFirstPartyView({
      token: 'imp-1',
      url: 'https://example.test/api/v1/ads/impression',
      surface: 'cli_chat',
      placementId: 'p',
      clientFamily: 'cli',
      fetch: () => {
        order.push('view sent')
        return new Promise<Response>((resolve) => {
          answerView = resolve
        })
      },
    })
    const click = sendClickAfterView('imp-1', async () => {
      order.push('click sent')
      return 'ok'
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(order).toEqual(['view sent'])
    answerView(new Response(null, { status: 204 }))
    expect(await click).toBe('ok')
    expect(order).toEqual(['view sent', 'click sent'])
    resetFirstPartyViewAckRegistryForTests()
  })

  test('sends at once when no view is in flight', async () => {
    resetFirstPartyViewAckRegistryForTests()
    let sent = false
    await sendClickAfterView('never-viewed', async () => {
      sent = true
    })
    expect(sent).toBe(true)
  })
})

describe('a withheld ad response (COD-906)', () => {
  const ad = (impUrl: string) => ({ impUrl }) as unknown as AdResponse
  const cache = () => ({
    choiceCache: [[ad('cached-1')]] as AdResponse[][],
    choiceCacheIndex: 0,
  })

  test('only an empty ads list flagged withheld counts', () => {
    expect(isWithheldAdResponse({ ads: [], withheld: true })).toBe(true)
    expect(isWithheldAdResponse({ ads: [], provider: 'gravity' })).toBe(false)
    expect(isWithheldAdResponse({ ads: [], withheld: 'true' })).toBe(false)
    expect(isWithheldAdResponse({ ads: [ad('a')], withheld: true })).toBe(false)
    expect(isWithheldAdResponse(null)).toBe(false)
  })

  test('clears the slot instead of re-showing a cached ad', () => {
    const ctrl = cache()
    expect(rotationStep(ctrl, { withheld: true })).toEqual({
      show: null,
      countsAsShown: false,
    })
    expect(ctrl.choiceCacheIndex).toBe(0)
  })

  test('a failed or empty fetch still falls back to the cache', () => {
    const ctrl = cache()
    expect(rotationStep(ctrl, null)).toEqual({
      show: [ad('cached-1')],
      countsAsShown: true,
    })
    expect(rotationStep({ choiceCache: [], choiceCacheIndex: 0 }, null)).toEqual(
      { show: undefined, countsAsShown: false },
    )
  })

  test('served ads are cached and shown', () => {
    const ctrl = cache()
    expect(rotationStep(ctrl, { ads: [ad('new')] })).toEqual({
      show: [ad('new')],
      countsAsShown: true,
    })
    expect(ctrl.choiceCache).toHaveLength(2)
  })

  test('the cache never re-shows an expired ad', () => {
    const ctrl = {
      choiceCache: [[ad('old')], [ad('fresh')]] as AdResponse[][],
      choiceCacheIndex: 0,
    }
    const expired = (impUrl: string) => impUrl === 'old'
    expect(rotationStep(ctrl, null, expired).show).toEqual([ad('fresh')])
    expect(rotationStep(ctrl, null, expired).show).toEqual([ad('fresh')])
    expect(
      rotationStep({ ...ctrl, choiceCache: [[ad('old')]] }, null, expired),
    ).toEqual({ show: undefined, countsAsShown: false })
  })
})

describe('ad expiry on a rotation tick', () => {
  const tick = (over: Partial<Parameters<typeof rotationTickPlan>[0]>) =>
    rotationTickPlan({
      adsEnabled: true,
      slotPaused: false,
      focused: true,
      adsShownSinceActivity: 0,
      userActive: true,
      ...over,
    })

  test('an expired ad is cleared even on a tick that would skip', () => {
    expect(tick({ currentExpired: true })).toBe('expire')
    expect(tick({ currentExpired: true, focused: false })).toBe('expire')
    expect(tick({ currentExpired: true, slotPaused: true })).toBe('expire')
    expect(
      tick({ currentExpired: true, lastRotationAt: 1_000, now: 2_000 }),
    ).toBe('expire')
    expect(tick({ currentExpired: true, adsEnabled: false })).toBe('skip')
  })

  test('after an expiry, nothing is re-shown until the person is active', () => {
    expect(tick({ expiredIdle: true, userActive: false })).toBe('skip')
    expect(tick({ expiredIdle: true, adsShownSinceActivity: 3 })).toBe('skip')
    expect(tick({ expiredIdle: true })).toBe('fetch')
    expect(tick({ expiredIdle: false, userActive: false })).toBe('cache')
  })
})

describe('terminal focus gates fetches and impressions', () => {
  test('only a reported unfocus blocks; unknown focus counts as focused', () => {
    expect(adFocusAllows(true)).toBe(true)
    expect(adFocusAllows(undefined)).toBe(true)
    expect(adFocusAllows(false)).toBe(false)
  })

  const tick = (over: Partial<Parameters<typeof rotationTickPlan>[0]>) =>
    rotationTickPlan({
      adsEnabled: true,
      slotPaused: false,
      focused: true,
      adsShownSinceActivity: 0,
      userActive: true,
      ...over,
    })

  test('an unfocused terminal makes no fetch and no swap on a tick', () => {
    expect(tick({ focused: false })).toBe('skip')
    expect(tick({ focused: false, userActive: false })).toBe('skip')
  })

  test('unknown focus rotates exactly as focused does', () => {
    expect(tick({ focused: undefined })).toBe('fetch')
    expect(tick({ focused: undefined, userActive: false })).toBe('cache')
  })

  test('the activity rule is unchanged: three after activity, typed in 30 s', () => {
    expect(tick({ adsShownSinceActivity: 2 })).toBe('fetch')
    expect(tick({ adsShownSinceActivity: 3 })).toBe('cache')
    expect(tick({ userActive: false })).toBe('cache')
    expect(tick({ slotPaused: true })).toBe('skip')
    expect(tick({ adsEnabled: false })).toBe('skip')
  })

  test('focus returning rotates only once the interval has elapsed', () => {
    expect(rotationDueOnFocus({ lastRotationAt: null, now: 0 })).toBe(true)
    expect(
      rotationDueOnFocus({ lastRotationAt: 1_000, now: 1_000 + 59_999 }),
    ).toBe(false)
    expect(
      rotationDueOnFocus({ lastRotationAt: 1_000, now: 1_000 + 60_000 }),
    ).toBe(true)
  })

  test('an impression waits for focus; unknown focus and clicks do not wait', () => {
    expect(impressionDisposition({ focused: false })).toBe('defer')
    expect(impressionDisposition({ focused: undefined })).toBe('fire')
    expect(impressionDisposition({ focused: true })).toBe('fire')
    // A click on an ad whose impression never fired sends it first.
    expect(impressionDisposition({ focused: false, force: true })).toBe('fire')
  })

  test('the end-of-answer card is requested only while not unfocused', () => {
    expect(inlineRequestDisposition({ count: 1, focused: true })).toBe(
      'request',
    )
    expect(inlineRequestDisposition({ count: 1, focused: undefined })).toBe(
      'request',
    )
    expect(inlineRequestDisposition({ count: 1, focused: false })).toBe('defer')
    // The renderer asks with 0 until the answer completes: no request.
    expect(inlineRequestDisposition({ count: 0, focused: true })).toBe('none')
  })

  test("the card waits until the answer's end is in the viewport", () => {
    expect(
      inlineRequestDisposition({ count: 1, focused: true, endVisible: false }),
    ).toBe('defer')
    expect(
      inlineRequestDisposition({ count: 1, focused: true, endVisible: true }),
    ).toBe('request')
    // Unmeasurable: request, as before the visibility check existed.
    expect(
      inlineRequestDisposition({
        count: 1,
        focused: undefined,
        endVisible: undefined,
      }),
    ).toBe('request')
    expect(
      inlineRequestDisposition({ count: 1, focused: false, endVisible: true }),
    ).toBe('defer')
  })

  test('a tick within one interval of the last rotation is skipped', () => {
    const at = (lastRotationAt: number | null, now: number) =>
      tick({ lastRotationAt, now })
    expect(at(null, 5_000)).toBe('fetch')
    expect(at(0, 5_000)).toBe('skip')
    expect(at(0, 60_000 - AD_ROTATION_TICK_SLACK_MS - 1)).toBe('skip')
    // Timer jitter: a tick a hair early still rotates.
    expect(at(0, 60_000 - AD_ROTATION_TICK_SLACK_MS)).toBe('fetch')
    expect(at(0, 60_000)).toBe('fetch')
  })
})

describe('answerEndVisible', () => {
  afterEach(() => resetAdSignalsForTests())

  test("tests the answer's last row against the transcript viewport", () => {
    registerAdTranscriptViewport(() => ({ top: 10, bottom: 30 }))
    expect(answerEndVisible(() => ({ top: 29, height: 1 }))).toBe(true)
    expect(answerEndVisible(() => ({ top: 30, height: 1 }))).toBe(false)
    expect(answerEndVisible(() => ({ top: 5, height: 1 }))).toBe(false)
  })

  test('unmeasurable on either side is undefined', () => {
    expect(answerEndVisible(() => ({ top: 29, height: 1 }))).toBeUndefined()
    registerAdTranscriptViewport(() => ({ top: 10, bottom: 30 }))
    expect(answerEndVisible(undefined)).toBeUndefined()
    expect(answerEndVisible(() => null)).toBeUndefined()
    expect(
      answerEndVisible(() => {
        throw new Error('destroyed')
      }),
    ).toBeUndefined()
  })
})

describe('handleAdFocusReturn', () => {
  const ad = (impUrl: string): AdResponse => ({
    adText: 'x',
    title: 't',
    cta: 'c',
    url: 'https://example.com',
    favicon: '',
    clickUrl: 'https://track.example/c',
    impUrl,
  })

  function run(
    state: FocusReturnState,
    over: { now?: number; drawn?: string[]; slotActive?: boolean } = {},
  ) {
    const calls: string[] = []
    const impressions: string[] = []
    const result = handleAdFocusReturn(state, {
      now: over.now ?? 0,
      drawnImpUrls: new Set(over.drawn ?? []),
      slotActive: over.slotActive ?? true,
      recordImpression: (a) => impressions.push(a.impUrl),
      runInitialFetch: () => calls.push('initial_fetch'),
      rotate: () => calls.push('rotate'),
      restartRotationTimer: () => calls.push('restart_timer'),
      retryDeferredInline: () => calls.push('retry_inline'),
    })
    return { result, calls, impressions }
  }

  test('sends a held impression only for an ad still drawn', () => {
    const state: FocusReturnState = {
      lastRotationAt: 0,
      initialFetchPending: false,
      deferredImpressions: new Map([
        ['imp-drawn', ad('imp-drawn')],
        ['imp-gone', ad('imp-gone')],
      ]),
    }
    const { impressions } = run(state, { now: 10_000, drawn: ['imp-drawn'] })
    expect(impressions).toEqual(['imp-drawn'])
    // The held set is cleared either way: a gone ad is never sent later.
    expect(state.deferredImpressions.size).toBe(0)
  })

  test('runs a first fetch skipped while unfocused, and re-phases the timer', () => {
    const state: FocusReturnState = {
      lastRotationAt: null,
      initialFetchPending: true,
      deferredImpressions: new Map(),
    }
    const { result, calls } = run(state)
    expect(result).toBe('initial_fetch')
    expect(calls).toEqual(['initial_fetch', 'restart_timer', 'retry_inline'])
  })

  test('rotates only when a full interval has passed', () => {
    const state: FocusReturnState = {
      lastRotationAt: 0,
      initialFetchPending: false,
      deferredImpressions: new Map(),
    }
    expect(run(state, { now: 30_000 }).calls).toEqual(['retry_inline'])
    expect(run(state, { now: 60_000 }).calls).toEqual([
      'rotate',
      'restart_timer',
      'retry_inline',
    ])
  })

  test('a stopped slot neither fetches nor rotates, but still retries the card', () => {
    const state: FocusReturnState = {
      lastRotationAt: null,
      initialFetchPending: true,
      deferredImpressions: new Map(),
    }
    expect(run(state, { slotActive: false }).calls).toEqual(['retry_inline'])
  })

  test('the dock does not rotate twice within one interval after focus returns', () => {
    // Last rotation at 0; the ticks at 60 s and 120 s were skipped while
    // unfocused. Focus returns at 125 s and rotates.
    const state: FocusReturnState = {
      lastRotationAt: 0,
      initialFetchPending: false,
      deferredImpressions: new Map(),
    }
    const rotations: number[] = []
    const focusAt = 125_000
    handleAdFocusReturn(state, {
      now: focusAt,
      drawnImpUrls: new Set(),
      slotActive: true,
      recordImpression: () => {},
      runInitialFetch: () => {},
      rotate: () => {
        state.lastRotationAt = focusAt
        rotations.push(focusAt)
      },
      restartRotationTimer: () => {},
      retryDeferredInline: () => {},
    })
    // A tick still on the old phase (180 s) is 55 s after that rotation:
    // skipped. A tick a full interval later rotates.
    const tickAt = (now: number) =>
      rotationTickPlan({
        adsEnabled: true,
        slotPaused: false,
        focused: true,
        adsShownSinceActivity: 0,
        userActive: true,
        lastRotationAt: state.lastRotationAt,
        now,
      })
    expect(tickAt(180_000)).toBe('skip')
    expect(tickAt(185_000)).toBe('fetch')
    expect(rotations).toEqual([125_000])
  })
})

describe('the dock giving way to an end-of-answer card in view', () => {
  const ad = (impUrl: string) =>
    ({ impUrl, adText: '', title: '', cta: '', url: '', favicon: '', clickUrl: '' }) as AdResponse

  test('a yielded slot neither fetches nor swaps on a tick', () => {
    expect(
      rotationTickPlan({
        adsEnabled: true,
        slotPaused: true,
        focused: true,
        adsShownSinceActivity: 0,
        userActive: true,
      }),
    ).toBe('skip')
  })

  test('the hidden time does not count: the held ad gets the rest of its interval', () => {
    // shown 20 s, hidden 100 s
    const resumed = resumeRotationAfterYield({
      lastRotationAt: 1_000,
      yieldedAt: 21_000,
      now: 121_000,
      intervalMs: 60_000,
    })
    expect(resumed).toEqual({ lastRotationAt: 101_000, firstTickInMs: 40_000 })
    // the tick at the resumed due time rotates; one just before is skipped
    const due = 121_000 + resumed.firstTickInMs
    const plan = (now: number) =>
      rotationTickPlan({
        adsEnabled: true,
        slotPaused: false,
        focused: true,
        adsShownSinceActivity: 0,
        userActive: true,
        lastRotationAt: resumed.lastRotationAt,
        now,
      })
    expect(plan(due)).toBe('fetch')
    expect(plan(due - AD_ROTATION_TICK_SLACK_MS - 1)).toBe('skip')
  })

  test('an ad already past its interval when hidden rotates on return', () => {
    expect(
      resumeRotationAfterYield({
        lastRotationAt: 0,
        yieldedAt: 70_000,
        now: 80_000,
        intervalMs: 60_000,
      }).firstTickInMs,
    ).toBe(0)
  })

  test('nothing shown yet starts a fresh interval', () => {
    expect(
      resumeRotationAfterYield({
        lastRotationAt: null,
        yieldedAt: 5,
        now: 10,
        intervalMs: 60_000,
      }),
    ).toEqual({ lastRotationAt: null, firstTickInMs: 60_000 })
  })

  test('a yielded dock is not drawn, so a held impression is not sent on focus return', () => {
    const responseAds = { 'ai-1': [ad('card')] }
    expect([
      ...drawnAdImpUrls({ dockAds: [ad('dock')], dockYielded: true, responseAds }),
    ]).toEqual(['card'])
    expect(
      [
        ...drawnAdImpUrls({
          dockAds: [ad('dock')],
          dockYielded: false,
          responseAds,
        }),
      ].sort(),
    ).toEqual(['card', 'dock'])
  })

  test('focus return while yielded: the dock does not rotate or fetch', () => {
    const state: FocusReturnState = {
      lastRotationAt: 0,
      initialFetchPending: true,
      deferredImpressions: new Map([['dock', ad('dock')]]),
    }
    const calls: string[] = []
    const result = handleAdFocusReturn(state, {
      now: 10_000_000,
      drawnImpUrls: drawnAdImpUrls({
        dockAds: [ad('dock')],
        dockYielded: true,
        responseAds: {},
      }),
      slotActive: false,
      recordImpression: (a) => calls.push(`imp:${a.impUrl}`),
      runInitialFetch: () => calls.push('initial'),
      rotate: () => calls.push('rotate'),
      restartRotationTimer: () => calls.push('restart'),
      retryDeferredInline: () => calls.push('retry'),
    })
    expect(result).toBe('none')
    expect(calls).toEqual(['retry'])
  })
})

describe('applySlotYield: the dock giving way and coming back', () => {
  const ad = (impUrl: string) =>
    ({ impUrl, adText: '', title: '', cta: '', url: '', favicon: '', clickUrl: '' }) as AdResponse
  const harness = (ctrlOver: Partial<{
    lastRotationAt: number | null
    initialFetchPending: boolean
    heldRotation: AdResponse[] | null | undefined
  }> = {}) => {
    const calls: string[] = []
    const ctrl = {
      lastRotationAt: 1_000 as number | null,
      initialFetchPending: false,
      heldRotation: undefined as AdResponse[] | null | undefined,
      ...ctrlOver,
    }
    const run = (
      hold: ReturnType<typeof applySlotYield>,
      yielded: boolean,
      now: number,
      extra: { slotActive?: boolean; focused?: boolean } = {},
    ) =>
      applySlotYield(hold, {
        yielded,
        now,
        drawnImpUrls: ['dock-a'],
        slotActive: extra.slotActive ?? true,
        focused: extra.focused,
        ctrl,
        hold: (u) => calls.push(`hold:${u}`),
        release: (u) => calls.push(`release:${u}`),
        show: (ads) => calls.push(`show:${ads?.map((a) => a.impUrl).join(',') ?? 'null'}`),
        runInitialFetch: () => calls.push('initial'),
        restartRotationTimer: (ms) => calls.push(`restart:${ms ?? 'interval'}`),
        intervalMs: 60_000,
      })
    return { calls, ctrl, run }
  }

  test('giving way holds the drawn ads once; a repeat changes nothing', () => {
    const h = harness()
    const hold = h.run(null, true, 21_000)
    expect(hold).toEqual({ since: 21_000, impUrls: ['dock-a'] })
    expect(h.run(hold, true, 30_000)).toBe(hold)
    expect(h.calls).toEqual(['hold:dock-a'])
  })

  test('coming back resumes the clock with the rest of the interval, then releases', () => {
    const h = harness()
    const hold = h.run(null, true, 21_000) // shown 20 s
    expect(h.run(hold, false, 121_000)).toBeNull() // hidden 100 s
    expect(h.calls).toEqual(['hold:dock-a', 'restart:40000', 'release:dock-a'])
    expect(h.ctrl.lastRotationAt).toBe(101_000)
  })

  test('an answer held while blank is shown on return, a full interval from now, before the release', () => {
    const h = harness()
    const hold = h.run(null, true, 21_000)
    expect(deliverRotation(h.ctrl, [ad('dock-b')], true)).toBe('held')
    h.run(hold, false, 50_000)
    expect(h.calls).toEqual([
      'hold:dock-a',
      'show:dock-b',
      'restart:interval',
      'release:dock-a',
    ])
    expect(h.ctrl.lastRotationAt).toBe(50_000)
    expect(h.ctrl.heldRotation).toBeUndefined()
  })

  test('a first fetch skipped while blank runs on return when focused', () => {
    const h = harness({ lastRotationAt: null, initialFetchPending: true })
    const hold = h.run(null, true, 0)
    h.run(hold, false, 5_000, { focused: true })
    expect(h.calls).toEqual(['hold:dock-a', 'initial', 'restart:interval', 'release:dock-a'])
  })

  test('unfocused on return: the skipped first fetch waits for focus; a fresh interval starts', () => {
    const h = harness({ lastRotationAt: null, initialFetchPending: true })
    const hold = h.run(null, true, 0)
    h.run(hold, false, 5_000, { focused: false })
    expect(h.calls).toEqual(['hold:dock-a', 'restart:60000', 'release:dock-a'])
  })

  test('an inactive slot (ads hidden) only releases', () => {
    const h = harness({ heldRotation: [ad('dock-b')] })
    const hold = h.run(null, true, 0)
    h.run(hold, false, 5_000, { slotActive: false })
    expect(h.calls).toEqual(['hold:dock-a', 'release:dock-a'])
    expect(h.ctrl.heldRotation).toBeUndefined()
  })
})

describe('deliverRotation: a dock fetch landing while the slot is blank', () => {
  const ad = { impUrl: 'x' } as AdResponse
  test('shown at once while the slot draws; held (not set, not counted) while blank', () => {
    const ctrl = { heldRotation: undefined as AdResponse[] | null | undefined }
    expect(deliverRotation(ctrl, [ad], false)).toBe('show')
    expect(ctrl.heldRotation).toBeUndefined()
    expect(deliverRotation(ctrl, [ad], true)).toBe('held')
    expect(ctrl.heldRotation).toEqual([ad])
    // a withheld answer (clear the slot) is held as such
    expect(deliverRotation(ctrl, null, true)).toBe('held')
    expect(ctrl.heldRotation).toBeNull()
    // nothing to deliver
    expect(deliverRotation(ctrl, undefined, true)).toBe('none')
  })
})

describe('a sponsored offer in the dock holds the card request', () => {
  test('deferred while the offer holds the dock, requested once it has gone', () => {
    const base = { count: 1, focused: true as const, endVisible: true }
    expect(inlineRequestDisposition({ ...base, offerInDock: true })).toBe('defer')
    expect(inlineRequestDisposition({ ...base, offerInDock: false })).toBe('request')
    // still the other gates once the offer has gone
    expect(
      inlineRequestDisposition({ ...base, endVisible: false, offerInDock: false }),
    ).toBe('defer')
  })
})
