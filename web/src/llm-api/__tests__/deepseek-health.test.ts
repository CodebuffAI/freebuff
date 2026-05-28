import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { deepseekModels } from '@codebuff/common/constants/model-config'

import {
  DEEPSEEK_CIRCUIT_CONFIG,
  __resetDeepSeekCircuitForTests,
  isDeepSeekCircuitOpen,
  isLikelyDeepSeekOutage,
  recordDeepSeekFailure,
  recordDeepSeekSuccess,
  shouldBypassDeepSeek,
} from '../deepseek-health'

describe('DeepSeek circuit breaker', () => {
  beforeEach(() => {
    __resetDeepSeekCircuitForTests()
  })
  afterEach(() => {
    __resetDeepSeekCircuitForTests()
  })

  it('starts closed', () => {
    expect(isDeepSeekCircuitOpen()).toBe(false)
    expect(shouldBypassDeepSeek(deepseekModels.deepseekV4Flash)).toBe(false)
  })

  it('stays closed after fewer failures than threshold', () => {
    for (let i = 0; i < DEEPSEEK_CIRCUIT_CONFIG.FAILURE_THRESHOLD - 1; i++) {
      recordDeepSeekFailure()
    }
    expect(isDeepSeekCircuitOpen()).toBe(false)
  })

  it('opens after threshold failures in the window', () => {
    for (let i = 0; i < DEEPSEEK_CIRCUIT_CONFIG.FAILURE_THRESHOLD; i++) {
      recordDeepSeekFailure()
    }
    expect(isDeepSeekCircuitOpen()).toBe(true)
  })

  it('only bypasses v4-flash variants, not v4-pro', () => {
    for (let i = 0; i < DEEPSEEK_CIRCUIT_CONFIG.FAILURE_THRESHOLD; i++) {
      recordDeepSeekFailure()
    }
    expect(shouldBypassDeepSeek(deepseekModels.deepseekV4Flash)).toBe(true)
    expect(shouldBypassDeepSeek(deepseekModels.deepseekV4FlashDirect)).toBe(
      true,
    )
    expect(shouldBypassDeepSeek(deepseekModels.deepseekV4Pro)).toBe(false)
    expect(shouldBypassDeepSeek(deepseekModels.deepseekV4ProDirect)).toBe(false)
    expect(shouldBypassDeepSeek('anthropic/claude-sonnet-4.5')).toBe(false)
  })

  it('resets on success', () => {
    for (let i = 0; i < DEEPSEEK_CIRCUIT_CONFIG.FAILURE_THRESHOLD; i++) {
      recordDeepSeekFailure()
    }
    expect(isDeepSeekCircuitOpen()).toBe(true)
    recordDeepSeekSuccess()
    expect(isDeepSeekCircuitOpen()).toBe(false)
    expect(shouldBypassDeepSeek(deepseekModels.deepseekV4Flash)).toBe(false)
  })
})

describe('isLikelyDeepSeekOutage', () => {
  it('treats 5xx, 408, 429 as outages', () => {
    expect(isLikelyDeepSeekOutage(undefined, 500)).toBe(true)
    expect(isLikelyDeepSeekOutage(undefined, 502)).toBe(true)
    expect(isLikelyDeepSeekOutage(undefined, 503)).toBe(true)
    expect(isLikelyDeepSeekOutage(undefined, 504)).toBe(true)
    expect(isLikelyDeepSeekOutage(undefined, 408)).toBe(true)
    expect(isLikelyDeepSeekOutage(undefined, 429)).toBe(true)
  })

  it('does not treat 4xx (other than 408/429) as outages', () => {
    expect(isLikelyDeepSeekOutage(undefined, 400)).toBe(false)
    expect(isLikelyDeepSeekOutage(undefined, 401)).toBe(false)
    expect(isLikelyDeepSeekOutage(undefined, 403)).toBe(false)
    expect(isLikelyDeepSeekOutage(undefined, 404)).toBe(false)
  })

  it('classifies undici header-timeout errors as outages', () => {
    const error = Object.assign(new Error('Headers Timeout Error'), {
      code: 'UND_ERR_HEADERS_TIMEOUT',
    })
    expect(isLikelyDeepSeekOutage(error)).toBe(true)
  })

  it('classifies common network errors as outages', () => {
    for (const code of [
      'ECONNRESET',
      'ECONNREFUSED',
      'ENOTFOUND',
      'ETIMEDOUT',
    ]) {
      const error = Object.assign(new Error('boom'), { code })
      expect(isLikelyDeepSeekOutage(error)).toBe(true)
    }
  })

  it('classifies AbortError as outage', () => {
    const error = new Error('aborted')
    error.name = 'AbortError'
    expect(isLikelyDeepSeekOutage(error)).toBe(true)
  })

  it('treats generic non-network errors as non-outage', () => {
    expect(isLikelyDeepSeekOutage(new Error('bad json'))).toBe(false)
    expect(isLikelyDeepSeekOutage(undefined)).toBe(false)
    expect(isLikelyDeepSeekOutage('string')).toBe(false)
  })
})
