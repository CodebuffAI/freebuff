/**
 * The two git-adjacent facts a sponsored run still needs now that it runs in
 * place (#3989): a way to ask git a question, and where the run's private
 * `HOME`/`TMPDIR` lives.
 *
 * What used to sit beside them -- creating, removing and inspecting a linked
 * worktree, cutting a branch, reading its head -- went with the worktree flow.
 * An in-place run makes no checkout and moves no ref; git is only ever READ,
 * by the capability probe and the target resolver.
 */
import { join } from 'path'

export type GitResult = { exitCode: number; stdout: string; stderr: string }
/** One git invocation. Injected so every path below is testable without one. */
export type GitRunner = (args: string[], cwd?: string) => Promise<GitResult>

const GIT_TIMEOUT_MS = 60_000

export const bunGitRunner: GitRunner = async (args, cwd) => {
  try {
    const proc = Bun.spawn(['git', ...args], {
      ...(cwd ? { cwd } : {}),
      stdout: 'pipe',
      stderr: 'pipe',
      signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { exitCode, stdout, stderr }
  } catch (error) {
    // A THROW IS A RESULT, not an exception to propagate. `git` missing from
    // PATH and `git` exiting 128 are the same thing to every caller here, and
    // the message is the most useful string a `diagnostic_reason` can carry.
    return {
      exitCode: -1,
      stdout: '',
      stderr: `git could not be run: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
}

/**
 * The run's private `HOME`/`TMPDIR`: the same place Desktop puts it
 * (`freebuff-desktop/src/server/services/turn.ts`), under the project's own
 * `.freebuff/`, which the capability probe and the user's review both ignore.
 */
export function sponsoredRuntimeDir(
  projectRoot: string,
  runId: string,
): string {
  return join(projectRoot, '.freebuff', 'sponsored-runtime', runId)
}
