/**
 * A NODE.JS WE INSTALL, for a sponsored run on a machine that has none.
 *
 * `missing_node` was the largest environment cause of failed sponsored runs:
 * the procedure says `npx some-cli init` and the machine has no Node. COD-825
 * fixed the case where Node IS installed but the sandbox hid it. This covers
 * the rest: the host (never the sandbox) downloads one pinned official Node.js
 * build from nodejs.org, checks it against a SHA-256 checked into this file,
 * and unpacks it under `~/.freebuff/toolchains/`. A run is then handed that
 * folder READ-ONLY and its `bin` at the END of `PATH`, so a Node the user
 * installed themselves always wins and this one is only the fallback.
 *
 * What holds it safe:
 *
 *  - The bytes are pinned. A download whose SHA-256 is not the one below is
 *    deleted and never unpacked. Bumping the version means pasting new hashes
 *    from that release's `SHASUMS256.txt`, in review.
 *  - The run can read it and never write it: it is granted like the user's own
 *    toolchain (`additionalReadRoots`), so a run cannot plant a binary a later
 *    run would execute. npm's cache and globals stay in the run's private HOME.
 *  - It is installed only when the run's own sandbox cannot start `node`
 *    (asked through the same broker a run's commands use), once per machine,
 *    and reused after. A failed install never fails the run: it starts without
 *    Node exactly as it did before.
 *  - It is complete or absent. It unpacks into a staging folder and is renamed
 *    into place, then marked; a folder without the marker is not used.
 *
 * Out of scope: Windows (the floor has its own runtime story), Bun and Python.
 */
import { spawn } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

/** The Node.js release installed. An LTS line; bump with the hashes below. */
export const SPONSORED_MANAGED_NODE_VERSION = 'v24.21.0'

/**
 * `SHASUMS256.txt` of {@link SPONSORED_MANAGED_NODE_VERSION}, for the four
 * builds a sandboxed run can use (`https://nodejs.org/dist/<version>/`).
 */
const SPONSORED_MANAGED_NODE_SHA256: Readonly<Record<string, string>> =
  Object.freeze({
    'darwin-arm64':
      'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057',
    'darwin-x64':
      '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097',
    'linux-arm64':
      '724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5',
    'linux-x64':
      '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff',
  })

/** The archive is ~53 MB; anything far past that is not the release. */
const SPONSORED_MANAGED_NODE_MAX_BYTES = 96 * 1024 * 1024
export const SPONSORED_MANAGED_NODE_TIMEOUT_MS = 180_000
const VERIFIED_MARKER = '.freebuff-verified'

export type SponsoredManagedNode = {
  /** Grant READ-ONLY (`additionalReadRoots`). */
  root: string
  /** Append to the run's `PATH`, after the user's own entries. */
  binDir: string
}

/** `darwin-arm64` and the like, or null where none is installed. */
export function sponsoredManagedNodeTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const target = `${platform}-${arch}`
  return SPONSORED_MANAGED_NODE_SHA256[target] ? target : null
}

/** `~/.freebuff/toolchains`, where every managed toolchain lives. */
export function sponsoredToolchainsDir(home: string = os.homedir()): string {
  return path.join(home, '.freebuff', 'toolchains')
}

function nodeDirName(target: string): string {
  return `node-${SPONSORED_MANAGED_NODE_VERSION}-${target}`
}

function managedNodeAt(root: string): SponsoredManagedNode {
  return { root, binDir: path.join(root, 'bin') }
}

/**
 * The managed Node already on this machine, or null. Never downloads, so it is
 * safe on the offer path.
 */
export function installedSponsoredManagedNode(
  baseDir: string = sponsoredToolchainsDir(),
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): SponsoredManagedNode | null {
  const target = sponsoredManagedNodeTarget(platform, arch)
  if (!target) return null
  const root = path.join(baseDir, nodeDirName(target))
  try {
    const marker = fs.readFileSync(path.join(root, VERIFIED_MARKER), 'utf8')
    if (marker.trim() !== SPONSORED_MANAGED_NODE_SHA256[target]) return null
    fs.accessSync(path.join(root, 'bin', 'node'), fs.constants.X_OK)
  } catch {
    return null
  }
  return managedNodeAt(root)
}

export type SponsoredManagedNodeDeps = {
  fetch: (url: string, init: { signal: AbortSignal }) => Promise<Response>
  /** Unpacks a `.tar.gz` into `dir`, dropping the archive's top folder. */
  extract: (archive: string, dir: string) => Promise<void>
  log?: (message: string, data?: Record<string, unknown>) => void
}

