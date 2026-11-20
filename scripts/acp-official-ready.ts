#!/usr/bin/env bun
/**
 * Strike-safe gate: detect when an official Freebuff CLI exposes `--acp`.
 *
 * Does **not** send session/prompt or live completions.
 *
 * Usage:
 *   bun scripts/acp-official-ready.ts
 *   bun scripts/acp-official-ready.ts --bin path/to/freebuff
 *   bun scripts/acp-official-ready.ts --npm   # pack+extract latest freebuff from npm
 *
 * Exit 0 when `--acp` is present in `--help`. Exit 1 when not ready.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag)
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  if (i === -1) return undefined
  return process.argv[i + 1]
}

function helpHasAcp(bin: string, args: string[] = ['--help']): boolean {
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: 60_000,
    env: process.env,
  })
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  return /\s--acp\b/.test(text)
}

function checkPath(bin: string): boolean {
  console.log(`checking ${bin}`)
  const ok = helpHasAcp(bin)
  console.log(ok ? 'READY: --acp present' : 'NOT READY: --acp missing')
  return ok
}

function checkNpmLatest(): boolean {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-acp-ready-'))
  try {
    const pack = spawnSync('npm', ['pack', 'freebuff@latest', '--pack-destination', tmp], {
      encoding: 'utf8',
      timeout: 120_000,
    })
    if (pack.status !== 0) {
      console.error(pack.stderr || pack.stdout)
      return false
    }
    const tgz = fs
      .readdirSync(tmp)
      .find((name) => name.endsWith('.tgz'))
    if (!tgz) {
      console.error('npm pack produced no tarball')
      return false
    }
    const extract = spawnSync('tar', ['-xzf', path.join(tmp, tgz), '-C', tmp], {
      encoding: 'utf8',
    })
    if (extract.status !== 0) {
      // Windows often has tar; fall back to npm's extract via unpack in place.
      console.error(extract.stderr || 'tar extract failed; trying node')
    }
    const pkgRoot = path.join(tmp, 'package')
    const pkg = JSON.parse(
      fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'),
    ) as { version?: string; bin?: string | Record<string, string> }
    console.log(`npm freebuff@${pkg.version ?? 'unknown'}`)
    const binField =
      typeof pkg.bin === 'string'
        ? pkg.bin
        : pkg.bin && typeof pkg.bin === 'object'
          ? (pkg.bin.freebuff ?? Object.values(pkg.bin)[0])
          : undefined
    if (!binField) {
      console.error('package has no bin')
      return false
    }
    const entry = path.join(pkgRoot, binField)
    // npm freebuff bin is usually a JS launcher; probe via node.
    const ok = helpHasAcp(process.execPath, [entry, '--help'])
    console.log(ok ? 'READY: --acp present' : 'NOT READY: --acp missing')
    return ok
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

const bin = argValue('--bin')
const useNpm = hasFlag('--npm') || !bin

let ready = false
if (bin) {
  ready = checkPath(bin)
} else if (useNpm) {
  ready = checkNpmLatest()
}

if (ready) {
  console.log(
    [
      '',
      'Next (live free E2E — only on allowlisted official --acp builds):',
      '  FREEBUFF_ACP_CMD="<official freebuff> --acp --trust-agents" \\',
      '    bun scripts/acp-stdio-harness.ts --live --turns 2 --set-mode MAX',
      '  Then re-test T3 Local ACP with that binary and capture screenshots.',
    ].join('\n'),
  )
}

process.exit(ready ? 0 : 1)
