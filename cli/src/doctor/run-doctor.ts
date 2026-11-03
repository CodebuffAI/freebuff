import fs from 'fs'
import os from 'os'
import path from 'path'

import { finding, type DoctorReport } from '@codebuff/common/doctor/types'
import { createRedactor } from '@codebuff/common/doctor/redact'
import { runDoctorChecks, type DoctorCheck } from '@codebuff/common/doctor/run'
import { doctorAskPrompt, doctorReportMarkdown, doctorReportText } from '@codebuff/common/doctor/report'
import {
  clockFinding, dnsFindings, endpointFindings, environmentFindings, hostsFileEntries, hostsFilePath, hostsFinding,
  inspectTls, probeEndpoint, proxyFindings, readClockSkew, tlsFinding,
} from '@codebuff/common/doctor/node/network'
import { architectureFinding, diskFinding, longPathFinding, memoryFinding, syncProviderFor, tempDirFinding, watcherLimitFinding } from '@codebuff/common/doctor/node/system'
import { gitFolderFinding, gitFolderState, gitInstallFindings, runCommand, type RunCommand } from '@codebuff/common/doctor/node/git'
import { processTable } from '@codebuff/common/doctor/node/processes'

import { getSystemProcessEnv } from '../utils/env'

import {
  authFindings, binaryFindings, commandsOnPath, historyFindings, installFindings, isPidAlive, latestPublishedVersion,
  leftoverFindings, logFindings, nodeFindings, shadowingFindings,
} from './checks'

export type DoctorOptions = { includePaths: boolean; format: 'text' | 'markdown' | 'json' | 'ask'; verbose: boolean }

export function parseDoctorArgs(args: string[]): DoctorOptions | { help: true } {
  if (args.includes('--help') || args.includes('-h')) return { help: true }
  return {
    includePaths: args.includes('--full-paths'),
    format: args.includes('--json') ? 'json' : args.includes('--ask') ? 'ask' : args.includes('--markdown') ? 'markdown' : 'text',
    verbose: args.includes('--verbose'),
  }
}

export function doctorHelp(command: string) {
  return `Usage: ${command} doctor [options]

Checks this computer for the problems that most often break ${command}: how it is installed,
your sign-in, the network, TLS interception, your clock, disk, git and more. Read-only, and
nothing is sent anywhere.

Options:
  --markdown     Print the report as Markdown, to paste into a support request or Discord
  --ask          Print a message to paste into ${command} so it explains and fixes what it found
  --json         Print the report as JSON
  --full-paths   Include full folder paths (redacted to the last folder by default)
  --verbose      Also list the checks that passed
`
}

type Context = { cwd: string }

