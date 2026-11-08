import { createRequire } from 'module'

import { Argument, Command } from 'commander'

import { IS_FREEBUFF, type AgentMode } from './utils/constants'
import { getCliEnv } from './utils/env'

const require = createRequire(import.meta.url)

export type ParsedArgs = {
  initialPrompt: string | null
  command?: string
  agent?: string
  clearLogs: boolean
  continue: boolean
  continueId?: string | null
  cwd?: string
  initialMode?: AgentMode
  /** Load repository `.agents` content without the trust prompt (CI opt-in). */
  trustAgents: boolean
}

export function loadPackageVersion(): string {
  const env = getCliEnv()
  if (env.CODEBUFF_CLI_VERSION) {
    return env.CODEBUFF_CLI_VERSION
  }

  try {
    const pkg = require('../package.json') as { version?: string }
    if (pkg.version) {
      return pkg.version
    }
  } catch {
    // Continue to dev fallback
  }

  return 'dev'
}

export function parseArgs({
  argv = process.argv,
  isFreebuff = IS_FREEBUFF,
  version = loadPackageVersion(),
}: {
  argv?: string[]
  isFreebuff?: boolean
  version?: string
} = {}): ParsedArgs {
  const program = new Command()

  if (isFreebuff) {
    // Freebuff: simplified CLI - no prompt args, no agent override, no clear-logs
    program
      .name('freebuff')
      .description('Freebuff - Free AI coding assistant')
      .version(version, '-v, --version', 'Print the CLI version')
      .option(
        '--continue [conversation-id]',
        'Continue from a previous conversation (optionally specify a conversation id)',
      )
      .option(
        '--cwd <directory>',
        'Set the working directory (default: current directory)',
      )
      .option(
        '--trust-agents',
        "Load this repository's .agents files and mcp.json without asking (for CI)",
      )
      .addArgument(
        new Argument(
          '[prompt...]',
          'Command to run (login, or doctor), or an initial prompt to send to the agent',
        ),
      )
      .allowExcessArguments(true)
      .helpOption('-h, --help', 'Show this help message')
  } else {
    // Codebuff: full CLI with all options
    program
      .name('codebuff')
      .description('Codebuff CLI - AI-powered coding assistant')
      .version(version, '-v, --version', 'Print the CLI version')
      .option(
        '--agent <agent-id>',
        'Run a specific agent id (skips loading local .agents overrides)',
      )
      .option(
        '--clear-logs',
        'Remove any existing CLI log files before starting',
      )
      .option(
        '--continue [conversation-id]',
        'Continue from a previous conversation (optionally specify a conversation id)',
      )
      .option(
        '--cwd <directory>',
        'Set the working directory (default: current directory)',
      )
      .option(
        '--trust-agents',
        "Load this repository's .agents files and mcp.json without asking (for CI)",
      )
      .option('--lite', 'Start in LITE mode')
      .option('--free', 'Start in LITE mode (deprecated alias)')
      .option('--max', 'Start in MAX mode')
      .option('--plan', 'Start in PLAN mode')
      .addHelpText(
        'after',
        '\nCommands:\n  login                          Log in to your account\n  publish                        Publish agents to the registry\n  doctor                         Check this computer for common problems',
      )
      .helpOption('-h, --help', 'Show this help message')
      .argument('[prompt...]', 'Initial prompt to send to the agent')
      .allowExcessArguments(true)
  }

  program.parse(argv)

  const options = program.opts()
  const args = program.args

  const continueFlag = options.continue

  // Determine initial mode from flags (last flag wins if multiple specified)
  // Freebuff always uses LITE mode
  let initialMode: AgentMode | undefined
  if (isFreebuff) {
    initialMode = 'LITE'
  } else {
    if (options.free || options.lite) initialMode = 'LITE'
    if (options.max) initialMode = 'MAX'
    if (options.plan) initialMode = 'PLAN'
  }

  // Freebuff accepts a first task the way Codebuff does: bare words that are not
  // one of its commands become the session's initial prompt, so a launcher can
  // start the session with its task instead of typing it into the TUI.
  const freebuffCommands: readonly string[] = ['login', 'doctor']
  const freebuffCommand =
    isFreebuff && args[0] !== undefined && freebuffCommands.includes(args[0])
      ? args[0]
      : undefined

  return {
    initialPrompt:
      args.length > 0 && (!isFreebuff || freebuffCommand === undefined)
        ? args.join(' ')
        : null,
    command: isFreebuff ? freebuffCommand : args[0],
    agent: options.agent,
    clearLogs: options.clearLogs || false,
    continue: Boolean(continueFlag),
    continueId:
      typeof continueFlag === 'string' && continueFlag.trim().length > 0
        ? continueFlag.trim()
        : null,
    cwd: options.cwd,
    initialMode,
    trustAgents: Boolean(options.trustAgents),
  }
}
