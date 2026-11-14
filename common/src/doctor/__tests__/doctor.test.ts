import { describe, expect, test } from 'bun:test'
import { createRedactor } from '../redact'
import { runDoctorChecks } from '../run'
import { doctorAskPrompt, doctorReportMarkdown, doctorReportText, doctorSummary } from '../report'
import { COMMON_LOG_SIGNATURES, logScanFindings, scanLogText } from '../log-signatures'
import { finding, type DoctorReport } from '../types'
import {
  classifyNetworkError, clockFinding, configuredProxies, dnsFindings, endpointFindings, environmentFindings,
  hostsFileEntries, hostsFinding, proxyFindings, readClockSkew, tlsFinding,
} from '../node/network'
import { architectureFinding, diskFinding, longPathFinding, syncProviderFor, watcherLimitFinding } from '../node/system'
import { classifyGitFolder, gitFolderFinding, gitInstallFindings } from '../node/git'

const redact = createRedactor({ home: '/Users/alice', username: 'alice' })

describe('redaction', () => {
  test('paths keep only their last folder, and the home, user and emails go', () => {
    expect(redact.path('/Users/alice/code/my-repo')).toBe('~/…/my-repo')
    expect(redact.path('/srv/projects/app')).toBe('/…/app')
    const text = redact.text('EACCES: open /Users/alice/code/secret-plan/notes.txt for alice (alice@example.com) at https://api.freebuff.com/v1')
    expect(text).not.toContain('secret-plan')
    expect(text).not.toContain('alice')
    expect(text).toContain('<email>')
    expect(text).toContain('https://api.freebuff.com/v1')
  })

  test('Windows paths and secrets are redacted', () => {
    const win = createRedactor({ home: 'C:\\Users\\Bob', username: 'Bob' })
    expect(win.text('EPERM C:\\Users\\Bob\\AppData\\Roaming\\Freebuff\\state.json')).toBe('EPERM ~/…/state.json')
    expect(redact.text('Authorization: Bearer abcdefghijklmnop token=xyz123456')).not.toMatch(/abcdefghijklmnop|xyz123456/)
  })

  test('opting in keeps paths but never secrets', () => {
    const full = createRedactor({ home: '/Users/alice', username: 'alice', includePaths: true })
    expect(full.path('/Users/alice/code/my-repo')).toBe('/Users/alice/code/my-repo')
    expect(full.text('key=sk-abcdefghijklmnopqrstu')).not.toContain('abcdefghijklmnopqrstu')
  })
})

describe('runner', () => {
  test('a slow or throwing check becomes a note, and deep checks wait for the option', async () => {
    const result = await runDoctorChecks([
      { id: 'fast', area: 'system', run: () => [finding('fast.ok', 'ok', 'system', 'fine', '')] },
      { id: 'slow', area: 'network', timeoutMs: 20, run: () => new Promise(() => {}) },
      { id: 'broken', area: 'disk', run: () => { throw new Error('/Users/alice/private') } },
      { id: 'deep', area: 'chats', deep: true, run: () => [finding('deep.ran', 'error', 'chats', 'ran', '')] },
    ], {})
    expect(result.findings.map(f => f.id).sort()).toEqual(['broken.failed', 'fast.ok', 'slow.timeout'])
    expect(JSON.stringify(result.findings)).not.toContain('private')
    expect(result.checks.find(c => c.id === 'deep')?.outcome).toBe('skipped')
    const deep = await runDoctorChecks([{ id: 'deep', area: 'chats', deep: true, run: () => [finding('deep.ran', 'error', 'chats', 'ran', '')] }], {}, { deep: true })
    expect(deep.findings[0]!.id).toBe('deep.ran')
  })
})

const report: DoctorReport = {
  version: 1, product: 'desktop', generatedAt: '2026-11-02T00:00:00.000Z', durationMs: 1234, appVersion: '0.0.199',
  platform: 'darwin', arch: 'arm64', options: { deep: false, includePaths: false }, checks: [{ id: 'slow', ms: 8000, outcome: 'timeout' }],
  findings: [
    finding('clock.skew', 'warning', 'clock', "Your computer's clock is 70 s ahead", 'Set your clock.', ['Open settings.']),
    finding('disk.ok', 'ok', 'disk', 'Enough disk space', '50 GB free.'),
  ],
}

describe('report', () => {
  test('Markdown lists problems with steps, then what passed', () => {
    const md = doctorReportMarkdown(report)
    expect(md).toContain('### Warning: Your computer\'s clock is 70 s ahead')
    expect(md).toContain('1. Open settings.')
    expect(md).toContain('### Passed')
    expect(md).toContain('slow (timeout)')
    expect(doctorSummary(report)).toBe('1 warning found.')
    expect(doctorReportText(report)).toContain('[WARNING]')
    expect(doctorAskPrompt(report)).toContain(md)
  })
})

