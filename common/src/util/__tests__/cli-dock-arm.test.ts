import { describe, expect, it } from 'bun:test'

import {
  claimDockExpansion,
  dockDwellMs,
  DOCK_COLLAPSE_METHODS,
} from '../../ads/ad-event-hygiene'
import {
  CLI_DOCK_EXPERIMENT_PERCENT,
  CLI_DOCK_EXPERIMENT_SALT,
  DEFAULT_CLI_DOCK_EXPERIMENT,
  FIRST_PARTY_ARM_SALT,
  cliDockArmForUser,
  cliDockArmServed,
} from '../ad-experiment'

describe('cliDockArmForUser', () => {
  it('serves control to everyone while the knob is off, without hashing', () => {
    // `off` must be byte-identical to the pre-COD-457 world, not merely
    // harmless: nobody is assigned, so nothing can be logged as an arm either.
    for (const userId of ['a', 'b', 'c', 'd', 'e']) {
      expect(cliDockArmForUser(userId, 'off')).toBe('control')
    }
    expect(DEFAULT_CLI_DOCK_EXPERIMENT).toBe('off')
  })

  it('is sticky per user', () => {
    const first = cliDockArmForUser('user_123', 'on')
    for (let i = 0; i < 20; i++) {
      expect(cliDockArmForUser('user_123', 'on')).toBe(first)
    }
  })

  it('assigns in shadow so the arm can be sized before it is served', () => {
    const users = Array.from({ length: 400 }, (_, i) => `user_${i}`)
    const expandable = users.filter(
      (u) => cliDockArmForUser(u, 'shadow') === 'expandable',
    ).length
    expect(expandable).toBeGreaterThan(0)
    expect(expandable).toBeLessThan(users.length)
  })

  it('splits roughly at the configured percentage', () => {
    const users = Array.from({ length: 4000 }, (_, i) => `dock_user_${i}`)
    const expandable = users.filter(
      (u) => cliDockArmForUser(u, 'on') === 'expandable',
    ).length
    const share = (expandable / users.length) * 100
    expect(Math.abs(share - CLI_DOCK_EXPERIMENT_PERCENT)).toBeLessThan(5)
  })

  it('parks an anonymous caller on control', () => {
    expect(cliDockArmForUser(null, 'on')).toBe('control')
    expect(cliDockArmForUser(undefined, 'on')).toBe('control')
    expect(cliDockArmForUser('', 'on')).toBe('control')
  })

  it('uses a salt of its own', () => {
    // Sharing a first-party salt would correlate a presentation arm with an
    // inventory arm and make either result unreadable.
    expect(CLI_DOCK_EXPERIMENT_SALT).not.toBe(FIRST_PARTY_ARM_SALT)
    // The retired 2026-08 Imprezia cohort salt; never reuse it.
    expect(CLI_DOCK_EXPERIMENT_SALT).not.toBe('ads_imprezia_primary_2026_08')
  })
})

describe('cliDockArmServed', () => {
  it('renders control in every mode but on', () => {
    expect(cliDockArmServed('expandable', 'off')).toBe('control')
    expect(cliDockArmServed('expandable', 'shadow')).toBe('control')
    expect(cliDockArmServed('expandable', 'on')).toBe('expandable')
    expect(cliDockArmServed('control', 'on')).toBe('control')
  })
})

describe('dock expansion hygiene', () => {
  it('fires one expansion per impUrl per session', () => {
    const fired = new Set<string>()
    expect(claimDockExpansion(fired, 'imp_a')).toBe(true)
    expect(claimDockExpansion(fired, 'imp_a')).toBe(false)
    expect(claimDockExpansion(fired, 'imp_a')).toBe(false)
    expect(claimDockExpansion(fired, 'imp_b')).toBe(true)
  })

  it('refuses to claim an empty impUrl', () => {
    expect(claimDockExpansion(new Set(), '')).toBe(false)
  })

  it('never reports a negative dwell', () => {
    expect(dockDwellMs(1_000, 1_500)).toBe(500)
    expect(dockDwellMs(1_500, 1_000)).toBe(0)
    expect(dockDwellMs(Number.NaN, 1_000)).toBe(0)
  })

  it('names all seven collapse methods', () => {
    expect([...DOCK_COLLAPSE_METHODS].sort()).toEqual([
      'close',
      'esc',
      'gone',
      'key',
      'outside',
      'rotate',
      'send',
    ])
  })
})
