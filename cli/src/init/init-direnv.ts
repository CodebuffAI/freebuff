/**
 * Direnv initialization - loads environment variables from .envrc at CLI startup.
 */

import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { logger } from '../utils/logger'

/**
 * Search up the directory tree for .envrc, stopping at git root.
 * @internal
 */
export function findEnvrcDirectory(startDir: string): string | null {
  let currentDir = path.resolve(startDir)
  const root = path.parse(currentDir).root

  while (currentDir !== root) {
    // Read directory entries once and check for both .envrc and .git
    let entries: string[]
    try {
      entries = fs.readdirSync(currentDir)
    } catch {
      // Directory not readable - stop searching
      break
    }

    const hasEnvrc = entries.includes('.envrc')
    const hasGit = entries.includes('.git')

    if (hasEnvrc) {
      return currentDir
    }

    // If this is a git root and no .envrc found, stop searching
    if (hasGit) {
      break
    }

    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) break
    currentDir = parentDir
  }

  return null
}

/** @internal */
export function isDirenvAvailable(): boolean {
  if (os.platform() === 'win32') {
    return false
  }

  try {
    const result = spawnSync('sh', ['-c', 'command -v direnv'], {
      encoding: 'utf-8',
      timeout: 2000,
    })
    return result.status === 0 && result.stdout.trim().length > 0
  } catch {
    return false
  }
}

/** @internal */
export function getDirenvExport(envrcDir: string): Record<string, string | null> | null {
  try {
    const result = spawnSync('direnv', ['export', 'json'], {
      cwd: envrcDir,
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env, DIRENV_LOG_FORMAT: '' },
    })

    if (result.status !== 0) {
      if (result.stderr?.includes('is blocked')) {
        logger.warn(
          'direnv: .envrc is blocked. Run `direnv allow` to enable.',
        )
      }
      return null
    }

    const output = result.stdout.trim()
    if (!output) {
      return null
    }

    const envVars = JSON.parse(output) as Record<string, string | null>
    return envVars
  } catch (error) {
    logger.debug(
      { error: error instanceof Error ? error.message : String(error) },
      'Failed to run direnv export',
    )
    return null
  }
}

/**
 * Variables a repository's `.envrc` may NOT set on the CLI's own process.
 *
 * The direnv import exists so the agent's terminal commands see the user's
 * project environment. But it runs at startup, into the same `process.env`
 * the CLI and SDK read their own configuration from — so a cloned repo could
 * point the launcher's binary download and the credential-bearing API plane
 * at another host (`NEXT_PUBLIC_CODEBUFF_APP_URL`, the F-2 / Chain F vector
 * in the September assessment), trust its own registry publisher
 * (`CODEBUFF_TRUSTED_AGENT_PUBLISHERS`), pick which binary the launcher
 * installs (`OVERRIDE_*`), preload code into Node (`NODE_OPTIONS`), or make a
 * MITM proxy trusted (`NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`).
 * `direnv allow` is consent to the repo's env for the repo's tooling, not to
 * reconfigure the agent that is about to run in it. Anything matching here is
 * dropped from the import and named in one warning; the user's real shell
 * environment is untouched, so setting these deliberately still works.
 *
 * Prefix matches are deliberate: every product/env knob in `sdk/src/types/env.ts`
 * and `cli/src/utils/env.ts` lives under one of these prefixes, and a new knob
 * must not need a new entry here to be protected.
 * @internal
 */
export const STEERING_ENV_VAR_PATTERNS: readonly RegExp[] = [
  /^CODEBUFF_/,
  /^FREEBUFF_/,
  /^NEXT_PUBLIC_/,
  /^OVERRIDE_(TARGET|PLATFORM|ARCH)$/,
  /^NODE_OPTIONS$/,
  /^NODE_EXTRA_CA_CERTS$/,
  /^NODE_TLS_REJECT_UNAUTHORIZED$/,
  /^SSL_CERT_(FILE|DIR)$/,
  /^BUN_(CONFIG|OPTIONS|INSTALL)/,
  /^LD_(PRELOAD|LIBRARY_PATH)$/,
  /^DYLD_/,
]

/** @internal */
export function isSteeringEnvVar(key: string): boolean {
  return STEERING_ENV_VAR_PATTERNS.some((re) => re.test(key))
}

/** Load direnv environment into process.env. Safe to call even if direnv is not installed. */
export function initializeDirenv(): void {
  if (!isDirenvAvailable()) {
    return
  }

  const envrcDir = findEnvrcDirectory(process.cwd())
  if (!envrcDir) {
    return
  }

  const envVars = getDirenvExport(envrcDir)
  if (!envVars) {
    return
  }
  let appliedCount = 0
  const dropped: string[] = []
  for (const [key, value] of Object.entries(envVars)) {
    if (isSteeringEnvVar(key)) {
      dropped.push(key)
      continue
    }
    if (value === null) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
    appliedCount++
  }

  if (dropped.length > 0) {
    logger.warn(
      { envrcDir, dropped },
      `direnv: ignored ${dropped.length} variable(s) from .envrc that would reconfigure the CLI itself (${dropped.join(', ')}). Set them in your shell instead.`,
    )
  }

  if (appliedCount > 0) {
    logger.debug(
      { envrcDir, variableCount: appliedCount },
      'Loaded environment variables from direnv',
    )
  }
}
