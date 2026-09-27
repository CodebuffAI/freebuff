import { describe, test, expect, mock, afterAll } from 'bun:test'
import * as realOs from 'node:os'
import * as realMachineId from 'node-machine-id'
import * as realSi from 'systeminformation'

// Issue #1374: Bun's os.cpus() throws 'Failed to get CPU information' on ARM
// Linux when /proc/stat and /proc/cpuinfo disagree. Under proot-distro that
// disagreement is permanent, not a hotplug window: it binds a hardcoded 8-core
// /proc/stat (sysdata.py, _FAKE_STAT) while /proc/cpuinfo stays live, so on a
// 9-core device the guest sees 8 vs 9 for the life of the container.
//
// The guard is asserted on calculateFingerprint()'s return value rather than on
// log output. That keeps the test to three module mocks, all of them external
// packages, and it still distinguishes the bug precisely: before the second
// call site was guarded the result was a legacy fingerprint, and a legacy
// fingerprint is exactly what a throw escaping the guard looks like.
//
// Only node:os, node-machine-id and systeminformation are mocked. Mocking the
// local ./logger or ./analytics would be more invasive and leaks into sibling
// test files -- bun runs them all in one process and mock.module() is not
// undone by mock.restore().

const realCpus = realOs.cpus
const realNetworkInterfaces = realOs.networkInterfaces
const realOsModule = { ...realOs }
const realMachineIdFn = realMachineId.machineId
const realSiSystem = realSi.system
const realSiCpu = realSi.cpu
const realSiOsInfo = realSi.osInfo

const CPU_BREAK = 'Failed to get CPU information'

function mockOsCpus(cpusThrows: boolean) {
  mock.module('node:os', () => ({
    ...realOsModule,
    cpus: () => {
      if (cpusThrows) throw new Error(CPU_BREAK)
      return [{ model: 'Fake CPU' }]
    },
  }))
}

function mockSystemInformation(cpusThrows: boolean) {
  mock.module('node-machine-id', () => ({
    machineId: async () => 'test-machine-id-0001',
  }))
  mock.module('systeminformation', () => ({
    system: async () => ({
      manufacturer: 'Test',
      model: 'Test',
      serial: 'SN',
      uuid: 'UUID',
    }),
    osInfo: async () => ({
      platform: 'linux',
      distro: 'Test',
      arch: 'arm64',
      hostname: 'test',
    }),
    cpu: async () => {
      if (cpusThrows) throw new Error(CPU_BREAK)
      return { manufacturer: 'Test', brand: 'Test', cores: 1, physicalCores: 1 }
    },
  }))
}

afterAll(() => {
  mock.module('node:os', () => ({
    ...realOsModule,
    cpus: realCpus,
    networkInterfaces: realNetworkInterfaces,
  }))
  mock.module('node-machine-id', () => ({ ...realMachineId, machineId: realMachineIdFn }))
  mock.module('systeminformation', () => ({
    ...realSi,
    system: realSiSystem,
    cpu: realSiCpu,
    osInfo: realSiOsInfo,
  }))
})

// The cache-busting query gives a fresh module instance per case. fingerprint.ts
// memoises systeminformation in a module-level variable, so a plain re-import
// would reuse the mocks installed by whichever case ran first.
async function calculateFingerprintWith(cpusThrows: boolean) {
  mockOsCpus(cpusThrows)
  mockSystemInformation(cpusThrows)
  const mod = await import(`../fingerprint?case=${cpusThrows ? 'skew' : 'ok'}`)
  return mod.calculateFingerprint()
}

describe('fingerprint CPU guard (#1374)', () => {
  describe('when os.cpus() throws', () => {
    test('resolves instead of rejecting', async () => {
      const id = await calculateFingerprintWith(true)
      expect(typeof id).toBe('string')
      expect(id.length).toBeGreaterThan(0)
    })

    test('keeps the enhanced fingerprint rather than falling back to legacy', async () => {
      const id = await calculateFingerprintWith(true)
      expect(id.startsWith('enhanced-')).toBe(true)
    })
  })

  describe('when os.cpus() works', () => {
    test('still produces an enhanced fingerprint', async () => {
      const id = await calculateFingerprintWith(false)
      expect(id.startsWith('enhanced-')).toBe(true)
    })
  })
})