export function extractSponsoredManagedNodeArchive(
  archive: string,
  dir: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'tar',
      ['-xzf', archive, '-C', dir, '--strip-components=1'],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 2048) stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`tar exited ${code}: ${stderr.trim()}`)),
    )
  })
}

const DEFAULT_DEPS: SponsoredManagedNodeDeps = {
  fetch: (url, init) => fetch(url, init),
  extract: extractSponsoredManagedNodeArchive,
}

/** One install per target per process: concurrent runs share it. */
const inFlight = new Map<string, Promise<SponsoredManagedNode | null>>()

/**
 * The managed Node, installing it first if it is missing. Never throws: null
 * means the run goes ahead without it, as it would have before.
 */
export function ensureSponsoredManagedNode(
  options: {
    baseDir?: string
    platform?: NodeJS.Platform
    arch?: string
    timeoutMs?: number
  } = {},
  deps: SponsoredManagedNodeDeps = DEFAULT_DEPS,
): Promise<SponsoredManagedNode | null> {
  const baseDir = options.baseDir ?? sponsoredToolchainsDir()
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const installed = installedSponsoredManagedNode(baseDir, platform, arch)
  if (installed) return Promise.resolve(installed)
  const target = sponsoredManagedNodeTarget(platform, arch)
  if (!target) return Promise.resolve(null)
  const key = path.join(baseDir, target)
  const pending = inFlight.get(key)
  if (pending) return pending
  const install = installManagedNode(
    baseDir,
    target,
    options.timeoutMs ?? SPONSORED_MANAGED_NODE_TIMEOUT_MS,
    deps,
  ).finally(() => inFlight.delete(key))
  inFlight.set(key, install)
  return install
}

async function installManagedNode(
  baseDir: string,
  target: string,
  timeoutMs: number,
  deps: SponsoredManagedNodeDeps,
): Promise<SponsoredManagedNode | null> {
  const expected = SPONSORED_MANAGED_NODE_SHA256[target]!
  const name = nodeDirName(target)
  const url = `https://nodejs.org/dist/${SPONSORED_MANAGED_NODE_VERSION}/${name}.tar.gz`
  const root = path.join(baseDir, name)
  const nonce = randomUUID()
  const archive = path.join(baseDir, `.${name}.${nonce}.tar.gz`)
  const staging = path.join(baseDir, `.${name}.${nonce}`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    await fs.promises.mkdir(baseDir, { recursive: true })
    const response = await deps.fetch(url, { signal: controller.signal })
    if (!response.ok || !response.body) {
      throw new Error(`download answered ${response.status}`)
    }
    const hash = createHash('sha256')
    const file = fs.createWriteStream(archive, { mode: 0o600 })
    let bytes = 0
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength
        if (bytes > SPONSORED_MANAGED_NODE_MAX_BYTES) {
          throw new Error('download is larger than the release')
        }
        hash.update(chunk)
        if (!file.write(chunk)) {
          await new Promise<void>((resolve) => file.once('drain', resolve))
        }
      }
    } finally {
      await new Promise<void>((resolve) => file.end(resolve))
    }
    const actual = hash.digest('hex')
    if (actual !== expected) {
      throw new Error(`checksum mismatch (${actual.slice(0, 12)}…)`)
    }
    await fs.promises.mkdir(staging, { recursive: true })
    await deps.extract(archive, staging)
    await fs.promises.access(
      path.join(staging, 'bin', 'node'),
      fs.constants.X_OK,
    )
    await fs.promises.writeFile(path.join(staging, VERIFIED_MARKER), expected)
    // A folder left by an earlier, unmarked attempt is not ours to trust.
    await fs.promises.rm(root, { recursive: true, force: true })
    await fs.promises.rename(staging, root)
    deps.log?.('[sponsored] installed managed Node', {
      version: SPONSORED_MANAGED_NODE_VERSION,
      target,
      bytes,
      ms: Date.now() - started,
    })
    return managedNodeAt(root)
  } catch (error) {
    deps.log?.('[sponsored] managed Node not installed', {
      version: SPONSORED_MANAGED_NODE_VERSION,
      target,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  } finally {
    clearTimeout(timer)
    await fs.promises.rm(archive, { force: true }).catch(() => {})
    await fs.promises
      .rm(staging, { recursive: true, force: true })
      .catch(() => {})
  }
}
