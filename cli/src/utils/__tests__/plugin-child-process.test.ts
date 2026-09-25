import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

let tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'plugin-child-process-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // A spawned child can still hold a fixture dir on Windows; the OS
      // reclaims it and the next run uses a fresh mkdtemp anyway.
    }
  }
  tempDirs = []
})

const PLUGIN_JSON = JSON.stringify({
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: 'test-plugin',
  version: '1.0.0',
  description: 'a test plugin',
})

const SKILL_MD = (description: string) =>
  [
    '---',
    `name: ${description}`,
    `description: ${description}`,
    '---',
    '',
    'Skill body.',
    '',
  ].join('\n')

/** A fixture project: one skill in the project's own .agents/skills. */
function makeProjectDir(): string {
  const projectDir = makeTempDir()
  const skillDir = path.join(projectDir, '.agents', 'skills', 'project-skill')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(path.join(skillDir, 'SKILL.md'), SKILL_MD('project-skill'))
  return projectDir
}

/** A fixture plugins root holding one installed plugin: 2 skills, 1 server. */
function makePluginsRoot(): string {
  const pluginsRoot = makeTempDir()
  const pluginDir = path.join(pluginsRoot, 'test-plugin')
  const skillsDir = path.join(pluginDir, 'skills')
  mkdirSync(path.join(skillsDir, 'gcloud'), { recursive: true })
  mkdirSync(path.join(skillsDir, 'second-skill'), { recursive: true })
  writeFileSync(path.join(pluginDir, 'plugin.json'), PLUGIN_JSON)
  writeFileSync(path.join(skillsDir, 'gcloud', 'SKILL.md'), SKILL_MD('gcloud'))
  writeFileSync(
    path.join(skillsDir, 'second-skill', 'SKILL.md'),
    SKILL_MD('second-skill'),
  )
  writeFileSync(
    path.join(pluginDir, 'mcp.json'),
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: {
        'test-server': {
          type: 'streamable-http',
          url: 'https://example.com/mcp',
        },
      },
    }),
  )
  return pluginsRoot
}

/**
 * Spawns the probe as a separate bun child process — a new process, so
 * the registries' module-level caches start empty there — runs the real
 * registry startup against the fixture roots, and returns what those
 * caches hold in that process.
 */
async function probeFreshProcess(
  projectDir: string,
  pluginsRoot: string | null,
): Promise<{ skills: string[]; servers: Record<string, string> }> {
  const homeFixture = makeTempDir()
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env.HOME = homeFixture
  env.USERPROFILE = homeFixture
  env.FREEBUFF_CONFIG_DIR = homeFixture
  delete env.FREEBUFF_PLUGINS_ROOT
  if (pluginsRoot) {
    env.FREEBUFF_PLUGINS_ROOT = pluginsRoot
  }

  const probePath = path.join(import.meta.dir, 'child-process-probe.ts')
  const child = Bun.spawn([process.execPath, probePath, projectDir], {
    cwd: projectDir,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ])
  child.kill()

  if (exitCode !== 0) {
    const stderr = await new Response(child.stderr).text()
    throw new Error(`probe failed (${exitCode}):\n${stderr}`)
  }
  const lastLine = stdout.trim().split('\n').at(-1) ?? ''
  return JSON.parse(lastLine) as {
    skills: string[]
    servers: Record<string, string>
  }
}

describe('a separate bun process discovers what install wrote', () => {
  /**
   * Given a fixture project skill and an installed plugin (2 skills, 1
   * server), when a separate bun process runs the real registry startup
   * with empty caches, its caches hold both the project's own skill and
   * the plugin's skills, and the plugin's server sits in its server map
   * in the freebuff shape — discovery needs no in-process refresh.
   */
  test(
    'plugin skills and server join the child process caches',
    async () => {
      const projectDir = makeProjectDir()
      const pluginsRoot = makePluginsRoot()

      const report = await probeFreshProcess(projectDir, pluginsRoot)

      expect(report.skills).toContain('project-skill')
      expect(report.skills).toContain('gcloud')
      expect(report.skills).toContain('second-skill')
      expect(report.servers['test-server']).toBe('http https://example.com/mcp')
    },
    { timeout: 30_000 },
  )

  /**
   * Given a machine with no plugins root at all, when a separate bun
   * process runs the real registry startup, it starts clean — the
   * project's own skill is there, no plugin-shaped anything is, and
   * nothing throws.
   */
  test(
    'a machine with no plugins root starts clean',
    async () => {
      const projectDir = makeProjectDir()

      const report = await probeFreshProcess(projectDir, null)

      expect(report.skills).toEqual(['project-skill'])
      expect(report.servers).toEqual({})
    },
    { timeout: 30_000 },
  )
})
