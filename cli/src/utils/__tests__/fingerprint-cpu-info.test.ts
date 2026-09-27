import { describe, expect, test } from 'bun:test'

import { canReadCpuDetails, getSystemInfo } from '../fingerprint'

import type { CpuInfo } from 'node:os'

// CodebuffAI/freebuff#1374: under proot-distro (Termux) /proc/stat is a
// hardcoded 8-core file while /proc/cpuinfo is live, so on a 9-core phone
// Bun's native CPU read throws `Failed to get CPU information` every time.
const CPU_ERROR = 'Failed to get CPU information'

/**
 * Mirrors Bun's lazy `os.cpus()`: the array itself (and its length) is fine,
 * the throw only happens on the first `.model`/`.speed`/`.times` access.
 */
function skewedCpus(count = 9): CpuInfo[] {
  return Array.from({ length: count }, () => {
    const fail = (): never => {
      throw new Error(CPU_ERROR)
    }
    return {
      get model() {
        return fail()
      },
      get speed() {
        return fail()
      },
      get times() {
        return fail()
      },
    } as unknown as CpuInfo
  })
}

function healthyCpus(count = 4): CpuInfo[] {
  return Array.from({ length: count }, () => ({
    model: 'Cortex-X3',
    speed: 2900,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
  }))
}

/**
 * Fake systeminformation whose `cpu()` behaves like the real Linux path in
 * systeminformation 5.33 (lib/cpu.js): it reads `os.cpus()[0].model` inside
 * `process.nextTick`, where a throw bypasses every caller try/catch.
 */
function fakeSystemInformation(readCpus: () => CpuInfo[]) {
  const calls = { cpu: 0 }
  const si = {
    system: async () => ({
      manufacturer: 'Google',
      model: 'Pixel 8 Pro',
      serial: 'SN',
      uuid: 'UUID',
    }),
    osInfo: async () => ({
      platform: 'linux',
      distro: 'Debian',
      arch: 'arm64',
      hostname: 'localhost',
    }),
    cpu: () => {
      calls.cpu++
      return new Promise((resolve) => {
        process.nextTick(() => {
          const model = readCpus()[0]!.model
          resolve({
            manufacturer: 'ARM',
            brand: model,
            cores: readCpus().length,
            physicalCores: readCpus().length,
          })
        })
      })
    },
  }
  return { si: si as never, calls }
}

describe('canReadCpuDetails', () => {
  test('false when reading CPU details throws', () => {
    expect(canReadCpuDetails(skewedCpus)).toBe(false)
  })

  test('false when os.cpus() itself throws', () => {
    expect(
      canReadCpuDetails(() => {
        throw new Error(CPU_ERROR)
      }),
    ).toBe(false)
  })

  test('true on a healthy machine and on the real runtime', () => {
    expect(canReadCpuDetails(healthyCpus)).toBe(true)
    expect(canReadCpuDetails()).toBe(true)
  })
})

describe('getSystemInfo with skewed /proc (#1374)', () => {
  test('skips systeminformation.cpu() and keeps the rest of the fingerprint', async () => {
    const { si, calls } = fakeSystemInformation(skewedCpus)

    const info = await getSystemInfo({ load: async () => si, readCpus: skewedCpus })

    // Calling cpu() would throw inside process.nextTick and kill the process.
    expect(calls.cpu).toBe(0)
    expect(info.cpu).toEqual({
      manufacturer: '',
      brand: '',
      cores: 9,
      physicalCores: 0,
    })
    expect(info.system.model).toBe('Pixel 8 Pro')
    expect(info.os.distro).toBe('Debian')
  })

  test('falls back to availableParallelism when os.cpus() itself throws', async () => {
    const throwingCpus = (): CpuInfo[] => {
      throw new Error(CPU_ERROR)
    }
    const { si, calls } = fakeSystemInformation(throwingCpus)

    const info = await getSystemInfo({ load: async () => si, readCpus: throwingCpus })

    expect(calls.cpu).toBe(0)
    expect(info.cpu.cores).toBeGreaterThan(0)
    expect(info.system.model).toBe('Pixel 8 Pro')
  })

  test('still uses systeminformation.cpu() when CPU details are readable', async () => {
    const { si, calls } = fakeSystemInformation(healthyCpus)

    const info = await getSystemInfo({ load: async () => si, readCpus: healthyCpus })

    expect(calls.cpu).toBe(1)
    expect(info.cpu).toEqual({
      manufacturer: 'ARM',
      brand: 'Cortex-X3',
      cores: 4,
      physicalCores: 4,
    })
  })
})
