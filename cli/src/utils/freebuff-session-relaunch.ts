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
