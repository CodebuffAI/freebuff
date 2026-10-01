/**
 * Enhanced fingerprinting for CLI authentication.
 *
 * Derives a stable fingerprint from hardware identifiers. Falls back to a
 * random id when the machine id is unavailable.
 */

import { createHash, randomBytes } from 'node:crypto'
import { availableParallelism, cpus, networkInterfaces } from 'node:os'

import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'

import { trackEvent } from './analytics'
import { detectShell } from './detect-shell'
import { logger } from './logger'

import type { CpuInfo } from 'node:os'

// Lazy imports for optional dependencies
let machineIdModule: typeof import('node-machine-id') | null = null
let systeminformationModule: typeof import('systeminformation') | null = null

async function getMachineId(): Promise<string> {
  if (!machineIdModule) {
    machineIdModule = await import('node-machine-id')
  }
  const id = await machineIdModule.machineId()
  // Validate that we got a real machine ID, not an empty or placeholder value.
  // Throwing here triggers the legacy fallback in calculateFingerprint().
  if (!id || id === 'unknown' || id.length < 8) {
    throw new Error('Invalid machine ID returned')
  }
  return id
}

type SystemInformation = Pick<
  typeof import('systeminformation'),
  'system' | 'cpu' | 'osInfo'
>

async function loadSystemInformation(): Promise<SystemInformation> {
  if (!systeminformationModule) {
    systeminformationModule = await import('systeminformation')
  }
  return systeminformationModule
}

/**
 * Whether per-CPU details (model, speed, times) can be read without throwing.
 *
 * Bun's `os.cpus()` is lazy: it returns `hostCpuCount` placeholder objects and
 * only runs the native read on first access to `.model`/`.speed`/`.times`. On
 * Linux that native read throws `Failed to get CPU information` when
 * /proc/stat and /proc/cpuinfo list different CPU counts. proot-distro (Termux)
 * binds a hardcoded 8-core /proc/stat over the real one, so on a 9-core phone
 * the mismatch is permanent (CodebuffAI/freebuff#1374).
 *
 * systeminformation's `cpu()` reads `os.cpus()[0].model` inside a
 * `process.nextTick` callback, where no caller try/catch can reach it: the
 * throw escapes to the process-level handler and kills the CLI. So probe the
 * same read synchronously here, and skip `cpu()` when it throws.
 */
export function canReadCpuDetails(readCpus: () => CpuInfo[] = cpus): boolean {
  try {
    void readCpus()[0]?.model
    return true
  } catch {
    return false
  }
}

/** Logical CPU count that never throws; 0 when no source works. */
function safeCpuCount(readCpus: () => CpuInfo[]): number {
  try {
    return readCpus().length
  } catch {
    try {
      return availableParallelism()
    } catch {
      return 0
    }
  }
}

export async function getSystemInfo({
  load = loadSystemInformation,
  readCpus = cpus,
}: {
  load?: () => Promise<SystemInformation>
  readCpus?: () => CpuInfo[]
} = {}): Promise<{
  system: { manufacturer: string; model: string; serial: string; uuid: string }
  cpu: { manufacturer: string; brand: string; cores: number; physicalCores: number }
  os: { platform: string; distro: string; arch: string; hostname: string }
}> {
  try {
    const si = await load()
    const cpuReadable = canReadCpuDetails(readCpus)
    if (!cpuReadable) {
      logger.warn(
        { fingerprintType: 'cpu_info_unavailable' },
        'CPU details unreadable (os.cpus() throws); fingerprinting without them',
      )
    }
    const [systemInfo, cpuInfo, osInfo] = await Promise.all([
      si.system(),
      cpuReadable
        ? si.cpu()
        : Promise.resolve({
            manufacturer: '',
            brand: '',
            cores: safeCpuCount(readCpus),
            physicalCores: 0,
          }),
      si.osInfo(),
    ])
    return {
      system: {
        manufacturer: systemInfo.manufacturer,
        model: systemInfo.model,
        serial: systemInfo.serial,
        uuid: systemInfo.uuid,
      },
      cpu: {
        manufacturer: cpuInfo.manufacturer,
        brand: cpuInfo.brand,
        cores: cpuInfo.cores,
        physicalCores: cpuInfo.physicalCores,
      },
      os: {
        platform: osInfo.platform,
        distro: osInfo.distro,
        arch: osInfo.arch,
        hostname: osInfo.hostname,
      },
    }
  } catch {
    return {
      system: { manufacturer: '', model: '', serial: '', uuid: '' },
      cpu: { manufacturer: '', brand: '', cores: 0, physicalCores: 0 },
      os: { platform: process.platform, distro: '', arch: process.arch, hostname: '' },
    }
  }
}

