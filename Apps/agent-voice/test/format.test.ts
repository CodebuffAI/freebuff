import { describe, expect, test } from 'bun:test'
import {
  describeEvent,
  formatBytes,
  formatDuration,
  formatExpiry,
  isPro,
  isValidMode,
  isValidTrigger,
  remainingSeconds,
  usageFraction,
} from '../src/lib/format'
import type { StateView } from '../src/lib/types'

function state(overrides: Partial<StateView> = {}): StateView {
  return {
    settings: {
      hotkey: 'CommandOrControl+Shift+Space',
      language: null,
      selected_model: 'base',
      mode_id: null,
      provider: null,
      modes: [],
      snippets: [],
      vocabulary: [],
      worker_url: '',
    },
    entitlement: {
      tier: 'free',
      activated: false,
      key_masked: null,
      expires_at: null,
    },
    usage: { used_seconds: 0, limit_seconds: 1800, day: '2026-10-05' },
    device_id: 'device-1',
    models: [],
    bridge_port: 1234,
    ...overrides,
  }
}

describe('formatDuration', () => {
  test('renders m:ss and h:mm:ss', () => {
    expect(formatDuration(95)).toBe('1:35')
    expect(formatDuration(3675)).toBe('1:01:15')
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(-5)).toBe('0:00')
  })
})

describe('formatBytes', () => {
  test('scales to the right unit', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(142_000_000)).toBe('135 MB')
    expect(formatBytes(1_500)).toBe('1.46 KB')
    expect(formatBytes(1_620_000_000)).toBe('1.51 GB')
  })
})

describe('quota helpers', () => {
  test('remaining seconds never go negative', () => {
    expect(
      remainingSeconds(
        state({ usage: { used_seconds: 600, limit_seconds: 1800, day: 'x' } }),
      ),
    ).toBe(1200)
    expect(
      remainingSeconds(
        state({ usage: { used_seconds: 5000, limit_seconds: 1800, day: 'x' } }),
      ),
    ).toBe(0)
  })

  test('pro is unlimited', () => {
    const pro = state({
      entitlement: {
        tier: 'pro',
        activated: true,
        key_masked: 'PA-1…7890',
        expires_at: null,
      },
      usage: { used_seconds: 9000, limit_seconds: null, day: 'x' },
    })
    expect(remainingSeconds(pro)).toBeNull()
    expect(usageFraction(pro)).toBe(0)
    expect(isPro(pro)).toBe(true)
    expect(isPro(state())).toBe(false)
    expect(isPro(null)).toBe(false)
  })

  test('fraction is clamped to 1', () => {
    expect(
      usageFraction(
        state({ usage: { used_seconds: 900, limit_seconds: 1800, day: 'x' } }),
      ),
    ).toBe(0.5)
    expect(
      usageFraction(
        state({ usage: { used_seconds: 5000, limit_seconds: 1800, day: 'x' } }),
      ),
    ).toBe(1)
  })
})

describe('describeEvent', () => {
  test('covers every phase', () => {
    expect(describeEvent({ phase: 'listening' })).toBe('Listening…')
    expect(
      describeEvent({ phase: 'listening', prompt: 'Which database?' }),
    ).toBe('Agent asks: Which database?')
    expect(describeEvent({ phase: 'processing' })).toBe('Transcribing…')
    expect(describeEvent({ phase: 'done', text: 'hello there' })).toBe(
      'hello there',
    )
    expect(describeEvent({ phase: 'error', error: 'no speech detected' })).toBe(
      'no speech detected',
    )
    expect(describeEvent({ phase: 'blocked', error: 'daily-limit' })).toBe(
      'Daily limit reached',
    )
    expect(
      describeEvent({
        phase: 'blocked',
        error: 'daily-limit',
        remaining_seconds: 95,
      }),
    ).toBe('Daily limit reached — 1:35 left')
  })
})

describe('validation helpers', () => {
  test('triggers need a word', () => {
    expect(isValidTrigger('new line')).toBe(true)
    expect(isValidTrigger('  ')).toBe(false)
    expect(isValidTrigger('two  spaces')).toBe(false)
  })

  test('modes need a name and instructions', () => {
    expect(isValidMode('Terminal', 'lowercase')).toBe(true)
    expect(isValidMode('', 'lowercase')).toBe(false)
    expect(isValidMode('Terminal', '  ')).toBe(false)
  })

  test('expiry renders as a date', () => {
    expect(formatExpiry(null)).toBeNull()
    expect(formatExpiry(1_700_000_000)).toBe('2023-11-14')
  })
})