export async function buildDoctorReport(input: {
  includePaths: boolean
  version: string
  packageName: string
  configDir: string
  apiUrl: string
  launcherVersion: string | null
  cwd: string
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  run?: RunCommand
}): Promise<DoctorReport> {
  const started = performance.now()
  const now = Date.now()
  const env = input.env ?? getSystemProcessEnv()
  const platform = input.platform ?? process.platform
  const run = input.run ?? runCommand
  const fetcher = input.fetch ?? fetch
  let username: string | undefined
  try { username = os.userInfo().username } catch { /* none */ }
  const redact = createRedactor({ home: os.homedir(), username, includePaths: input.includePaths })
  const apiHost = new URL(input.apiUrl).hostname
  const checks: DoctorCheck<Context>[] = [
    { id: 'install', area: 'install', run: async () => installFindings({ version: input.version, packageName: input.packageName,
      launcherVersion: input.launcherVersion, latest: await latestPublishedVersion(input.packageName, fetcher) }) },
    { id: 'binary', area: 'install', run: () => binaryFindings({ configDir: input.configDir, packageName: input.packageName, platform, redact, run }) },
    { id: 'path', area: 'install', run: () => shadowingFindings(input.packageName, commandsOnPath(input.packageName, env, platform), redact) },
    { id: 'leftovers', area: 'install', run: () => leftoverFindings({ configDir: input.configDir, now, isAlive: isPidAlive }) },
    { id: 'node', area: 'install', run: () => nodeFindings({ run, env, platform }) },
    { id: 'auth', area: 'auth', run: () => authFindings({ configDir: input.configDir, platform, redact, command: input.packageName }) },
    { id: 'history', area: 'state', run: () => {
      const history = historyFindings({ configDir: input.configDir, now })
      return [...history.findings, ...logFindings(history.newestLog)]
    } },
    { id: 'config-location', area: 'state', run: () => {
      const provider = syncProviderFor(input.configDir)
      return provider ? [finding('state.synced-folder', 'warning', 'state', `The CLI's settings folder is inside ${provider}`,
        `${provider} can lock or rewrite its files while the CLI uses them.`, [`Exclude ${redact.path(input.configDir)} from ${provider}.`])] : []
    } },
    { id: 'processes', area: 'processes', run: async () => {
      const table = await processTable(platform, run)
      const binary = path.join(input.configDir, input.packageName)
      const pids = new Set(table.map(row => row.pid))
      const orphans = table.filter(row => row.pid !== process.pid && row.command.startsWith(binary) && (row.ppid === 1 || !pids.has(row.ppid)))
      return orphans.length ? [finding('processes.orphaned-cli', 'info', 'processes', `${orphans.length} ${input.packageName} process${orphans.length === 1 ? ' is' : 'es are'} left from a closed terminal`,
        'They keep running after their terminal closed and can hold files an update needs to replace.',
        [`End them in ${platform === 'win32' ? 'Task Manager' : platform === 'darwin' ? 'Activity Monitor' : 'your system monitor'} (process ${orphans.map(o => o.pid).join(', ')}).`])] : []
    } },
    { id: 'git', area: 'git', run: async c => {
      const out = await gitInstallFindings(platform, run)
      const state = await gitFolderState(c.cwd, run)
      const folder = state === 'dubious' ? gitFolderFinding(state, 'this folder', c.cwd, redact) : null
      return folder ? [...out, { ...folder, steps: [`If this is your folder, run \`git config --global --add safe.directory ${redact.path(c.cwd)}\` (only for folders you own).`, ...folder.steps.slice(1)] }] : out
    } },
    { id: 'disk', area: 'disk', run: async () => [await diskFinding('the CLI\'s settings folder', fs.existsSync(input.configDir) ? input.configDir : os.homedir(), redact)] },
    { id: 'temp', area: 'system', run: async () => [await tempDirFinding(os.tmpdir(), redact)] },
    { id: 'system', area: 'system', run: async c => [architectureFinding(platform), memoryFinding(), watcherLimitFinding(platform), await longPathFinding([c.cwd], platform)].filter(f => f !== null) },
    { id: 'network', area: 'network', timeoutMs: 10_000, run: async () => endpointFindings(await Promise.all([
      { id: 'api', label: 'the Freebuff API', url: input.apiUrl },
      { id: 'web', label: 'freebuff.com', url: 'https://freebuff.com' },
      { id: 'npm', label: 'the npm registry (updates)', url: 'https://registry.npmjs.org/' },
    ].map(endpoint => probeEndpoint(endpoint, { fetch: fetcher })))) },
    { id: 'tls', area: 'network', run: async () => [tlsFinding(apiHost, await inspectTls(apiHost))] },
    { id: 'dns', area: 'network', run: () => dnsFindings([apiHost, 'freebuff.com']) },
    { id: 'hosts', area: 'network', run: () => { try { return [hostsFinding(hostsFileEntries(fs.readFileSync(hostsFilePath(platform, env), 'utf8')))] } catch { return [] } } },
    { id: 'proxy', area: 'network', run: () => proxyFindings(env) },
    { id: 'environment', area: 'environment', run: () => environmentFindings(env) },
    { id: 'clock', area: 'clock', run: async () => [clockFinding(await readClockSkew(input.apiUrl, { fetch: fetcher }), platform, 'cli')] },
  ]
  const { findings, checks: runs } = await runDoctorChecks(checks, { cwd: input.cwd })
  return {
    version: 1, product: 'cli', generatedAt: new Date(now).toISOString(), durationMs: Math.round(performance.now() - started),
    appVersion: input.version, platform, arch: process.arch, options: { deep: false, includePaths: input.includePaths }, findings, checks: runs,
  }
}

export function formatDoctorReport(report: DoctorReport, options: DoctorOptions, command: string) {
  if (options.format === 'json') return JSON.stringify(report, null, 2) + '\n'
  if (options.format === 'markdown') return doctorReportMarkdown(report)
  if (options.format === 'ask') return doctorAskPrompt(report)
  const problems = report.findings.some(item => item.severity === 'error' || item.severity === 'warning')
  return doctorReportText(report, { verbose: options.verbose }) + (problems
    ? `\nTo have ${command} explain and fix these, run \`${command} doctor --ask\`, copy what it prints, start ${command} in a folder you are working in, and paste it as your first message.` +
      `\nFor a support request, \`${command} doctor --markdown\` prints a redacted report to paste.\n`
    : '')
}
