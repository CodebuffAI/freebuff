/**
 * Persistent opaque identity for a local Git project.
 *
 * This runs from project selection, not any ad request. The marker provides a
 * stable server key for remote-less projects while keeping the local path on
 * the device. A later sponsored capability inspection only reads it.
 */
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { repoFullNameFromRemote } from '@codebuff/common/ads/sponsored-proposal-target'

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Git resolves worktrees, includes and quoted remote values for us. */
function originRemoteUrl(root: string): string | null {
  try {
    const result = spawnSync('git', ['-C', root, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    })
    return result.status === 0 ? result.stdout.trim() : null
  } catch {
    return null
  }
}

export function ensureSponsoredProjectIdentity(root: string): string | null {
  // A non-project directory (including a home-directory launch) never gets a
  // product marker merely because the CLI started there.
  if (!existsSync(join(root, '.git'))) return null
  // A UUID is only a fallback. Do not dirty a repository when the exact same
  // supported remote identity used by sponsored target resolution is present.
  if (repoFullNameFromRemote(originRemoteUrl(root))) return null
  const directory = join(root, '.freebuff')
  const marker = join(directory, 'project-id')
  try {
    const current = readFileSync(marker, 'utf8').trim().toLowerCase()
    return UUID.test(current) ? current : null
  } catch (error) {
    if (
      !(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      )
    )
      return null
  }
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const identity = randomUUID()
    const temporary = `${marker}.tmp-${randomUUID()}`
    writeFileSync(temporary, `${identity}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    renameSync(temporary, marker)
    return identity
  } catch {
    return null
  }
}
