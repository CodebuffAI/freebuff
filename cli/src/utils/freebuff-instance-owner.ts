import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'

import { getConfigDir } from './auth'
import { freebuffCliAttemptId } from './freebuff-session-identity'
import { isProcessAlive } from './freebuff-session-relaunch'
import { logger } from './logger'

interface FreebuffInstanceOwner {
  instanceId: string
  pid: number
  /** Absent in records written before 0.0.201 (e.g. 0.0.196). */
  tokenKey?: string
}

const tokenKey = (token: string) =>
  createHash('sha256').update(token).digest('hex')

const OWNER_FILE = 'freebuff-instance-owner.json'

const getOwnerPath = (): string => path.join(getConfigDir(), OWNER_FILE)

function readOwner(): FreebuffInstanceOwner | null {
  try {
    const raw = fs.readFileSync(getOwnerPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<FreebuffInstanceOwner>
    if (
      typeof parsed.instanceId !== 'string' ||
      typeof parsed.pid !== 'number'
    ) {
      return null
    }
    return {
      instanceId: parsed.instanceId,
      pid: parsed.pid,
      ...(typeof parsed.tokenKey === 'string'
        ? { tokenKey: parsed.tokenKey }
        : {}),
    }
  } catch {
    return null
  }
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function recordFreebuffInstanceOwner(
  instanceId: string,
  token?: string,
): void {
  try {
    fs.mkdirSync(getConfigDir(), { recursive: true })
    fs.writeFileSync(
      getOwnerPath(),
      JSON.stringify(
        {
          instanceId,
          pid: process.pid,
          ...(token ? { tokenKey: tokenKey(token) } : {}),
        },
        null,
        2,
      ),
    )
  } catch (error) {
    logger.debug(
      { error: error instanceof Error ? error.message : String(error) },
      '[freebuff-session] Failed to record local owner',
    )
  }
}

export function isFreebuffInstanceOwnedByDeadLocalProcess(
  instanceId: string,
): boolean {
  const owner = readOwner()
  if (!owner || owner.instanceId !== instanceId) return false
  return !isProcessRunning(owner.pid)
}

/**
 * The legacy (single-session) hour a dead local CLI left behind, if any.
 *
 * CLI 0.0.196 and earlier hold every session on the legacy protocol and record
 * it here. When an old launcher's update restart replaces such a binary with a
 * multi-session one, no `cli:` handoff or crash record exists, so without this
 * the new binary would show the picker and sell a second hour while the first
 * sits unused on the server. Only a candidate: the caller must still confirm
 * with an authenticated legacy GET that this account holds exactly this
 * instance, active.
 *
 * Refuses `cli:` ids (those resume through their own records), a live or
 * unknowable owner (only ESRCH counts as dead), this process, and a record
 * that names a different account.
 */
export function deadLegacyFreebuffOwner(token: string): string | undefined {
  const owner = readOwner()
  if (!owner || !owner.instanceId || freebuffCliAttemptId(owner.instanceId))
    return undefined
  if (owner.tokenKey !== undefined && owner.tokenKey !== tokenKey(token))
    return undefined
  if (
    !Number.isInteger(owner.pid) ||
    owner.pid <= 0 ||
    owner.pid === process.pid ||
    isProcessAlive(owner.pid)
  )
    return undefined
  return owner.instanceId
}

/** The recorded hour is over (ended, expired, or not this account's): stop
 *  offering it to later launches. Leaves a record naming anything else. */
export function forgetFreebuffInstanceOwner(instanceId: string): void {
  if (readOwner()?.instanceId !== instanceId) return
  try {
    fs.unlinkSync(getOwnerPath())
  } catch {
    // Already gone.
  }
}
