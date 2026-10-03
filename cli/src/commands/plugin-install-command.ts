import { green, red, yellow } from 'picocolors'

import {
  handlePluginInstall,
  type PluginInstallOptions,
  type PluginInstallResult,
} from './plugin-install'
import { loadMCPConfigSync, loadSkillsSync } from '@codebuff/sdk'

const USAGE = 'Usage: freebuff plugin install <url>'

/** Shown under the usage line when the URL argument is missing or doubled. */
const URL_EXAMPLE =
  'Expected the plugin URL, e.g. https://github.com/owner/repo/path/to/plugin.'

/**
 * The names already present in the user's own skill and MCP roots — the
 * same roots the session reads at startup, so install cannot disagree
 * with the session about what a name conflict is.
 */
function userSkillNames(): Set<string> {
  try {
    return new Set(
      Object.keys(
        loadSkillsSync({
          cwd: process.cwd(),
          verbose: false,
          includeHomeSkills: true,
        }),
      ),
    )
  } catch {
    return new Set()
  }
}

function userMcpServerNames(): Set<string> {
  try {
    return new Set(
      Object.keys(loadMCPConfigSync({ verbose: false }).mcpServers),
    )
  } catch {
    return new Set()
  }
}

/**
/**
 * Prints the usage line — with `detail` under it when the caller has one —
 * and exits nonzero: the answer to every mistake on this command line.
 */
function failWithUsage(detail?: string): void {
  console.log(yellow(detail ? `${USAGE}\n\n${detail}` : USAGE))
  process.exitCode = 1
}

/**
 * The `freebuff plugin` command entry: everything after `plugin` on the
 * command line. The only subcommand is `install`; anything else prints
 * the usage line and exits nonzero.
 */
export async function runPluginCommand(rawArgs: string[]): Promise<void> {
  if (rawArgs[0] !== 'install') {
    failWithUsage()
    return
  }
  await runPluginInstallCommand(rawArgs.slice(1))
}

/**
 * Prints the success render: the check line naming the plugin, its version,
 * and where it came from, then what was registered, the data dir, and any
 * reports the load gathered.
 */
function renderInstalled(installed: PluginInstallResult, url: string): void {
  console.log(
    green(
      `✔ ${installed.pluginName} ${installed.version} ← ${url.replace(/^https:\/\//, '')}`,
    ),
  )
  console.log(green(`  skills ${installed.skillsCount} registered`))

  const servers = installed.mcpServers ?? []
  if (servers.length > 0) {
    console.log(
      green(
        `  mcp ${servers.length} server${servers.length === 1 ? '' : 's'}: ${servers.join(', ')}`,
      ),
    )
  }

  if (installed.dataDir) {
    console.log(green(`  data ${installed.dataDir} (created)`))
  }

  for (const report of installed.reports ?? []) {
    console.log(yellow(`  ⚠ [${report.section}] ${report.message}`))
  }
}

/**
 * The `freebuff plugin install <url>` command: validates the arguments,
 * runs the install pipeline with the user's real roots — the name sets
 * the conflict check runs against come from the same skill and MCP roots
 * the session reads — and prints the outcome. The URL comes from the
 * dispatch site, which forwards everything after `install` on the
 * command line.
 */
export async function runPluginInstallCommand(
  args: string[],
  options: PluginInstallOptions = {},
): Promise<void> {
  if (args.length !== 1) {
    failWithUsage(URL_EXAMPLE)
    return
  }

  const url = args[0]!

  const result = await handlePluginInstall(url, {
    ...options,
    existingSkillNames: options.existingSkillNames ?? userSkillNames,
    existingMcpServerNames:
      options.existingMcpServerNames ?? userMcpServerNames,
  })

  if (!result.success) {
    console.log(red(`✗ ${result.error ?? 'the install failed'}`))
    process.exitCode = 1
    return
  }

  renderInstalled(result, url)
}
