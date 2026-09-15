import { describe, expect, test } from 'bun:test'
import { probeSponsoredContainment } from '../tools/sponsored-sandbox'

describe('sponsored runtime capability probe', () => {
  test('an installed but unusable Linux namespace boundary refuses before an offer', () => {
    const calls: string[][] = []
    const result = probeSponsoredContainment('linux', {
      exists: () => true,
      execute: (command, args) => {
        calls.push([command, ...args])
        return false
      },
    })
    expect(result).toEqual({
      available: false,
      reason: 'containment-probe-failed',
    })
    expect(calls[0]).toContain('--unshare-all')
    expect(calls[0]).toContain('--clearenv')
  })
  test('macOS requires a successful seatbelt execution', () => {
    expect(
      probeSponsoredContainment('darwin', {
        exists: () => true,
        execute: () => false,
      }),
    ).toEqual({ available: false, reason: 'containment-probe-failed' })
    expect(
      probeSponsoredContainment('darwin', {
        exists: () => true,
        execute: () => true,
      }),
    ).toEqual({ available: true, mechanism: 'sandbox-exec' })
  })
  test('missing bwrap and native Windows never attempt uncontained execution', () => {
    let executions = 0
    const dependencies = {
      exists: () => false,
      execute: () => {
        executions++
        return true
      },
    }
    expect(probeSponsoredContainment('linux', dependencies)).toEqual({
      available: false,
      reason: 'bubblewrap-missing',
    })
    expect(probeSponsoredContainment('win32', dependencies)).toEqual({
      available: false,
      reason: 'windows-no-containment',
    })
    expect(executions).toBe(0)
  })
})
