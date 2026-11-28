#!/usr/bin/env bun
/**
 * When an official Freebuff CLI exposes `--acp`, run the live free-mode E2E
 * gates (handshake → set_mode → two live turns). Strike-safe until ready.
 *
 * Usage:
 *   bun scripts/acp-t3-e2e-when-ready.ts           # check once; exit 1 if not ready
 *   bun scripts/acp-t3-e2e-when-ready.ts --watch   # poll until ready, then E2E
 *   bun scripts/acp-t3-e2e-when-ready.ts --bin PATH
 *
 * Env:
 *   FREEBUFF_ACP_CMD  override spawn command (must include --acp)
 *   ACP_READY_POLL_MS poll interval for --watch (default 900000 = 15m)
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dir, '..')

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag)
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  if (i === -1) return undefined
  return process.argv[i + 1]
}

function run(cmd: string, args: string[]): number {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  })
  return result.status ?? 1
}

function checkReady(bin?: string): boolean {
  const args = bin
    ? ['scripts/acp-official-ready.ts', '--bin', bin]
    : ['scripts/acp-official-ready.ts', '--npm']
  return run('bun', args) === 0
}

function resolveOfficialCmd(bin?: string): string {
  if (process.env.FREEBUFF_ACP_CMD?.trim()) return process.env.FREEBUFF_ACP_CMD
  if (bin) return `${bin} --acp --trust-agents`
  // Prefer PATH freebuff after a successful npm readiness check.
  return 'freebuff --acp --trust-agents'
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

const watch = hasFlag('--watch')
const bin = argValue('--bin')
const pollMs = Number(
  process.env.ACP_READY_POLL_MS ?? argValue('--poll-ms') ?? '900000',
)

let ready = checkReady(bin)
while (!ready && watch) {
  console.log(`Not ready. Sleeping ${pollMs}ms…`)
  await sleep(pollMs)
  ready = checkReady(bin)
}

if (!ready) {
  console.error('Official Freebuff --acp not available yet.')
  process.exit(1)
}

const cmd = resolveOfficialCmd(bin)
process.env.FREEBUFF_ACP_CMD = cmd

const handshake = run('bun', [
  'scripts/acp-stdio-harness.ts',
  '--handshake-only',
  '--set-mode',
  'MAX',
  '--transcript',
  'scripts/acp-harness-e2e-handshake.jsonl',
])
if (handshake !== 0) process.exit(handshake)

const live = run('bun', [
  'scripts/acp-stdio-harness.ts',
  '--live',
  '--turns',
  '2',
  '--set-mode',
  'MAX',
  '--transcript',
  'scripts/acp-harness-e2e-live.jsonl',
])
if (live !== 0) process.exit(live)

console.log(
  [
    '',
    'Harness live E2E passed.',
    'T3 remaining:',
    '  1. Point providerInstances.freebuff-acp at the official binary + --acp --trust-agents',
    '  2. Prompt once, switch mode, second turn',
    '  3. Save screenshots under the sandbox evidence folder',
  ].join('\n'),
)
process.exit(0)