describe('log signatures', () => {
  test('counts known failures without quoting the lines', () => {
    const log = [
      'Error: SQLITE_CORRUPT: database disk image is malformed at /Users/alice/x.db',
      'fatal: detected dubious ownership in repository at /Users/alice/repo',
      'Error: ENOSPC: no space left on device',
      'request failed: SELF_SIGNED_CERT_IN_CHAIN',
      'Bun crashed: SIGILL',
      'Error: EBUSY: resource busy or locked',
      'Error: ENOSPC: no space left on device',
    ].join('\n')
    const findings = logScanFindings(scanLogText(log, COMMON_LOG_SIGNATURES), 'the engine log')
    const ids = findings.map(f => f.id)
    expect(ids).toEqual(expect.arrayContaining(['log.sqlite-corrupt', 'log.git-dubious-ownership', 'log.disk-full', 'log.tls-intercepted', 'log.illegal-instruction', 'log.file-busy']))
    expect(findings.find(f => f.id === 'log.disk-full')!.detail).toContain('Seen 2 times')
    expect(JSON.stringify(findings)).not.toContain('alice')
  })
})

describe('network', () => {
  test('clock skew past 20 s warns with sync steps, past 5 min is an error', () => {
    expect(clockFinding({ skewMs: 5_000, rttMs: 50 }, 'darwin', 'desktop').severity).toBe('ok')
    const ahead = clockFinding({ skewMs: 70_000, rttMs: 50 }, 'win32', 'desktop')
    expect(ahead.severity).toBe('warning')
    expect(ahead.title).toBe("Your computer's clock is 70 s ahead")
    expect(ahead.detail).toContain('sync automatically')
    expect(ahead.steps.join(' ')).toContain('Set time automatically')
    expect(clockFinding({ skewMs: -600_000, rttMs: 50 }, 'linux', 'cli')).toMatchObject({ severity: 'error', title: "Your computer's clock is 10 min behind" })
  })

  test('skew is read from the Date header against the middle of the round trip', async () => {
    let t = Date.parse('2026-11-02T00:01:10.000Z')
    const reading = await readClockSkew('https://example.test', {
      now: () => (t += 100),
      fetch: async () => new Response(null, { headers: { date: 'Mon, 02 Nov 2026 00:00:00 GMT' } }),
    })
    expect('skewMs' in reading && Math.round(reading.skewMs / 1000)).toBe(70)
  })

  test('errors are classified, and a certificate failure names interception', () => {
    expect(classifyNetworkError(Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }))).toBe('dns')
    expect(classifyNetworkError({ code: 'ConnectionRefused' })).toBe('refused')
    expect(classifyNetworkError({ name: 'TimeoutError' })).toBe('timeout')
    expect(classifyNetworkError({ code: 'SELF_SIGNED_CERT_IN_CHAIN' })).toBe('tls')
    const [api] = endpointFindings([{ endpoint: { id: 'api', label: 'the Freebuff API', url: 'x' }, ms: 1, ok: false, error: 'tls' }])
    expect(api!.title).toContain('HTTPS is being intercepted')
    expect(api!.detail).toContain('antivirus')
  })

  test('an antivirus issuer or a rejected chain is interception', () => {
    expect(tlsFinding('api.freebuff.com', { authorized: true, authorizationError: null, issuers: ["Let's Encrypt / R11"] }).id).toBe('tls.ok')
    const av = tlsFinding('api.freebuff.com', { authorized: true, authorizationError: null, issuers: ['Avast Web/Mail Shield / Avast Web/Mail Shield Root'] })
    expect(av).toMatchObject({ id: 'tls.intercepted', severity: 'warning' })
    expect(tlsFinding('x', { authorized: false, authorizationError: 'SELF_SIGNED_CERT_IN_CHAIN', issuers: [] }).severity).toBe('error')
  })

  test('hosts entries for our domains are found, comments ignored', () => {
    const entries = hostsFileEntries('127.0.0.1 localhost\n0.0.0.0 api.freebuff.com # blocked\n# 1.2.3.4 codebuff.com\n10.0.0.1 www.codebuff.com other.test')
    expect(entries).toEqual([{ address: '0.0.0.0', host: 'api.freebuff.com' }, { address: '10.0.0.1', host: 'www.codebuff.com' }])
    expect(hostsFinding(entries).severity).toBe('error')
    expect(hostsFinding([]).severity).toBe('ok')
  })

  test('DNS answers pointing at a local address are flagged', async () => {
    const found = await dnsFindings(['freebuff.com', 'codebuff.com'], async host => (host === 'freebuff.com' ? ['0.0.0.0'] : ['104.18.1.1']))
    expect(found.map(f => f.id)).toEqual(['dns.blocked.freebuff.com'])
  })

  test('proxies are reported by host and port only, and a dead one is an error', async () => {
    const env = { HTTPS_PROXY: 'http://user:hunter2@proxy.corp:8080', http_proxy: 'http://proxy.corp:8080' }
    expect(configuredProxies(env)).toEqual([{ variable: 'HTTPS_PROXY', host: 'proxy.corp', port: 8080 }])
    const down = await proxyFindings(env, async () => false)
    expect(down[0]!.severity).toBe('error')
    expect(JSON.stringify(down)).not.toContain('hunter2')
    expect((await proxyFindings(env, async () => true))[0]!.id).toBe('proxy.ok')
  })

  test('risky environment variables are named', () => {
    expect(environmentFindings({ NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_OPTIONS: '--require ./hook.js' }).map(f => f.id))
      .toEqual(['env.tls-verification-off', 'env.node-options-preload'])
  })
})

