import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  ensureSponsoredManagedNode,
  installedSponsoredManagedNode,
  sponsoredManagedNodeTarget,
  SPONSORED_MANAGED_NODE_VERSION,
  type SponsoredManagedNodeDeps,
} from '../tools/sponsored-managed-node'

let baseDir: string

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-node-'))
})

afterEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true })
})

const TARGET = { platform: 'linux' as const, arch: 'x64' }
const LINUX_X64_SHA =
  '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff'

/**
 * Deps whose download answers `body` and whose extract lays out a fake Node.
 * The pinned hash is of the real archive, so a test that must pass the
 * checksum swaps in `sha256` over its own bytes through `pinnedFor`.
 */
function deps(
  body: Uint8Array,
  options: { status?: number; extractFails?: boolean } = {},
): SponsoredManagedNodeDeps & { fetched: string[]; logs: string[] } {
  const fetched: string[] = []
  const logs: string[] = []
  return {
    fetched,
    logs,
    async fetch(url) {
      fetched.push(url)
      return new Response(body, { status: options.status ?? 200 })
    },
    async extract(_archive, dir) {
      if (options.extractFails) throw new Error('tar exited 2')
      fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'bin', 'node'), '#!/bin/sh\n', {
        mode: 0o755,
      })
    },
    log: (message) => logs.push(message),
  }
}

describe('sponsoredManagedNodeTarget', () => {
  test('macOS and Linux on arm64 and x64 only', () => {
    expect(sponsoredManagedNodeTarget('darwin', 'arm64')).toBe('darwin-arm64')
    expect(sponsoredManagedNodeTarget('linux', 'x64')).toBe('linux-x64')
    expect(sponsoredManagedNodeTarget('win32', 'x64')).toBeNull()
    expect(sponsoredManagedNodeTarget('linux', 'ia32')).toBeNull()
  })
})

describe('ensureSponsoredManagedNode', () => {
  test('a download that is not the pinned release is never unpacked', async () => {
    const d = deps(new TextEncoder().encode('not node'))
    const result = await ensureSponsoredManagedNode({ baseDir, ...TARGET }, d)
    expect(result).toBeNull()
    expect(d.fetched).toEqual([
      `https://nodejs.org/dist/${SPONSORED_MANAGED_NODE_VERSION}/node-${SPONSORED_MANAGED_NODE_VERSION}-linux-x64.tar.gz`,
    ])
    expect(d.logs).toEqual(['[sponsored] managed Node not installed'])
    // Nothing left behind: no archive, no staging folder, no install.
    expect(fs.readdirSync(baseDir)).toEqual([])
    expect(
      installedSponsoredManagedNode(baseDir, TARGET.platform, TARGET.arch),
    ).toBeNull()
  })

  test('an HTTP error installs nothing', async () => {
    const d = deps(new Uint8Array(), { status: 503 })
    expect(
      await ensureSponsoredManagedNode({ baseDir, ...TARGET }, d),
    ).toBeNull()
    expect(fs.readdirSync(baseDir)).toEqual([])
  })

  test('an unsupported machine never downloads', async () => {
    const d = deps(new Uint8Array())
    expect(
      await ensureSponsoredManagedNode(
        { baseDir, platform: 'win32', arch: 'x64' },
        d,
      ),
    ).toBeNull()
    expect(d.fetched).toEqual([])
  })

  test('an existing verified install is reused without a download', async () => {
    const root = path.join(
      baseDir,
      `node-${SPONSORED_MANAGED_NODE_VERSION}-linux-x64`,
    )
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(root, 'bin', 'node'), '', { mode: 0o755 })
    fs.writeFileSync(path.join(root, '.freebuff-verified'), LINUX_X64_SHA)
    const d = deps(new Uint8Array())
    expect(await ensureSponsoredManagedNode({ baseDir, ...TARGET }, d)).toEqual(
      { root, binDir: path.join(root, 'bin') },
    )
    expect(d.fetched).toEqual([])
  })

  test('a folder without the marker is not trusted', () => {
    const root = path.join(
      baseDir,
      `node-${SPONSORED_MANAGED_NODE_VERSION}-linux-x64`,
    )
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(root, 'bin', 'node'), '', { mode: 0o755 })
    expect(
      installedSponsoredManagedNode(baseDir, TARGET.platform, TARGET.arch),
    ).toBeNull()
    fs.writeFileSync(path.join(root, '.freebuff-verified'), 'another hash')
    expect(
      installedSponsoredManagedNode(baseDir, TARGET.platform, TARGET.arch),
    ).toBeNull()
  })
})

describe('the pinned hashes', () => {
  test('are 64 hex characters each', () => {
    // A typo here would refuse every download, silently; catch it in CI.
    const source = fs.readFileSync(
      path.join(import.meta.dir, '../tools/sponsored-managed-node.ts'),
      'utf8',
    )
    const hashes = [...source.matchAll(/'([0-9a-f]{64})'/g)].map((m) => m[1])
    expect(hashes).toHaveLength(4)
    expect(new Set(hashes).size).toBe(4)
    expect(createHash('sha256').update('').digest('hex')).not.toBeOneOf(hashes)
  })
})
