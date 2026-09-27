import { describe, test, expect, mock } from 'bun:test'
import * as realOs from 'node:os'

// Issue #1374: Bun's os.cpus() throws 'Failed to get CPU information' on ARM
// Linux when /proc/stat and /proc/cpuinfo disagree. Under proot-distro that
// disagreement is permanent, not a hotplug window: it binds a hardcoded 8-core
// /proc/stat (sysdata.py, _FAKE_STAT) while /proc/cpuinfo stays live, so on a
// 9-core device the guest sees 8 vs 9 for the life of the container.
//
// These tests pin the guard behaviour at the public entry point. Everything the
// fingerprint module reaches for is mocked so the test is hermetic and does not
// depend on the host's machine id, shell, or analytics transport.

type Logged = { fingerprintType?: string }
const logged: Logged[] = []

function installMocks(cpusThrows: boolean) {
  mock.module('node:os', () => ({
    ...realOs,
    cpus: () => {
      if (cpusThrows) throw new Error('Failed to get CPU information')
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
      if (cpusThrows) {
        throw new Error('Failed to get CPU information')
      }
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

async function loadCalculateFingerprint(cpusThrows: boolean) {
  logged.length = 0
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