/**
 * Generates an enhanced CLI fingerprint using hardware identifiers.
 * This is deterministic - the same machine will always produce the same fingerprint.
 * Throws if machine ID cannot be obtained (to trigger legacy fallback).
 */
async function calculateEnhancedFingerprint(): Promise<string> {
  // getMachineId will throw if it can't get a valid machine ID
  const machineIdValue = await getMachineId()
  
  const [sysInfo, shell, networkInfo] = await Promise.all([
    getSystemInfo(),
    Promise.resolve(detectShell()),
    Promise.resolve(networkInterfaces()),
  ])

  // Extract MAC addresses for additional uniqueness
  const macAddresses = Object.values(networkInfo)
    .flat()
    .filter(
      (iface) =>
        iface && !iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00',
    )
    .map((iface) => iface!.mac)
    .sort()

  const fingerprintInfo = {
    system: sysInfo.system,
    cpu: sysInfo.cpu,
    os: sysInfo.os,
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      shell,
      cpuCount: safeCpuCount(cpus),
    },
    network: {
      macAddresses,
      interfaceCount: Object.keys(networkInfo).length,
    },
    machineId: machineIdValue,
    fingerprintVersion: '2.0',
  }

  const fingerprintString = JSON.stringify(fingerprintInfo)
  const fingerprintHash = createHash('sha256')
    .update(fingerprintString)
    .digest('base64url')

  return `enhanced-${fingerprintHash}`
}

/**
 * Generates a legacy fingerprint with a random suffix.
 * Used as a fallback when enhanced fingerprinting fails.
 */
function calculateLegacyFingerprint(): string {
  const randomSuffix = randomBytes(6).toString('base64url').substring(0, 8)
  return `codebuff-cli-${randomSuffix}`
}

/**
 * Cached fingerprint promise. Populated on first call and reused for the
 * process lifetime so every auth step in a session ships the same fingerprint
 * to the server.
 */
let cachedFingerprintPromise: Promise<string> | null = null

/**
 * Returns the process-wide CLI fingerprint, computing it on first call.
 * Safe to call from multiple places — the first caller wins and the rest
 * await the same promise.
 */
export function getFingerprintId(): Promise<string> {
  if (!cachedFingerprintPromise) {
    cachedFingerprintPromise = calculateFingerprint()
  }
  return cachedFingerprintPromise
}

/**
 * Main fingerprint function.
 * Tries enhanced fingerprinting first, falls back to legacy if it fails.
 */
export async function calculateFingerprint(): Promise<string> {
  try {
    const fingerprint = await calculateEnhancedFingerprint()
    logger.debug(
      {
        fingerprintType: 'enhanced_cli',
        fingerprintId: fingerprint.substring(0, 20) + '...',
      },
      'Enhanced CLI fingerprint generated successfully',
    )
    trackEvent(AnalyticsEvent.FINGERPRINT_GENERATED, {
      fingerprintType: 'enhanced_cli',
      success: true,
    })
    return fingerprint
  } catch (enhancedError) {
    logger.info(
      {
        errorMessage:
          enhancedError instanceof Error ? enhancedError.message : String(enhancedError),
        fingerprintType: 'enhanced_failed_fallback',
      },
      'Enhanced CLI fingerprinting failed, using legacy fallback',
    )

    try {
      const fingerprint = calculateLegacyFingerprint()
      logger.debug(
        {
          fingerprintType: 'legacy_fallback',
          fingerprintId: fingerprint,
        },
        'Legacy fingerprint generated successfully as fallback',
      )
      trackEvent(AnalyticsEvent.FINGERPRINT_GENERATED, {
        fingerprintType: 'legacy',
        success: true,
        fallbackReason:
          enhancedError instanceof Error ? enhancedError.message : 'unknown',
      })
      return fingerprint
    } catch (legacyError) {
      logger.error(
        {
          errorMessage:
            legacyError instanceof Error ? legacyError.message : String(legacyError),
          fingerprintType: 'failed',
        },
        'Both enhanced and legacy fingerprint generation failed',
      )
      throw new Error('Fingerprint generation failed')
    }
  }
}

/**
 * Synchronous fingerprint generation (legacy only).
 * Use this only when async is not possible (e.g., initial state).
 * @deprecated Prefer calculateFingerprint() for hardware-based fingerprinting
 */
export function generateFingerprintIdSync(): string {
  return calculateLegacyFingerprint()
}

/**
 * Detects the fingerprint type from a fingerprint ID.
 */
export function getFingerprintType(
  fingerprintId: string,
): 'enhanced_cli' | 'legacy' | 'unknown' {
  if (fingerprintId.startsWith('enhanced-')) {
    return 'enhanced_cli'
  }
  if (fingerprintId.startsWith('codebuff-cli-') || fingerprintId.startsWith('legacy-')) {
    return 'legacy'
  }
  return 'unknown'
}
