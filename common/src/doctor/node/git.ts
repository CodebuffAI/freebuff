import { execFile } from 'node:child_process'
import { finding, type DoctorFinding } from '../types'
import type { DoctorRedactor } from '../redact'
import { LEARN_MORE } from '../help'

export type CommandResult = { code: number | null; stdout: string; stderr: string; missing?: boolean }
export type RunCommand = (command: string, args: string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<CommandResult>

/** Runs a read-only command without a shell, bounded in time and output. */
export const runCommand: RunCommand = (command, args, options = {}) =>
  new Promise(resolve => {
    execFile(command, args, {
      cwd: options.cwd, timeout: options.timeoutMs ?? 5_000, maxBuffer: 256 * 1024, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr), missing: (error as { code?: unknown } | null)?.code === 'ENOENT' })
    })
  })

export type GitFolderState = 'repo' | 'not-repo' | 'dubious' | 'missing-folder' | 'no-git' | 'unknown'

export function classifyGitFolder(result: CommandResult): GitFolderState {
  if (result.missing) return 'no-git'
  if (result.code === 0) return 'repo'
  if (/dubious ownership|safe\.directory/i.test(result.stderr)) return 'dubious'
  if (/not a git repository/i.test(result.stderr)) return 'not-repo'
  if (/cannot change to|No such file or directory|ENOENT/i.test(result.stderr)) return 'missing-folder'
  return 'unknown'
}

export async function gitFolderState(dir: string, run: RunCommand = runCommand): Promise<GitFolderState> {
  return classifyGitFolder(await run('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 4_000 }))
}

export function gitFolderFinding(state: GitFolderState, label: string, dir: string, redact: DoctorRedactor,
  repairRef?: string): DoctorFinding | null {
  const where = redact.path(dir)
  if (state === 'dubious')
    return finding('git.dubious-ownership', 'warning', 'git', `Git refuses to work in ${label}`,
      `${where} is owned by another user account, so git stops with "detected dubious ownership". Changes, worktrees and diffs fail for this project.`,
      ['If this is your folder, trust it in git.', 'Otherwise, take ownership of the folder with your own account.'],
      {
        learnMore: LEARN_MORE.gitSafeDirectory,
        ...(repairRef ? { repair: {
          kind: 'trust-git-folder' as const, ref: repairRef, label: 'Trust this folder in git',
          confirm: `Adds ${where} to safe.directory in your global git config. A backup of your git config is saved first, and you can undo this.`,
          warning: 'Only trust folders you own. Git warns about folders owned by other users because a hostile repository can run commands when you use git in it.',
        } } : {}),
      })
  if (state === 'not-repo')
    return finding('git.not-a-repo', 'info', 'git', `${label} is not a git repository`,
      `${where} has no git history, so Freebuff cannot show changes or run chats in their own worktree.`,
      ['Run `git init` in the folder if you want changes and worktrees.'])
  return null
}

export async function gitInstallFindings(platform: string, run: RunCommand = runCommand): Promise<DoctorFinding[]> {
  const version = await run('git', ['--version'], { timeoutMs: 4_000 })
  if (version.missing || version.code !== 0)
    return [finding('git.missing', 'error', 'git', 'Git is not installed', 'Freebuff uses git for changes, worktrees and pull requests.',
      [platform === 'darwin' ? 'Run `xcode-select --install`, or install git from git-scm.com.' : 'Install git from git-scm.com (or your package manager), then restart Freebuff.'])]
  const out: DoctorFinding[] = [finding('git.ok', 'ok', 'git', 'Git is installed', version.stdout.trim())]
  if (platform === 'win32') {
    const longpaths = await run('git', ['config', '--global', '--get', 'core.longpaths'], { timeoutMs: 4_000 })
    if (longpaths.stdout.trim() !== 'true')
      out.push(finding('git.longpaths-off', 'info', 'git', 'Git long paths are off',
        'On Windows, git cannot check out files whose path is longer than 260 characters unless core.longpaths is on. Deep node_modules trees and worktrees hit this.',
        ['Run `git config --global core.longpaths true`.'], { learnMore: LEARN_MORE.windowsLongPaths }))
  }
  return out
}
