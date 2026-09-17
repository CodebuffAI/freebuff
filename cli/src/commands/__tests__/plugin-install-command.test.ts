import path from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  runPluginCommand,
  runPluginInstallCommand,
} from '../plugin-install-command'

import {
  cleanUpPluginTestDirs,
  fetchReturning,
  makeTarball,
  makeTempDir,
  MCP_JSON,
  PLUGIN_JSON,
  SKILL_MD,
} from '../../__tests__/helpers/plugin-fixtures'

afterEach(cleanUpPluginTestDirs)

/**
 * Runs the command and reports what a shell would see: the console output,
 * and the status the process would end with. Both are restored afterwards,
 * so no row inherits the previous row's capture or exit code. The status
 * reset writes 0 rather than `undefined`, which bun keeps as the last value
 * it was given.
 */
async function runCommand(run: () => Promise<void>) {
  const lines: string[] = []
  const originalLog = console.log
  const previousExitCode = process.exitCode
  let exitCode = 0
  process.exitCode = 0
  console.log = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(' '))
  }

  try {
    await run()
    exitCode = Number(process.exitCode ?? 0)
  } finally {
    console.log = originalLog
    process.exitCode = previousExitCode ?? 0
  }

  return { output: lines.join('\n'), exitCode }
}

describe('the plugin command entry', () => {
  /**
   * Given a subcommand that is not `install`, when the command runs, it
   * prints the usage line and exits nonzero.
   */
  test('an unknown subcommand prints usage and exits nonzero', async () => {
    const { output, exitCode } = await runCommand(() =>
      runPluginCommand(['update', 'https://github.com/google/skills']),
    )

    expect(output).toContain('Usage: freebuff plugin install <url>')
    expect(exitCode).toBe(1)
  })
})

describe('the plugin install command runner', () => {
  /**
   * Given an argument count that is not exactly one URL, when the
   * command runs, it prints the usage line and exits nonzero before
   * any install work begins.
   */
  test('not exactly one URL prints usage and exits nonzero', async () => {
    const { output, exitCode } = await runCommand(() =>
      runPluginInstallCommand([], {}),
    )

    expect(output).toContain('Usage: freebuff plugin install <url>')
    expect(output).toContain('https://github.com/owner/repo')
    expect(exitCode).toBe(1)
  })

  /**
   * Given a valid tarball served by the injected fetch, when the command
   * runs, it prints the success render — the check, name, version,
   * source, counts, and the data dir — and exits zero.
   */
  test('a successful install prints the success render', async () => {
    const pluginsRoot = makeTempDir('plugin-cmd-test-')
    const blob = await makeTarball({
      'skills-main/plugin.json': PLUGIN_JSON,
      'skills-main/skills/gcloud/SKILL.md': SKILL_MD,
      'skills-main/mcp.json': MCP_JSON,
    })

    const { output, exitCode } = await runCommand(() =>
      runPluginInstallCommand(['https://github.com/google/skills'], {
        fetchImpl: fetchReturning(blob),
        pluginsRoot,
      }),
    )

    expect(exitCode).toBe(0)
    expect(output).toContain('✔')
    expect(output).toContain('test-plugin 1.0.0')
    expect(output).toContain('github.com/google/skills')
    expect(output).toContain('skills 1 registered')
    expect(output).toContain('mcp 1 server: test-server')
    expect(output).toContain(path.join(pluginsRoot, '.data', 'test-plugin'))
  })

  /**
   * Given a failing install (404), when the command runs, it prints the
   * reason and exits nonzero.
   */
  test('a failed install prints the reason and exits nonzero', async () => {
    const { output, exitCode } = await runCommand(() =>
      runPluginInstallCommand(['https://github.com/google/skills'], {
        fetchImpl: () =>
          Promise.resolve(new Response('not found', { status: 404 })),
        pluginsRoot: makeTempDir('plugin-cmd-test-'),
      }),
    )

    expect(output).toContain('could not download')
    expect(exitCode).toBe(1)
  })

  /**
   * Given a plugin whose skill name collides with an existing skill,
   * when the command runs, it prints the conflict and exits nonzero.
   */
  test('a name conflict prints the collision and exits nonzero', async () => {
    const pluginsRoot = makeTempDir('plugin-cmd-test-')
    const blob = await makeTarball({
      'skills-main/plugin.json': PLUGIN_JSON,
      'skills-main/skills/gcloud/SKILL.md': SKILL_MD,
    })

    const { output, exitCode } = await runCommand(() =>
      runPluginInstallCommand(['https://github.com/google/skills'], {
        fetchImpl: fetchReturning(blob),
        pluginsRoot,
        existingSkillNames: () => new Set(['gcloud']),
      }),
    )

    expect(output).toContain('gcloud')
    expect(exitCode).toBe(1)
  })
})
