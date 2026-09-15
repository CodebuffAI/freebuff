/** Privacy-cleared CLI evidence for the v2 sponsored-delivery route. */
import {
  type CapabilityInspection,
  type SponsoredCapability,
  type SponsoredCapabilityReason,
} from '@codebuff/common/ads/sponsored-capability'
import { repoFullNameFromRemote } from '@codebuff/common/ads/sponsored-proposal-target'
import type { SponsoredLocalContainment } from '@codebuff/common/ads/sponsored-local-execution'
import { existsSync, readFileSync } from 'fs'
import { release } from 'node:os'
import { join } from 'path'

import { sponsoredContainment } from '../../../sdk/src/tools/sponsored-sandbox'
import { bunGitRunner, type GitRunner } from './sponsored-worktree'

export type SponsoredCliCapabilityResult = {
  sponsoredCapability: SponsoredCapability | null
  capabilityInspection: CapabilityInspection
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DATABASE_BOUNDARY =
  /(^|\/)(?:supabase\/migrations|prisma(?:\/migrations|\/schema\.prisma)|migrations)(?:\/|$)|(^|\/)drizzle\.config\.[^/]+$/i

type PackageJson = {
  packageManager?: unknown
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
}

function unavailable(
  reason: SponsoredCapabilityReason,
): SponsoredCliCapabilityResult {
  return {
    sponsoredCapability: null,
    capabilityInspection: { status: 'unavailable', reason },
  }
}

function packageManager(
  pkg: PackageJson,
  files: ReadonlySet<string>,
): SponsoredCapability['packageManager'] {
  const declared =
    typeof pkg.packageManager === 'string'
      ? pkg.packageManager.split('@', 1)[0]
      : ''
  if (
    declared === 'bun' ||
    declared === 'npm' ||
    declared === 'pnpm' ||
    declared === 'yarn'
  )
    return declared
  if (files.has('bun.lock') || files.has('bun.lockb')) return 'bun'
  if (files.has('pnpm-lock.yaml')) return 'pnpm'
  if (files.has('yarn.lock')) return 'yarn'
  return files.has('package-lock.json') || files.has('npm-shrinkwrap.json')
    ? 'npm'
    : 'unknown'
}

function framework(
  packages: Record<string, unknown>,
  manifest: boolean,
  files: ReadonlySet<string>,
): SponsoredCapability['framework'] {
  if (Object.prototype.hasOwnProperty.call(packages, 'next')) return 'nextjs'
  const knownUnsupported = ['vue', 'svelte', '@angular/core', 'solid-js'].some(
    (name) => Object.prototype.hasOwnProperty.call(packages, name),
  )
  const react =
    Object.prototype.hasOwnProperty.call(packages, 'react') ||
    Object.prototype.hasOwnProperty.call(packages, '@vitejs/plugin-react')
  if (
    !knownUnsupported &&
    react &&
    (Object.prototype.hasOwnProperty.call(packages, 'vite') ||
      [...files].some((file) => /^vite\.config\.[cm]?[jt]sx?$/.test(file)))
  )
    return 'react-vite'
  if (knownUnsupported) return 'unsupported'
  if (
    ['express', 'fastify', 'koa', 'hono'].some((name) =>
      Object.prototype.hasOwnProperty.call(packages, name),
    ) ||
    ['server.ts', 'server.js', 'index.ts', 'index.js'].some((file) =>
      files.has(file),
    )
  )
    return 'nodejs'
  return manifest ? 'unsupported' : 'unknown'
}

function workspaceId(root: string): string | null {
  try {
    const value = readFileSync(join(root, '.freebuff', 'project-id'), 'utf8')
      .trim()
      .toLowerCase()
    return UUID.test(value) ? value : null
  } catch {
    return null
  }
}

function execution(
  platform: NodeJS.Platform,
  containment: (platform: NodeJS.Platform) => SponsoredLocalContainment,
): SponsoredCapability['execution'] | SponsoredCapabilityReason {
  if (platform === 'win32') return 'windows_no_containment'
  if (platform !== 'darwin' && platform !== 'linux')
    return 'unsupported_platform'
  const contained = containment(platform)
  if (!contained.available)
    return contained.reason === 'bubblewrap-missing'
      ? 'bubblewrap_missing'
      : contained.reason === 'containment-probe-failed'
        ? 'containment_probe_failed'
        : 'unsupported_platform'
  return {
    surface:
      platform === 'darwin'
        ? 'cli_macos'
        : release().toLowerCase().includes('microsoft')
          ? 'cli_wsl'
          : 'cli_linux',
    status: 'available',
  }
}

/** Read-only inspection; it never creates a workspace marker or touches Git state. */
export async function sponsoredCliCapability(
  root: string,
  git: GitRunner = bunGitRunner,
  platform: NodeJS.Platform = process.platform,
  containment: (
    platform: NodeJS.Platform,
  ) => SponsoredLocalContainment = sponsoredContainment,
): Promise<SponsoredCliCapabilityResult> {
  const runtime = execution(platform, containment)
  if (typeof runtime === 'string') return unavailable(runtime)
  try {
    const [inside, remote, tracked, head] = await Promise.all([
      git(['-C', root, 'rev-parse', '--is-inside-work-tree']),
      git(['-C', root, 'remote', 'get-url', 'origin']),
      git(['-C', root, 'ls-files']),
      git(['-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}']),
    ])
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true')
      return unavailable('no_git_repository')
    if (tracked.exitCode !== 0) return unavailable('inspection_failed')
    if (head.exitCode !== 0 || !head.stdout.trim())
      return unavailable('no_committed_head')
    const repoFullName =
      remote.exitCode === 0
        ? repoFullNameFromRemote(remote.stdout.trim())
        : null
    const localId = repoFullName ? null : workspaceId(root)
    if (!repoFullName && !localId)
      return unavailable('missing_workspace_identity')
    const files = new Set(
      tracked.stdout
        .split('\n')
        .map((file) => file.trim())
        .filter(Boolean),
    )
    let pkg: PackageJson = {}
    let manifest = false
    try {
      const manifestPath = join(root, 'package.json')
      manifest = existsSync(manifestPath)
      if (manifest)
        pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageJson
    } catch {
      return unavailable('unreadable_package_manifest')
    }
    const packages = { ...pkg.dependencies, ...pkg.devDependencies }
    return {
      sponsoredCapability: {
        schemaVersion: 2,
        target: repoFullName
          ? { kind: 'repo', repoFullName }
          : { kind: 'workspace', workspaceId: localId! },
        framework: framework(packages, manifest, files),
        packageManager: packageManager(pkg, files),
        hasSupabaseBoundary:
          Object.keys(packages).some(
            (name) => name === 'supabase' || name.startsWith('@supabase/'),
          ) || [...files].some((file) => file.startsWith('supabase/')),
        hasCommittedDatabaseBoundary: [...files].some((file) =>
          DATABASE_BOUNDARY.test(file),
        ),
        hasGitRepository: true,
        hasCommittedHead: true,
        execution: runtime,
      },
      capabilityInspection: { status: 'available' },
    }
  } catch {
    return unavailable('inspection_failed')
  }
}
