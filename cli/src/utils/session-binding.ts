import fs from 'fs'
import path from 'path'

import { getConfigDir } from './auth'
import { logger } from './logger'

const SESSION_BINDING_FILE = 'session-binding.json'

interface SessionBinding {
  userId: string
}

const getBindingPath = (): string =>
  path.join(getConfigDir(), SESSION_BINDING_FILE)

/**
 * Persist the session-bound user id to disk so it survives process restarts.
 * Without this, a user could Ctrl-C and restart the CLI to clear the in-memory
 * binding and switch accounts.
 */
export function persistSessionBinding(userId: string): void {
  try {
    fs.mkdirSync(getConfigDir(), { recursive: true })
    fs.writeFileSync(
      getBindingPath(),
      JSON.stringify({ userId } satisfies SessionBinding, null, 2),
    )
  } catch (error) {
    logger.debug(
      { error: error instanceof Error ? error.message : String(error) },
      '[session-binding] Failed to persist binding',
    )
  }
}

/**
 * Read the persisted session-bound user id from disk. Returns null if no
 * binding exists or the file is malformed.
 */
export function readSessionBinding(): string | null {
  try {
    const raw = fs.readFileSync(getBindingPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<SessionBinding>
    if (typeof parsed.userId !== 'string') return null
    return parsed.userId
  } catch {
    return null
  }
}

/**
 * Clear the persisted session binding from disk.
 */
export function clearSessionBinding(): void {
  try {
    if (fs.existsSync(getBindingPath())) {
      fs.unlinkSync(getBindingPath())
    }
  } catch (error) {
    logger.debug(
      { error: error instanceof Error ? error.message : String(error) },
      '[session-binding] Failed to clear binding',
    )
  }
}
