import { spawn } from 'child_process'
import os from 'os'

import { getCliEnv } from './env'
import { logger } from './logger'

import type { CliEnv } from '../types/env'

const isWindows = os.platform() === 'win32'
const isMac = os.platform() === 'darwin'

const escapeForShell = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`

const escapeForCmd = (value: string): string =>
  `"${value.replace(/"/g, '""')}"`

// `%f` or `{file}`, with any matching quotes a user put around it (`"%f"`):
// the substituted path is already quoted, and quoting it twice would hand the
// editor a path with literal quote marks in it.
const FILE_PLACEHOLDER = /(["']?)(%f|\{file\})\1/g

// filePath must already be shell-quoted: the command runs with `shell: true`, and
// the path can come from a repo (agent file names). The function replacer keeps
// `$&` / `$'` in a file name from being read as replacement patterns.
const replaceFilePlaceholder = (command: string, filePath: string): string =>
  command.replace(FILE_PLACEHOLDER, () => filePath)

const buildEditorCommands = (
  filePath: string,
  env: CliEnv = getCliEnv(),
): string[] => {
  const commands: string[] = []
  const shellPath = isWindows ? escapeForCmd(filePath) : escapeForShell(filePath)

  // Check custom editor env vars
  const editorValues = [
    env.CODEBUFF_CLI_EDITOR,
    env.CODEBUFF_EDITOR,
    env.VISUAL,
    env.EDITOR,
  ]

  for (const value of editorValues) {
    if (!value) continue
    const withFile = replaceFilePlaceholder(value, shellPath)
    if (withFile !== value) {
      commands.push(withFile)
    } else {
      commands.push(`${value} ${shellPath}`)
    }
  }

  const termProgram = (env.TERM_PROGRAM || '').toLowerCase()
  const candidates: Array<{ detect: boolean; command: string }> = [
    {
      detect:
        termProgram.includes('vscode') ||
        env.VSCODE_GIT_IPC_HANDLE !== undefined ||
        env.VSCODE_PID !== undefined,
      command: `code --goto ${shellPath}`,
    },
    {
      detect:
        termProgram.includes('cursor') ||
        env.CURSOR_PORT !== undefined ||
        env.CURSOR !== undefined,
      command: `cursor --goto ${shellPath}`,
    },
    {
      detect:
        termProgram.includes('zed') ||
        env.ZED_NODE_ENV !== undefined,
      command: `zed --add ${shellPath}`,
    },
    {
      detect: termProgram.includes('sublime'),
      command: `subl ${shellPath}`,
    },
    {
      detect: termProgram.includes('atom'),
      command: `atom ${shellPath}`,
    },
  ]

  for (const candidate of candidates) {
    if (candidate.detect) {
      commands.push(candidate.command)
    }
  }

  if (isMac) {
    commands.push(`open ${shellPath}`)
  } else if (isWindows) {
    commands.push(`start "" ${escapeForCmd(filePath)}`)
  } else {
    commands.push(`xdg-open ${shellPath}`)
  }

  return [...new Set(commands)]
}

const runCommand = async (command: string): Promise<boolean> => {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: 'ignore',
      detached: true,
    })

    child.on('error', () => {
      resolve(false)
    })

    child.on('close', (code) => {
      resolve(code === 0)
    })

    try {
      child.unref()
    } catch {
      // noop
    }
  })
}

export const openFileAtPath = async (
  filePath: string,
  env: CliEnv = getCliEnv(),
): Promise<boolean> => {
  const commands = buildEditorCommands(filePath, env)

  for (const command of commands) {
    // eslint-disable-next-line no-await-in-loop
    const success = await runCommand(command)
    if (success) {
      return true
    }
  }

  logger.warn(
    { filePath, commands },
    'Failed to open file with any configured editor command',
  )
  return false
}
