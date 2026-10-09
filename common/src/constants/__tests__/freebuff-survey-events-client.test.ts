import { describe, expect, test } from 'bun:test'

import {
  surveyEventBatchSchema,
  SURVEY_EVENT_DWELL_MS_MAX,
} from '../freebuff-sponsored-survey'
import {
  createSurveyCardTracker,
  createSurveyEventSink,
  type SurveyEventSendOptions,
} from '../freebuff-survey-events-client'

import type {
  SurveyEventBatch,
  SurveyEventInput,
} from '../freebuff-sponsored-survey'

function fakeTimers() {
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = []
  return {
    timers,
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms, live: true }
      timers.push(t)
      return t
    },
    clearTimer: (t: unknown) => {
      ;(t as { live: boolean }).live = false
    },
    fire() {
      for (const t of timers.splice(0)) if (t.live) t.fn()
    },
  }
}

function setup(send?: (b: SurveyEventBatch, o: SurveyEventSendOptions) => unknown) {
  const sent: Array<{ batch: SurveyEventBatch; options: SurveyEventSendOptions }> = []
  const clock = fakeTimers()
  const sink = createSurveyEventSink({
    send: (batch, options) => {
      sent.push({ batch, options })
      return send?.(batch, options) as Promise<unknown> | void
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  return { sink, sent, clock }
}

const EVENT: SurveyEventInput = {
  surveyKind: 'profile',
  surveyRef: '2',
  eventType: 'question_viewed',
  questionId: 'role',
  questionIndex: 0,
  surface: 'web',
}

describe('createSurveyEventSink', () => {
  test('holds events until the interval fires, then sends one batch', async () => {
    const { sink, sent, clock } = setup()
    sink.push(EVENT)
    sink.push(EVENT)
    expect(sent).toEqual([])
    expect(clock.timers).toHaveLength(1)
    clock.fire()
    await Promise.resolve()
    expect(sent).toHaveLength(1)
    expect(sent[0].batch.events).toHaveLength(2)
    expect(sent[0].options).toEqual({ unloading: false })
    expect(sink.pending()).toBe(0)
  })

  test('flushes at once after ten events', () => {
    const { sink, sent } = setup()
    for (let i = 0; i < 10; i++) sink.push(EVENT)
    expect(sent).toHaveLength(1)
    expect(sent[0].batch.events).toHaveLength(10)
  })

  test('a flush splits into schema-valid batches of at most 20', async () => {
    const sent: SurveyEventBatch[] = []
    const sink = createSurveyEventSink({
      send: (b) => void sent.push(b),
      flushAt: 1000,
      setTimer: () => 0,
      clearTimer: () => {},
    })
    for (let i = 0; i < 45; i++) sink.push(EVENT)
    await sink.flush()
    expect(sent.map((b) => b.events.length)).toEqual([20, 20, 5])
    for (const b of sent) expect(surveyEventBatchSchema.safeParse(b).success).toBe(true)
  })

  test('never throws or rejects when send fails, and does not retry', async () => {
    let calls = 0
    const sink = createSurveyEventSink({
      send: () => {
        calls++
        throw new Error('offline')
      },
      setTimer: () => 0,
      clearTimer: () => {},
    })
    sink.push(EVENT)
    await sink.flush()
    const rejecting = createSurveyEventSink({
      send: async () => {
        calls++
        throw new Error('503')
      },
      setTimer: () => 0,
      clearTimer: () => {},
    })
    rejecting.push(EVENT)
    await rejecting.flush()
    await rejecting.flush()
    expect(calls).toBe(2)
  })

  test('unload runs listeners first, then flushes as unloading', async () => {
    const { sink, sent } = setup()
    sink.push(EVENT)
    const off = sink.onUnload(() => sink.push({ ...EVENT, eventType: 'abandoned' }))
    await sink.unload()
    expect(sent).toHaveLength(1)
    expect(sent[0].options).toEqual({ unloading: true })
    expect(sent[0].batch.events.map((e) => e.eventType)).toEqual([
      'question_viewed',
      'abandoned',
    ])
    off()
    await sink.unload()
    expect(sent).toHaveLength(1)
  })

  test('keeps only the newest events past the buffer cap', async () => {
    const sent: SurveyEventBatch[] = []
    const sink = createSurveyEventSink({
      send: (b) => void sent.push(b),
      flushAt: 1000,
      bufferMax: 3,
      setTimer: () => 0,
      clearTimer: () => {},
    })
    for (let i = 0; i < 5; i++) sink.push({ ...EVENT, questionIndex: i })
    await sink.flush()
    expect(sent[0].events.map((e) => e.questionIndex)).toEqual([2, 3, 4])
  })
})

describe('createSurveyCardTracker', () => {
  function tracker(kind: 'profile' | 'sponsored' = 'profile', ref = '2') {
    let t = 1_000_000
    const events: SurveyEventInput[] = []
    const sink = {
      push: (e: SurveyEventInput) => void events.push(e),
      flush: async () => {},
      unload: async () => {},
      onUnload: () => () => {},
      pending: () => 0,
    }
    const card = createSurveyCardTracker({
      sink,
      surveyKind: kind,
      surveyRef: ref,
      surface: 'desktop',
      now: () => t,
    })
    return { card, events, tick: (ms: number) => (t += ms) }
  }

  test('render, view, answer with dwell, complete: no abandon', () => {
    const { card, events, tick } = tracker()
    card.rendered()
    card.rendered()
    card.viewed(0, 'role')
    card.viewed(0, 'role')
    tick(2500)
    card.answered()
    card.viewed(1, 'buy_timing')
    tick(900)
    card.answered()
    card.completed()
    card.ended()
    expect(events.map((e) => [e.eventType, e.questionIndex, e.dwellMs])).toEqual([
      ['card_rendered', undefined, undefined],
      ['question_viewed', 0, undefined],
      ['answered', 0, 2500],
      ['question_viewed', 1, undefined],
      ['answered', 1, 900],
    ])
    expect(events.every((e) => e.surveyKind === 'profile' && e.surveyRef === '2')).toBe(true)
    expect(events.every((e) => e.surface === 'desktop' && typeof e.clientTs === 'string')).toBe(
      true,
    )
    expect(surveyEventBatchSchema.safeParse({ events }).success).toBe(true)
  })

  test('leaving on an unanswered question is abandoned, once', () => {
    const { card, events, tick } = tracker('sponsored', 'camp_1')
    card.rendered()
    card.viewed(0, 'q0')
    card.answered(1200)
    card.viewed(1, 'q1')
    tick(4000)
    card.ended()
    card.ended()
    const last = events.at(-1)!
    expect(last).toMatchObject({
      eventType: 'abandoned',
      surveyKind: 'sponsored',
      surveyRef: 'camp_1',
      questionIndex: 1,
      questionId: 'q1',
      dwellMs: 4000,
    })
    expect(events.filter((e) => e.eventType === 'abandoned')).toHaveLength(1)
  })

  test('dismiss ends the card: no abandon after it', () => {
    const { card, events, tick } = tracker()
    card.rendered()
    card.viewed(2, 'other_tools')
    tick(700)
    card.dismissed()
    card.ended()
    card.viewed(3, 'pay_trigger')
    expect(events.map((e) => e.eventType)).toEqual([
      'card_rendered',
      'question_viewed',
      'dismissed',
    ])
    expect(events[2]).toMatchObject({ questionIndex: 2, dwellMs: 700 })
  })

  test('a card that never showed a question ends silently', () => {
    const { card, events } = tracker()
    card.rendered()
    card.ended()
    expect(events.map((e) => e.eventType)).toEqual(['card_rendered'])
  })

  test('dwell is clamped to the schema bounds', () => {
    const { card, events, tick } = tracker()
    card.viewed(0, 'role')
    tick(SURVEY_EVENT_DWELL_MS_MAX * 2)
    card.answered()
    card.viewed(1, 'x')
    card.answered(-5)
    expect(events.filter((e) => e.eventType === 'answered').map((e) => e.dwellMs)).toEqual([
      SURVEY_EVENT_DWELL_MS_MAX,
      0,
    ])
  })

  test('a null sink is a no-op tracker', () => {
    const card = createSurveyCardTracker({
      sink: null,
      surveyKind: 'profile',
      surveyRef: '2',
      surface: 'cli',
    })
    card.rendered()
    card.viewed(0, 'role')
    card.ended()
  })
})
