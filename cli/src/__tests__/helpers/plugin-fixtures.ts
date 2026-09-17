import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect } from 'bun:test'

import type {
  PluginInstallOptions,
  PluginInstallResult,
} from '../../commands/plugin-install'

/**
 * Fixtures shared by the plugin CLI test files — the install pipeline, the
 * command runner, and the two registry walks — which otherwise each rebuilt
 * the same temp-root registry and served the same plugin files. Each test
 * file registers `cleanUpPluginTestDirs` once with `afterEach`.
 */

/** Temp directories created by the running test file, drained on cleanup. */
const tempDirs: string[] = []

/**
 * A registered temp directory the running test may fill. The prefix names the
 * test file it came from, so a leftover on disk says where to look.
 */
export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/**
 * Discards every temp directory the running test created, so no fixture state
 * crosses into the next test and nothing survives the run.
 */
export function cleanUpPluginTestDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The §5.2 minimal manifest the install rows serve and expect back. */
export const PLUGIN_JSON = JSON.stringify({
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: 'test-plugin',
  version: '1.0.0',
  description: 'a test plugin',
})

/** A skill document the SDK reader accepts, for a skill the manifest lacks. */
export const SKILL_MD = [
  '---',
  'name: gcloud',
  'description: A test skill.',
  '---',
  '',
  'Skill body.',
  '',
].join('\n')

/** A conforming §7.2 mcp.json carrying one streamable-http server. */
export const MCP_JSON = JSON.stringify({
  $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
  mcpServers: {
    'test-server': { type: 'streamable-http', url: 'https://example.com/mcp' },
  },
})

/** A gzipped tarball shaped like a codeload download: `<repo>-<ref>/...`. */
export async function makeTarball(
  entries: Record<string, string>,
): Promise<Blob> {
  const tarPath = path.join(
    makeTempDir('plugin-tarball-test-'),
    'bundle.tar.gz',
  )
  await Bun.Archive.write(tarPath, entries, { compress: 'gzip' })
  return new Blob([readFileSync(tarPath)])
}

/**
 * Asserts the install succeeded, failing with the pipeline's reason
 * otherwise, and returns the result so a row asserts on the installed
 * values rather than guarding its way to them.
 */
export function expectInstallOk(result: PluginInstallResult) {
  expect(result.success).toBe(true)
  if (!result.success) throw new Error(`expected install, got: ${result.error}`)
  return result
}

/** The fetch seam answering every request with the given tarball, status 200. */
export function fetchReturning(
  blob: Blob,
): NonNullable<PluginInstallOptions['fetchImpl']> {
  return () => Promise.resolve(new Response(blob, { status: 200 }))
}
