import fs from 'fs'
import os from 'os'
import path from 'path'

import { env } from '@codebuff/common/env'

import { getCliEnv } from './env'

/**
 * Resolve the on-disk config directory for the CLI.
 *
 * Lives in its own module (depending only on `env`) so that low-level helpers
 * — e.g. the persistent analytics id — can read the config dir without pulling
 * in `auth.ts`, which transitively imports the logger and analytics and would
 * otherwise create an import cycle.
 */
export const getConfigDir = (): string => {
  const configuredDir = getCliEnv().FREEBUFF_CONFIG_DIR
  if (configuredDir) {
    if (!path.isAbsolute(configuredDir)) {
      throw new Error(
        'FREEBUFF_CONFIG_DIR must be an absolute path so CLI settings cannot be written relative to the current project.',
      )
    }
    return configuredDir
  }

  return path.join(
    os.homedir(),
    '.config',
    'manicode' +
      // on a development stack?
      (env.NEXT_PUBLIC_CB_ENVIRONMENT !== 'prod'
        ? `-${env.NEXT_PUBLIC_CB_ENVIRONMENT}`
        : ''),
  )
}

/** Owner-only, matching the mode `auth.ts` creates the directory with. */
const CONFIG_DIR_MODE = 0o700

/**
 * Best-effort: clamp an existing config directory to owner-only.
 *
 * `mkdir` applies its mode only when it creates the directory, so a config
 * dir first created by something other than login (prompt history, a chat
 * directory, an older CLI) can be 0755, leaving transcripts, run state and
 * prompt history under it readable by other users on a shared host. Run once
 * at startup. Does not create the directory. Skipped on Windows, where POSIX
 * mode bits do not apply. Never throws.
 */
export const tightenConfigDirMode = (configDir?: string): void => {
  if (process.platform === 'win32') return
  try {
    // Resolved inside the try: a relative FREEBUFF_CONFIG_DIR throws here.
    const dir = configDir ?? getConfigDir()
    const stat = fs.statSync(dir, { throwIfNoEntry: false })
    if (!stat?.isDirectory()) return
    if ((stat.mode & 0o777) !== CONFIG_DIR_MODE) {
      fs.chmodSync(dir, CONFIG_DIR_MODE)
    }
  } catch {
    // Not ours to fail startup over (e.g. a directory owned by another user).
  }
}
