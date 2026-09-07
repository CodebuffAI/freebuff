import { existsSync, rmSync } from 'fs'

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import { useChatStore } from '../../state/chat-store'
import {
  runActivityMarkerPath,
  startRunActivityMarker,
} from '../run-activity-marker'

describe('run-activity-marker', () => {
  const markerPath = runActivityMarkerPath()

  beforeEach(() => {
    rmSync(markerPath, { force: true })
    useChatStore.getState().setIsChainInProgress(false)
  })

  afterAll(() => {
    rmSync(markerPath, { force: true })
    useChatStore.getState().setIsChainInProgress(false)
  })

  test('writes the marker while a turn is in progress and removes it when idle', () => {
    startRunActivityMarker()

    expect(existsSync(markerPath)).toBe(false)

    useChatStore.getState().setIsChainInProgress(true)
    expect(existsSync(markerPath)).toBe(true)

    useChatStore.getState().setIsChainInProgress(false)
    expect(existsSync(markerPath)).toBe(false)
  })

  test('is a no-op when the value does not actually change', () => {
    startRunActivityMarker()
    useChatStore.getState().setIsChainInProgress(true)
    rmSync(markerPath, { force: true })

    // Re-affirming the same value must not recreate the marker: only a real
    // active/idle transition should.
    useChatStore.getState().setIsChainInProgress(true)
    expect(existsSync(markerPath)).toBe(false)
  })

  test('registering more than once never stacks a duplicate exit handler', () => {
    startRunActivityMarker()
    const countAfterFirstStart = process.listenerCount('exit')

    startRunActivityMarker()
    startRunActivityMarker()

    expect(process.listenerCount('exit')).toBe(countAfterFirstStart)
  })
})