describe('system', () => {
  test('synced folders are recognised by their default names', () => {
    expect(syncProviderFor('C:\\Users\\Bob\\OneDrive\\Freebuff')).toBe('OneDrive')
    expect(syncProviderFor('C:\\Users\\Bob\\OneDrive - Contoso\\x')).toBe('OneDrive')
    expect(syncProviderFor('/Users/a/Dropbox (Personal)/x')).toBe('Dropbox')
    expect(syncProviderFor('/Users/a/Library/Mobile Documents/com~apple~CloudDocs/x')).toBe('iCloud Drive')
    expect(syncProviderFor('/Users/a/Library/CloudStorage/GoogleDrive-a@b.com/My Drive/x')).toBe('Google Drive')
    expect(syncProviderFor('/Users/a/.config/freebuff-desktop')).toBeNull()
  })

  test('disk thresholds', async () => {
    const statfs = (free: number) => () => ({ bavail: free / 4096, bsize: 4096 })
    expect((await diskFinding('your profile', '/x', redact, statfs(100 * 1024 ** 2))).id).toBe('disk.critical')
    expect((await diskFinding('your profile', '/x', redact, statfs(1024 ** 3))).id).toBe('disk.low')
    expect((await diskFinding('your profile', '/x', redact, statfs(50 * 1024 ** 3))).id).toBe('disk.ok')
  })

  test('platform-specific limits', async () => {
    expect(watcherLimitFinding('linux', () => '8192\n')?.id).toBe('system.inotify-low')
    expect(watcherLimitFinding('darwin', () => '8192')).toBeNull()
    expect(architectureFinding('darwin', 'x64', 'Apple M2')?.id).toBe('system.rosetta')
    expect(architectureFinding('darwin', 'arm64', 'Apple M2')).toBeNull()
    const deep = 'a'.repeat(120)
    const list = (dir: string) => (dir.length < 400 ? [{ name: deep, isDirectory: () => true }] : [])
    expect((await longPathFinding(['C:\\p'], 'win32', 100, list))?.id).toBe('system.long-paths')
    expect(await longPathFinding(['/p'], 'linux', 100, list)).toBeNull()
  })
})

describe('git', () => {
  test('folder states, and dubious ownership offers a warned repair', () => {
    expect(classifyGitFolder({ code: 128, stdout: '', stderr: "fatal: detected dubious ownership in repository at '/x'" })).toBe('dubious')
    expect(classifyGitFolder({ code: 128, stdout: '', stderr: 'fatal: not a git repository' })).toBe('not-repo')
    expect(classifyGitFolder({ code: null, stdout: '', stderr: '', missing: true })).toBe('no-git')
    const dubious = gitFolderFinding('dubious', 'my-repo', '/Users/alice/code/my-repo', redact, 'ref-1')!
    expect(dubious.repair).toMatchObject({ kind: 'trust-git-folder', ref: 'ref-1' })
    expect(dubious.repair!.warning).toContain('Only trust folders you own')
    expect(JSON.stringify(dubious)).not.toContain('/Users/alice')
  })

  test('Windows without long paths is noted', async () => {
    const run = async (_: string, args: string[]) => (args[0] === '--version' ? { code: 0, stdout: 'git version 2.47.0', stderr: '' } : { code: 1, stdout: '', stderr: '' })
    expect((await gitInstallFindings('win32', run)).map(f => f.id)).toEqual(['git.ok', 'git.longpaths-off'])
    expect((await gitInstallFindings('darwin', async () => ({ code: null, stdout: '', stderr: '', missing: true })))[0]!.id).toBe('git.missing')
  })
})
