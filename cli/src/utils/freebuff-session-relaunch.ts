import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { getConfigDir } from './auth'
import { getCliEnv } from './env'
import { freebuffCliAttemptId } from './freebuff-session-identity'

type Handoff = { instanceId: string; model: string }
const tokenKey = (token: string) =>
  createHash('sha256').update(token).digest('hex')
function handoffPath(): string | undefined {
  const pid = getCliEnv().CODEBUFF_LAUNCHER_PID
  return pid && /^[1-9]\d*$/.test(pid)
    ? path.join(getConfigDir(), `freebuff-relaunch-${pid}.json`)
    : undefined
}

/** A launcher survives its update restart, unlike the child CLI. Scope the
 * handoff to that launcher so another terminal cannot inherit its purchase. */
export function saveFreebuffSessionForRelaunch(
  handoff: Handoff,
  token: string,
): boolean {
  const file = handoffPath()
  if (!file) return false
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...handoff,
        tokenKey: tokenKey(token),
        savedAt: Date.now(),
      }),
      { mode: 0o600 },
    )
    return true
  } catch {
    return false
  }
}

export function consumeFreebuffSessionRelaunch(
  token: string,
): Handoff | undefined {
  const file = handoffPath()
  if (!file) return undefined
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (
      value.tokenKey === tokenKey(token) &&
      typeof value.savedAt === 'number' &&
      Date.now() - value.savedAt >= 0 &&
      Date.now() - value.savedAt < 120_000 &&
      typeof value.instanceId === 'string' &&
      freebuffCliAttemptId(value.instanceId) &&
      typeof value.model === 'string'
    )
      return { instanceId: value.instanceId, model: value.model }
  } catch {
    // Missing/stale handoffs are ordinary startup, never an account-wide search.
  } finally {
    try {
      fs.unlinkSync(file)
    } catch {}
  }
  return undefined
}

// ---------------------------------------------------------------- crash recovery
//
// The handoff above only exists when the launcher asked for the restart. A
// crash (or a closed terminal, or a kill) skips it, so the next launch minted a
// fresh claim and bought a second hour while the first sat unused on the
// server until expiry. Each live multi-session CLI therefore keeps one record
// of the hour it holds, named by its own PID. A later launch on the same
// account may resume a record ONLY when that PID is no longer running, the
// hour has not expired, and no live CLI holds the same instance. The claim is
// an atomic rename, so two terminals opened together cannot both resume it.

type LiveRecord = Handoff & {
  tokenKey: string
  ownerPid: number
  expiresAt: number
}

const LIVE_PREFIX = 'freebuff-live-'

function livePath(pid: number): string {
  return path.join(getConfigDir(), `${LIVE_PREFIX}${pid}.json`)
}

/** Treat only "no such process" as dead: any other answer (EPERM, an
 *  unsupported platform) keeps the record, which costs at worst a new hour. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== 'ESRCH'
  }
}

export function recordLiveFreebuffSession(
  session: Handoff & { expiresAt: string },
  token: string,
): void {
  const expiresAt = Date.parse(session.expiresAt)
  if (!freebuffCliAttemptId(session.instanceId) || !Number.isFinite(expiresAt))
    return
  try {
    fs.mkdirSync(getConfigDir(), { recursive: true })
    const record: LiveRecord = {
      instanceId: session.instanceId,
      model: session.model,
      tokenKey: tokenKey(token),
      ownerPid: process.pid,
      expiresAt,
    }
    fs.writeFileSync(livePath(process.pid), JSON.stringify(record), {
      mode: 0o600,
    })
  } catch {
    // Best effort: without a record a crash costs a new hour, as before.
  }
}

/** This process no longer holds a resumable hour (ended, released, switched). */
export function forgetLiveFreebuffSession(): void {
  try {
    fs.unlinkSync(livePath(process.pid))
  } catch {}
}

function readLiveRecords(): Array<{ file: string; record: LiveRecord }> {
  let names: string[]
  try {
    names = fs.readdirSync(getConfigDir())
  } catch {
    return []
  }
  const records: Array<{ file: string; record: LiveRecord }> = []
  for (const name of names) {
    if (!name.startsWith(LIVE_PREFIX) || !name.endsWith('.json')) continue
    const file = path.join(getConfigDir(), name)
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (
        typeof value.instanceId === 'string' &&
        freebuffCliAttemptId(value.instanceId) &&
        typeof value.model === 'string' &&
        typeof value.tokenKey === 'string' &&
        Number.isInteger(value.ownerPid) &&
        typeof value.expiresAt === 'number'
      )
        records.push({ file, record: value as LiveRecord })
    } catch {}
  }
  return records
}

/**
 * Resume the unexpired hour a crashed CLI on this account left behind, if any.
 * Expired records whose owner is gone are deleted on the way.
 */
export function consumeCrashedFreebuffSession(
  token: string,
  now = Date.now(),
): Handoff | undefined {
  const key = tokenKey(token)
  const records = readLiveRecords()
  const alive = new Map<number, boolean>()
  const aliveOf = (pid: number) => {
    if (!alive.has(pid))
      alive.set(pid, pid === process.pid || isProcessAlive(pid))
    return alive.get(pid)!
  }
  const heldByLiveOwner = new Set(
    records
      .filter(({ record }) => aliveOf(record.ownerPid))
      .map(({ record }) => record.instanceId),
  )
  const candidates = records
    .filter(({ file, record }) => {
      if (aliveOf(record.ownerPid)) return false
      if (record.expiresAt <= now) {
        try {
          fs.unlinkSync(file)
        } catch {}
        return false
      }
      return (
        record.tokenKey === key && !heldByLiveOwner.has(record.instanceId)
      )
    })
    // The most recently bought hour has the most time left.
    .sort((a, b) => b.record.expiresAt - a.record.expiresAt)
  for (const { file, record } of candidates) {
    const claimed = `${file}.claimed-${process.pid}`
    try {
      fs.renameSync(file, claimed)
    } catch {
      continue // another launch won this record
    }
    try {
      fs.unlinkSync(claimed)
    } catch {}
    forgetDeadRecordsFor(record.instanceId, aliveOf)
    return { instanceId: record.instanceId, model: record.model }
  }
  return undefined
}

/** A resumed instance must not stay resumable through another dead record. */
function forgetDeadRecordsFor(
  instanceId: string,
  aliveOf: (pid: number) => boolean = isProcessAlive,
): void {
  for (const { file, record } of readLiveRecords()) {
    if (record.instanceId === instanceId && !aliveOf(record.ownerPid)) {
      try {
        fs.unlinkSync(file)
      } catch {}
    }
  }
}

/** After an update handoff resumes an instance, the dead parent's record of the
 *  same instance must not let a third terminal resume it too. */
export function forgetCrashRecordsFor(instanceId: string): void {
  forgetDeadRecordsFor(instanceId)
}
