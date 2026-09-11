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
