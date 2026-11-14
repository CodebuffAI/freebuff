import { expect, test } from 'bun:test'
import { cliFunnelKey, createCliFunnelCapture } from '../cli-product-funnel'

import type { CliFunnelDetails } from '../cli-product-funnel'
import type { ProductFunnelEvent } from '@codebuff/common/constants/product-funnel'

const flowId = '748a7a97-c663-41ef-9e99-87c422586d65'
function fixture(enabled = true) {
  const events: ProductFunnelEvent[] = []
  const capture = createCliFunnelCapture({
    enabled: () => enabled,
    flowId,
    platform: 'linux',
    release: () => '1.0.3',
    capture: (event) => {
      events.push(event)
    },
  })
  return { capture, events }
}

test('native funnel carries a stable launch, release and opaque chat key, with bounded exposure', () => {
  const { capture, events } = fixture()
  const thread_id = cliFunnelKey('local-chat-id')
  capture('composer', 'shown', { thread_id }, 'chat')
  capture('composer', 'shown', { thread_id }, 'chat')
  capture('draft', 'started', { thread_id }, 'chat')
  expect(events.length).toBe(2)
  expect(events[0]).toEqual({
    product: 'cli',
    flow_id: flowId,
    entry_route: 'cli',
    event_version: 1,
    surface: 'cli',
    observer: 'cli',
    release: '1.0.3',
    platform: 'linux',
    funnel_stage: 'composer',
    funnel_state: 'shown',
    thread_id,
  })
  expect(thread_id).toMatch(/^[a-f0-9]{64}$/)
  expect(thread_id).not.toContain('local-chat-id')
})

test('rejects unexpected prompt/path/auth payloads rather than forwarding them', () => {
  const { capture, events } = fixture()
  capture('draft', 'started', {
    reason: 'error',
    prompt: 'private',
    path: '/repo',
    auth_flow_id: flowId,
  } as CliFunnelDetails)
  expect(events).toEqual([])
})

test('Codebuff is excluded and capture failures never escape', () => {
  const { capture, events } = fixture(false)
  capture('launch', 'started')
  expect(events).toEqual([])
  const broken = createCliFunnelCapture({
    enabled: () => true,
    flowId,
    platform: 'linux',
    release: () => '1.0.3',
    capture: () => {
      throw new Error('offline')
    },
  })
  expect(() => broken('launch', 'started')).not.toThrow()
})

test('an unavailable analytics sink does not consume an exposure key', () => {
  const events: ProductFunnelEvent[] = []
  let ready = false
  const capture = createCliFunnelCapture({
    enabled: () => true,
    flowId,
    platform: 'linux',
    release: () => '1.0.3',
    capture: (event) => {
      if (!ready) return false
      events.push(event)
      return true
    },
  })
  capture('composer', 'shown', {}, 'chat')
  expect(events).toHaveLength(0)
  ready = true
  capture('composer', 'shown', {}, 'chat')
  capture('composer', 'shown', {}, 'chat')
  expect(events).toHaveLength(1)
})
