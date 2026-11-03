import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { createRedactor } from '@codebuff/common/doctor/redact'

import {
  authFindings, binaryFindings, commandsOnPath, historyFindings, installFindings, leftoverFindings, logFindings,
  nodeFindings, shadowingFindings,
} from '../checks'
import { buildDoctorReport, formatDoctorReport, parseDoctorArgs } from '../run-doctor'
import { isDoctorInvocation, runDoctorCommand } from '../index'

const redact = createRedactor({ home: '/nowhere', username: 'nobody' })
const dirs: string[] = []
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-doctor-cli-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

describe('install', () => {
  test('an outdated version and an old npm launcher', () => {
    const found = installFindings({ version: '0.2.30', latest: '0.2.35', launcherVersion: '0.2.10', packageName: 'freebuff' })
    expect(found.map(f => f.id)).toEqual(['install.outdated', 'install.old-launcher'])
    expect(found[0]!.steps.join(' ')).toContain('npm install -g freebuff@latest')
    expect(installFindings({ version: '0.2.35', latest: '0.2.35', launcherVersion: null, packageName: 'freebuff' })[0]!.id).toBe('install.current')
    expect(installFindings({ version: 'dev', latest: '9.9.9', launcherVersion: null, packageName: 'freebuff' })).toEqual([])
  })

  test('an empty or non-executable downloaded binary', async () => {
    const dir = scratch()
    fs.writeFileSync(path.join(dir, 'freebuff'), '')
    expect((await binaryFindings({ configDir: dir, packageName: 'freebuff', platform: 'linux', redact }))[0]!.id).toBe('install.binary-empty')
    fs.writeFileSync(path.join(dir, 'freebuff'), 'binary')
    fs.chmodSync(path.join(dir, 'freebuff'), 0o644)
    expect((await binaryFindings({ configDir: dir, packageName: 'freebuff', platform: 'linux', redact }))[0]!.id).toBe('install.binary-not-executable')
    fs.chmodSync(path.join(dir, 'freebuff'), 0o755)
    const quarantined = await binaryFindings({ configDir: dir, packageName: 'freebuff', platform: 'darwin', redact,
      run: async () => ({ code: 0, stdout: '0081;abc;Safari;', stderr: '' }) })
    expect(quarantined[0]!.id).toBe('install.binary-quarantined')
    expect(await binaryFindings({ configDir: scratch(), packageName: 'freebuff', platform: 'linux', redact })).toEqual([])
  })

  test('two copies on PATH and a repeated PATH entry', () => {
    const a = scratch()
    const b = scratch()
    for (const dir of [a, b]) { fs.writeFileSync(path.join(dir, 'freebuff'), '#!/bin/sh'); fs.chmodSync(path.join(dir, 'freebuff'), 0o755) }
    const onPath = commandsOnPath('freebuff', { PATH: [a, b, a].join(':') }, 'linux')
    expect(onPath).toEqual({ found: [path.join(a, 'freebuff'), path.join(b, 'freebuff')], repeated: 1 })
    expect(shadowingFindings('freebuff', onPath, redact).map(f => f.id)).toEqual(['install.shadowed', 'install.path-repeated'])
  })

  test('replaced engine copies, unfinished downloads, and a download folder whose process is gone', () => {
    const dir = scratch()
    fs.writeFileSync(path.join(dir, 'freebuff.exe.old.1730000000000.0'), 'x'.repeat(1024))
    const part = path.join(dir, '.freebuff-0.2.30-win32-x64.tar.gz.part')
    fs.writeFileSync(part, 'x')
    fs.utimesSync(part, new Date(0), new Date(0))
    fs.mkdirSync(path.join(dir, '.download-temp-4242'))
    fs.mkdirSync(path.join(dir, '.download-temp-1'))
    const found = leftoverFindings({ configDir: dir, now: Date.now(), isAlive: pid => pid === 1 })
    expect(found.map(f => f.id)).toEqual(['install.leftover-copies', 'install.stale-download'])
    expect(found[0]!.detail).toContain('1 replaced copy and 1 unfinished download')
    expect(found[1]!.title).toBe('1 download folder from a process that is gone')
  })

  test('Node too old for the launcher, and several Node installs', async () => {
    const a = scratch()
    const b = scratch()
    for (const dir of [a, b]) fs.writeFileSync(path.join(dir, 'node'), '')
    const found = await nodeFindings({ run: async () => ({ code: 0, stdout: 'v14.21.3\n', stderr: '' }), env: { PATH: `${a}:${b}`, npm_config_registry: 'https://mirror.example/' }, platform: 'linux' })
    expect(found.map(f => f.id)).toEqual(['node.too-old', 'node.several', 'env.npm-registry'])
  })
})

