#!/usr/bin/env bun
/**
 * Qualifies the production Bun credential adapter across two process identities:
 * source Bun (the CLI development/runtime shape) and a Bun-compiled executable
 * (the packaged Desktop/CLI shape). It requires a functioning native credential
 * store and exits non-zero when that store is unavailable; it never skips.
 *
 * The script makes no provider requests. It uses a fresh metadata directory and
 * synthetic, process-derived credentials. Child-process arguments and JSON
 * output contain no credential material. Cleanup is limited to the unique
 * connection created under this run's temporary directory.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

type WorkerResult = {
  action: string
  id?: string
  revision?: number
  credentialRef?: string
}

const worker = path.join(import.meta.dir, 'qualify-byok-credentials-worker.ts')
const directory = await mkdtemp(path.join(tmpdir(), 'freebuff-byok-native-'))
const compiledWorker = path.join(
  directory,
  process.platform === 'win32' ? 'byok-native-worker.exe' : 'byok-native-worker',
)
let compiled = false
const createdConnections: Array<{ runId: string; id?: string }> = []
let failure = 'unknown'

function safeFailure(context: string): never {
  // Child errors intentionally remain private: native keychain providers can
  // include surprising details in their messages.
  throw new Error(`BYOK native credential qualification failed (${context})`)
}

async function invoke(
  runtime: 'source' | 'compiled',
  action: string,
  runId: string,
  id?: string,
): Promise<WorkerResult> {
  const command = runtime === 'source' ? process.execPath : compiledWorker
  const args =
    runtime === 'source'
      ? [worker, action, directory, runId]
      : [action, directory, runId]
  if (id) args.push(id)
  const child = Bun.spawn({
    cmd: [command, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  })
  const [stdout, _stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (status !== 0) safeFailure(`${runtime}:${action}:exit-${status}`)
  try {
    const parsed = JSON.parse(stdout) as WorkerResult
    if (parsed.action !== action) safeFailure(`${runtime}:${action}:bad-output`)
    return parsed
  } catch {
    safeFailure(`${runtime}:${action}:invalid-json`)
  }
}

try {
  const compile = Bun.spawn({
    cmd: [process.execPath, 'build', '--compile', worker, '--outfile', compiledWorker],
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  })
  const [_compileStdout, _compileStderr, compileStatus] = await Promise.all([
    new Response(compile.stdout).text(),
    new Response(compile.stderr).text(),
    compile.exited,
  ])
  if (compileStatus !== 0) safeFailure(`compile:exit-${compileStatus}`)
  compiled = true

  // Source creates, compiled reads; compiled replaces, source reads. Repeat
  // cold compiled reads because a past packaged-CLI qualification had one
  // transient first credential read before a fresh launch passed.
  for (let cycle = 0; cycle < 3; cycle++) {
    const runId = crypto.randomUUID()
    createdConnections.push({ runId })
    const created = await invoke('source', 'create', runId)
    if (!created.id || created.revision !== 1)
      safeFailure('source:create:bad-result')
    createdConnections[createdConnections.length - 1]!.id = created.id
    await invoke('compiled', 'read-v1', runId, created.id)
    const replaced = await invoke('compiled', 'replace', runId, created.id)
    if (replaced.id !== created.id || replaced.revision !== 2)
      safeFailure('compiled:replace:bad-result')
    await invoke('source', 'confirm-v1-erased', runId, created.id)
    await invoke('source', 'read-v2', runId, created.id)
    await invoke('source', 'reject-stale-v1', runId, created.id)
    await invoke('compiled', 'delete', runId, created.id)
    await invoke('source', 'confirm-erased', runId, created.id)
  }

  // Safe JSON receipt: only execution facts, never IDs, refs, paths, or keys.
  process.stdout.write(
    JSON.stringify({
      ok: true,
      sourceBun: Bun.version,
      compiledWorker: compiled,
      checks: [
        'source-create',
        'compiled-read',
        'compiled-replace',
        'source-old-native-erasure-confirmed',
        'source-read',
        'stale-revision-rejected',
        'compiled-delete',
        'source-native-erasure-confirmed',
      ],
      cycles: 3,
    }) + '\n',
  )
} catch (error) {
  if (
    error instanceof Error &&
    error.message.startsWith('BYOK native credential qualification failed (')
  )
    failure = error.message
  process.stderr.write(`${failure}\n`)
  process.exitCode = 1
} finally {
  // Cleanup invokes the same production remove flow. It runs after both success
  // and failure and only sees connections bearing this unique run id.
  try {
    for (const connection of createdConnections) {
      await invoke(
        'source',
        'cleanup',
        connection.runId,
        connection.id,
      )
    }
  } catch {
    process.stderr.write('BYOK native credential qualification cleanup failed\n')
    process.exitCode = 1
  }
  await rm(directory, { recursive: true, force: true })
}
