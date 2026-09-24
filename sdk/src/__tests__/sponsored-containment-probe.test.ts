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
    // COD-642: Windows is the floor arm now, and it is still never probed by
    // EXECUTING anything -- there is no kernel boundary to exercise. With no
    // Windows PowerShell at its system path the floor cannot start, and says
    // so rather than reporting a capability it cannot honour.
    expect(probeSponsoredContainment('win32', dependencies)).toEqual({
      available: false,
      reason: 'containment-probe-failed',
    })
    expect(executions).toBe(0)
  })

  test('native Windows reports the floor when PowerShell is at its system path', () => {
    const asked: string[] = []
    let executions = 0
    expect(
      probeSponsoredContainment('win32', {
        exists: (pathname) => {
          asked.push(pathname)
          return true
        },
        execute: () => {
          executions++
          return true
        },
      }),
    ).toEqual({ containment: 'floor' })
    expect(executions).toBe(0)
    expect(asked).toHaveLength(1)
    expect(asked[0]!.toLowerCase()).toEndWith(
      '\\system32\\windowspowershell\\v1.0\\powershell.exe',
    )
  })
})