describe('sign-in and history', () => {
  test('missing, damaged, empty, and world-readable credentials, without reading the token into a finding', () => {
    const dir = scratch()
    expect(authFindings({ configDir: dir, platform: 'linux', redact, command: 'freebuff' })[0]!.id).toBe('auth.signed-out')
    const file = path.join(dir, 'credentials.json')
    fs.writeFileSync(file, '{"default": {"authToken": "secret-tok')
    expect(authFindings({ configDir: dir, platform: 'linux', redact, command: 'freebuff' })[0]!.id).toBe('auth.corrupt')
    fs.writeFileSync(file, '{}')
    expect(authFindings({ configDir: dir, platform: 'linux', redact, command: 'freebuff' })[0]!.id).toBe('auth.empty')
    fs.writeFileSync(file, JSON.stringify({ default: { id: 'u', name: 'n', email: 'a@b.c', authToken: 'secret-token-value' } }))
    fs.chmodSync(file, 0o644)
    const found = authFindings({ configDir: dir, platform: 'linux', redact, command: 'freebuff' })
    expect(found.map(f => f.id)).toEqual(['auth.ok', 'auth.permissions'])
    expect(JSON.stringify(found)).not.toContain('secret-token-value')
  })

  test('a recent fatal crash and log signatures from the newest chat log', () => {
    const dir = scratch()
    const chat = path.join(dir, 'projects', 'app', 'chats', '2026-11-01')
    fs.mkdirSync(chat, { recursive: true })
    fs.writeFileSync(path.join(chat, 'log.jsonl'), '{"msg":"request failed: SELF_SIGNED_CERT_IN_CHAIN"}\n{"msg":"my secret prompt"}\n')
    fs.writeFileSync(path.join(dir, 'last-fatal-crash.json'), JSON.stringify({ errorName: 'RangeError', crashedAt: new Date().toISOString(), crashedVersion: '0.2.30' }))
    const history = historyFindings({ configDir: dir, now: Date.now() })
    expect(history.findings.map(f => f.id)).toEqual(['crash.recent'])
    const logs = logFindings(history.newestLog)
    expect(logs.map(f => f.id)).toEqual(['log.tls-intercepted'])
    expect(JSON.stringify(logs)).not.toContain('secret prompt')
  })
})

describe('command', () => {
  test('argument parsing and dispatch', () => {
    expect(isDoctorInvocation(['bun', 'freebuff', 'doctor'])).toBe(true)
    expect(isDoctorInvocation(['bun', 'freebuff', 'login'])).toBe(false)
    expect(parseDoctorArgs(['--markdown', '--full-paths'])).toEqual({ includePaths: true, format: 'markdown', verbose: false })
    expect(parseDoctorArgs(['--help'])).toEqual({ help: true })
  })

  test('a full offline scan builds a report in every format', async () => {
    const configDir = scratch()
    const report = await buildDoctorReport({
      includePaths: false, version: '0.2.35', packageName: 'freebuff', configDir, apiUrl: 'https://api.example.test',
      launcherVersion: null, cwd: configDir, env: {}, platform: 'linux',
      fetch: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) },
      run: async () => ({ code: 1, stdout: '', stderr: '' }),
    })
    expect(report.product).toBe('cli')
    expect(report.findings.some(f => f.id === 'network.unreachable.api')).toBe(true)
    expect(report.findings.some(f => f.id === 'auth.signed-out')).toBe(true)
    const text = formatDoctorReport(report, { includePaths: false, format: 'text', verbose: false }, 'freebuff')
    expect(text).toContain('freebuff doctor --ask')
    expect(formatDoctorReport(report, { includePaths: false, format: 'ask', verbose: false }, 'freebuff')).toContain('Explain what each one means')
    expect(JSON.parse(formatDoctorReport(report, { includePaths: false, format: 'json', verbose: false }, 'freebuff')).version).toBe(1)
    expect(JSON.stringify(report)).not.toContain(configDir)
  })

  test('--help prints usage and exits 0', async () => {
    let out = ''
    const code = await runDoctorCommand({ argv: ['bun', 'freebuff', 'doctor', '--help'], packageName: 'freebuff', version: '0.2.35',
      configDir: scratch(), apiUrl: 'https://api.example.test', launcherVersion: null, write: text => { out += text } })
    expect(code).toBe(0)
    expect(out).toContain('Usage: freebuff doctor')
  })
})
