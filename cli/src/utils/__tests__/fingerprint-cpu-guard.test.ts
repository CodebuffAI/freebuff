import { describe, test, expect, mock, afterAll } from 'bun:test'
import * as realOs from 'node:os'
import * as realMachineId from 'node-machine-id'
import * as realSi from 'systeminformation'
import * as realLogger from '../logger'
import * as realAnalytics from '../analytics'
import * as realDetectShell from '../detect-shell'

// Issue #1374: Bun's os.cpus() throws 'Failed to get CPU information' on ARM
// Linux when /proc/stat and /proc/cpuinfo disagree. Under proot-distro that
// disagreement is permanent, not a hotplug window: it binds a hardcoded 8-core
// /proc/stat (sysdata.py, _FAKE_STAT) while /proc/cpuinfo stays live, so on a
// 9-core device the guest sees 8 vs 9 for the life of the container.
//
// These tests pin the guard's behaviour at the public entry point.
//
// Two things about bun's test runner matter here:
//   - all test files share one process, and mock.module() is not undone by
//     mock.restore(), so every module mocked below is restored in afterAll.
//     Without that this file leaks a throwing os.cpus() and a stub logger
//     into whichever file runs next.
//   - re-registering a namespace object is not enough, because the mock
//     replaces entries in place, so the real exports are captured up front.

const realCpus = realOs.cpus
const realNetworkInterfaces = realOs.networkInterfaces
const realOsModule = { ...realOs }
const realMachineIdFn = realMachineId.machineId
const realSiSystem = realSi.system
const realSiCpu = realSi.cpu
const realSiOsInfo = realSi.osInfo

type Logged = { fingerprintType?: string }
const logged: Logged[] = []

const CPU_BREAK = 'Failed to get CPU information'

function installMocks(cpusThrows: boolean) {
  logged.length = 0
  mock.module('node:os', () => ({
    ...realOsModule,
    cpus: () => {
      if (cpusThrows) throw new Error(CPU_BREAK)
      return [{ model: 'Fake CPU' }]
    },
  }))
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
  mock.module('../analytics', () => ({ trackEvent: () => {} }))
  mock.module('../detect-shell', () => ({ detectShell: () => 'bash' }))
  mock.module('../logger', () => ({
    logger: {
      warn: (data: Logged) => logged.push(data),
      debug: () => {},
      info: () => {},
      error: () => {},
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
  mock.module('../logger', () => realLogger)
  mock.module('../analytics', () => realAnalytics)
  mock.module('../detect-shell', () => realDetectShell)
})

async function loadCalculateFingerprint(cpusThrows: boolean) {
  installMocks(cpusThrows)
  const mod = await import('../fingerprint')
  return mod.calculateFingerprint
}

const fingerprintTypes = () =>
  logged.map((l) => l.fingerprintType).filter(Boolean) as string[]

describe('fingerprint CPU guard (#1374)', () => {
  describe('when os.cpus() throws', () => {
    test('calculateFingerprint() resolves instead of rejecting', async () => {
      const calculateFingerprint = await loadCalculateFingerprint(true)
      const id = await calculateFingerprint()
      expect(typeof id).toBe('string')
      expect(id.length).toBeGreaterThan(0)
    })

    test('does not fall back to a legacy fingerprint', async () => {
      const calculateFingerprint = await loadCalculateFingerprint(true)
      const id = await calculateFingerprint()
      expect(id.startsWith('enhanced-')).toBe(true)
    })

    test('guards every os.cpus() call site', async () => {
      const calculateFingerprint = await loadCalculateFingerprint(true)
      await calculateFingerprint()
      const types = fingerprintTypes()
      // pre-check in getCpuInfoSafe()
      expect(types).toContain('cpu_pre_check_failed')
      // runtime.cpuCount in calculateEnhancedFingerprint()
      expect(types).toContain('cpu_count_unavailable')
      // nothing escaped to the legacy fallback
      expect(types).not.toContain('enhanced_failed_fallback')
    })
  })

  describe('when os.cpus() works', () => {
    test('still produces an enhanced fingerprint and logs no guard', async () => {
      const calculateFingerprint = await loadCalculateFingerprint(false)
      const id = await calculateFingerprint()
      expect(id.startsWith('enhanced-')).toBe(true)
      const types = fingerprintTypes()
      expect(types).not.toContain('cpu_pre_check_failed')
      expect(types).not.toContain('cpu_count_unavailable')
    })
  })
})
