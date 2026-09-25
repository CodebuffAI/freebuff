import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as auth from '../auth'
import {
  consumeCrashedFreebuffSession,
  forgetCrashRecordsFor,
  isProcessAlive,
  recordLiveFreebuffSession,
} from '../freebuff-session-relaunch'

let configDir: string
let configSpy: ReturnType<typeof spyOn>
const deadPid = () => Bun.spawnSync(['true']).pid
const key = (token: string) => createHash('sha256').update(token).digest('hex')
const hour = () => Date.now() + 3_600_000

function writeRecord(
  pid: number,
  fields: Partial<{
    instanceId: string
    model: string
    token: string
    expiresAt: number
  }> = {},
) {
  writeFileSync(
    join(configDir, `freebuff-live-${pid}.json`),
    JSON.stringify({
      instanceId: fields.instanceId ?? 'cli:held',
      model: fields.model ?? 'mimo/mimo-v2.5',
      tokenKey: key(fields.token ?? 'account-a'),
      ownerPid: pid,
      expiresAt: fields.expiresAt ?? hour(),
    }),
  )
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'cli-crash-recovery-'))
  configSpy = spyOn(auth, 'getConfigDir').mockReturnValue(configDir)
})
afterEach(() => {
  configSpy.mockRestore()
  rmSync(configDir, { recursive: true, force: true })
})

test('a dead owner on the same account resumes its unexpired hour once', () => {
  writeRecord(deadPid())
  expect(consumeCrashedFreebuffSession('account-a')).toEqual({
    instanceId: 'cli:held',
    model: 'mimo/mimo-v2.5',
  })
  // single-use: a second terminal opened at the same time buys its own hour
  expect(consumeCrashedFreebuffSession('account-a')).toBeUndefined()
  expect(readdirSync(configDir)).toEqual([])
})

test('a running CLI is never resumed from under itself', () => {
  const child = Bun.spawn(['sleep', '5'])
  try {
    writeRecord(child.pid)
    expect(isProcessAlive(child.pid)).toBe(true)
    expect(consumeCrashedFreebuffSession('account-a')).toBeUndefined()
    expect(existsSync(join(configDir, `freebuff-live-${child.pid}.json`))).toBe(
      true,
    )
  } finally {
    child.kill()
  }
})

test('another account cannot resume the hour', () => {
  writeRecord(deadPid(), { token: 'account-a' })
  expect(consumeCrashedFreebuffSession('account-b')).toBeUndefined()
})

test('an expired hour is not resumed and its record is cleaned up', () => {
  const pid = deadPid()
  writeRecord(pid, { expiresAt: Date.now() - 1 })
  expect(consumeCrashedFreebuffSession('account-a')).toBeUndefined()
  expect(existsSync(join(configDir, `freebuff-live-${pid}.json`))).toBe(false)
})

test('an instance a live CLI already holds is not resumed through a stale record', () => {
  // update restart: the dead parent's record and the live child's share one id
  writeRecord(deadPid(), { instanceId: 'cli:shared' })
  writeRecord(process.pid, { instanceId: 'cli:shared' })
  expect(consumeCrashedFreebuffSession('account-a')).toBeUndefined()
})

test('an update handoff retires the dead parent record of the same instance', () => {
  const pid = deadPid()
  writeRecord(pid, { instanceId: 'cli:handed-off' })
  forgetCrashRecordsFor('cli:handed-off')
  expect(existsSync(join(configDir, `freebuff-live-${pid}.json`))).toBe(false)
})

test('the newest of several crashed hours is resumed first', () => {
  writeRecord(deadPid(), { instanceId: 'cli:older', expiresAt: hour() - 60_000 })
  writeRecord(deadPid(), { instanceId: 'cli:newer' })
  expect(consumeCrashedFreebuffSession('account-a')?.instanceId).toBe(
    'cli:newer',
  )
})

test('only CLI multi-session claims are recorded', () => {
  recordLiveFreebuffSession(
    { instanceId: 'legacy-id', model: 'm', expiresAt: new Date(hour()).toISOString() },
    'account-a',
  )
  expect(readdirSync(configDir)).toEqual([])
  recordLiveFreebuffSession(
    { instanceId: 'cli:x', model: 'm', expiresAt: new Date(hour()).toISOString() },
    'account-a',
  )
  expect(readdirSync(configDir)).toEqual([`freebuff-live-${process.pid}.json`])
})
