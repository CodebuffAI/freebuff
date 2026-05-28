import { spawnSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import path from 'path'

import { withTimeout } from '@codebuff/common/util/promise'

import { LOGIN_WEBSITE_URL } from '../login/constants'
import { getRgPath } from '../native/ripgrep'
import { createCodebuffApiClient } from '../utils/codebuff-api'
import {
  calculateFingerprint,
  getFingerprintType,
} from '../utils/fingerprint'
import { logger } from '../utils/logger'

import { runTerminalCommand } from '../../../sdk/src/tools/run-terminal-command'

const STEP_TIMEOUT_MS = 30_000
const NETWORK_TIMEOUT_MS = 45_000

type SmokeResult = {
  name: string
  ms: number
}

async function runStep(
  name: string,
  timeoutMs: number,
  fn: () => Promise<void> | void,
): Promise<SmokeResult> {
  const started = Date.now()
  try {
    await withTimeout(
      Promise.resolve().then(fn),
      timeoutMs,
      `${name} timed out after ${timeoutMs}ms`,
    )
  } catch (err) {
    throw new Error(
      `${name} failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
  return { name, ms: Date.now() - started }
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

function assertOutputContains(output: string, needle: string, label: string) {
  assertCondition(
    output.includes(needle),
    `${label} output did not contain ${JSON.stringify(needle)}. Output: ${
      output.slice(0, 2048)
    }`,
  )
}

async function smokeFilesystemAndRuntime(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'codebuff-runtime-smoke-'))
  try {
    const nestedFile = path.join(dir, 'folder with spaces', 'payload.json')
    const payload = {
      marker: 'codebuff-runtime-smoke',
      platform: process.platform,
      arch: process.arch,
      execPath: process.execPath,
      argv0: process.argv[0],
    }

    mkdirSync(path.dirname(nestedFile), { recursive: true })
    await Bun.write(nestedFile, JSON.stringify(payload, null, 2))
    assertCondition(existsSync(nestedFile), `Expected ${nestedFile} to exist`)

    const parsed = JSON.parse(
      readFileSync(nestedFile, 'utf8'),
    ) as typeof payload
    assertCondition(
      parsed.marker === payload.marker,
      'Round-trip JSON marker changed',
    )
    assertCondition(
      parsed.platform === process.platform,
      'Round-trip platform changed',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function smokeLoginNetwork(): Promise<void> {
  const fingerprintId = await calculateFingerprint()
  const fingerprintType = getFingerprintType(fingerprintId)
  assertCondition(
    fingerprintType !== 'unknown',
    `Unexpected fingerprint type for ${fingerprintId}`,
  )

  const smokeFingerprintId = [
    fingerprintId,
    'runtime-smoke',
    process.platform,
    process.arch,
    Date.now().toString(36),
  ].join('-')

  const apiClient = createCodebuffApiClient({
    baseUrl: LOGIN_WEBSITE_URL,
    defaultTimeoutMs: 15_000,
    retry: {
      maxRetries: 1,
      initialDelayMs: 500,
      maxDelayMs: 1_500,
    },
  })

  const loginCode = await apiClient.loginCode({
    fingerprintId: smokeFingerprintId,
  })
  if (!loginCode.ok) {
    throw new Error(
      `loginCode returned ${loginCode.status}: ${loginCode.error ?? '<no error>'}`,
    )
  }
  assertCondition(loginCode.data, 'loginCode returned no data')

  const { loginUrl, fingerprintHash, expiresAt } = loginCode.data
  assertCondition(typeof loginUrl === 'string', 'loginUrl was not a string')
  assertCondition(
    typeof fingerprintHash === 'string',
    'fingerprintHash was not a string',
  )

  const parsedUrl = new URL(loginUrl)
  assertCondition(
    parsedUrl.protocol === 'https:' || parsedUrl.hostname === 'localhost',
    `Unexpected loginUrl protocol/host: ${loginUrl}`,
  )
  assertCondition(
    parsedUrl.searchParams.has('auth_code'),
    `loginUrl missing auth_code query param: ${loginUrl}`,
  )

  const expiresAtMs = Number(expiresAt)
  assertCondition(
    Number.isFinite(expiresAtMs),
    `expiresAt was not numeric: ${expiresAt}`,
  )
  assertCondition(
    expiresAtMs > Date.now(),
    `expiresAt was not in the future: ${expiresAt}`,
  )

  const status = await apiClient.loginStatus({
    fingerprintId: smokeFingerprintId,
    fingerprintHash,
    expiresAt: String(expiresAt),
  })
  assertCondition(
    status.status === 401 || status.ok,
    `loginStatus returned unexpected ${status.status}: ${
      status.ok ? '<ok>' : status.error ?? '<no error>'
    }`,
  )
}

async function smokeRipgrep(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'codebuff-rg-smoke-'))
  try {
    const marker = `CODEBUFF_RG_SMOKE_${Date.now().toString(36)}`
    const fixturePath = path.join(dir, 'fixture.txt')
    writeFileSync(fixturePath, `before\n${marker}\nafter\n`)

    const rgPath = await getRgPath()
    assertCondition(existsSync(rgPath), `rg path does not exist: ${rgPath}`)

    const version = spawnSync(rgPath, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
    })
    assertCondition(
      version.status === 0,
      `rg --version failed (${version.status}): ${version.stderr || version.stdout}`,
    )
    assertOutputContains(version.stdout, 'ripgrep', 'rg --version')

    const search = spawnSync(
      rgPath,
      ['--no-config', '-n', '--json', '--', marker, dir],
      {
        encoding: 'utf8',
        timeout: 10_000,
      },
    )
    assertCondition(
      search.status === 0,
      `rg marker search failed (${search.status}): ${search.stderr || search.stdout}`,
    )
    assertOutputContains(search.stdout, marker, 'rg marker search')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function smokeSubprocesses(): Promise<void> {
  const result = await runTerminalCommand({
    command: 'printf codebuff-smoke-bash',
    process_type: 'SYNC',
    cwd: process.cwd(),
    timeout_seconds: 10,
  })
  const payload = result[0]?.type === 'json' ? result[0].value : null
  assertCondition(
    payload && typeof payload === 'object',
    'runTerminalCommand returned no JSON payload',
  )

  const stdout = String((payload as { stdout?: unknown }).stdout ?? '')
  const exitCode = (payload as { exitCode?: unknown }).exitCode
  assertCondition(
    exitCode === 0,
    `runTerminalCommand exit code was ${String(exitCode)}`,
  )
  assertOutputContains(stdout, 'codebuff-smoke-bash', 'runTerminalCommand')

  if (process.platform === 'win32') {
    const powershell = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', 'Write-Output codebuff-smoke-powershell'],
      {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
      },
    )
    assertCondition(
      powershell.status === 0,
      `powershell smoke failed (${powershell.status}): ${
        powershell.stderr || powershell.stdout
      }`,
    )
    assertOutputContains(
      powershell.stdout,
      'codebuff-smoke-powershell',
      'powershell',
    )
  }
}

export async function runRuntimePrimitivesSmoke(): Promise<void> {
  const results: SmokeResult[] = []

  results.push(
    await runStep(
      'filesystem/runtime',
      STEP_TIMEOUT_MS,
      smokeFilesystemAndRuntime,
    ),
  )
  results.push(
    await runStep('ripgrep extraction/search', STEP_TIMEOUT_MS, smokeRipgrep),
  )
  results.push(await runStep('subprocesses', STEP_TIMEOUT_MS, smokeSubprocesses))
  results.push(
    await runStep('login network', NETWORK_TIMEOUT_MS, smokeLoginNetwork),
  )

  logger.info(
    { results, baseUrl: LOGIN_WEBSITE_URL },
    'Runtime primitives smoke completed',
  )
  console.log(
    `runtime primitives smoke ok (${results
      .map((result) => `${result.name}: ${result.ms}ms`)
      .join(', ')})`,
  )
}
