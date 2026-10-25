/**
 * The skill evaluator's view of a LOCAL run's worktree: the
 * `SponsoredSkillCheckContext` the step driver (`sponsored-step-driver.ts`)
 * checks a sponsored skill's steps over, for a run that edits the user's own
 * checkout in place. Shared by Desktop's harness
 * (`freebuff-desktop/src/server/harness/sponsored-step-loop.ts`) and the CLI
 * (`cli/src/utils/sponsored-run.ts`), so "step 3 passed" is measured the same
 * way on both. Each surface supplies its own file system (the sponsored
 * rooted one) and its own sandboxed shell, under the agent's own refusals.
 *
 * Doc: `docs/ads/agentic/step-checks.md`.
 */
import path from 'path'

import { flattenTree, getProjectFileTree } from '../project-file-tree'
import { ENV_TEMPLATE_FILE_PATTERNS } from '../util/env-file-path'

import type {
  SponsoredSkillCheckContext,
  SponsoredSkillCommandResult,
} from './sponsored-skill-checks'
import type { CodebuffFileSystem } from '../types/filesystem'

/** The largest file a check reads; bigger is treated as absent. */
const STEP_CHECK_MAX_FILE_BYTES = 512 * 1024
/**
 * A fix is started only while the run's compute grant outlasts it by this
 * much (Desktop and the CLI alike).
 */
export const SPONSORED_STEP_FIX_MIN_GRANT_MS = 2 * 60_000

/** Each project file's size and mtime when the turn started. */
export type SponsoredStepBaseline = ReadonlyMap<string, string>

/** `.env.example` and its exact-name siblings: what a run may write. */
const ENV_TEMPLATE_NAMES = ENV_TEMPLATE_FILE_PATTERNS.filter(
  (pattern) => !pattern.includes('*'),
)

async function projectFiles(
  fs: CodebuffFileSystem,
  root: string,
): Promise<string[]> {
  // `.freebuff/` is the app's own folder in the project (the run's home,
  // tool caches, the project id). Nothing in it is the run's work, and a
  // package manager's cache there failed scope and secret checks. Skipped
  // during the walk, so a large cache cannot use up the tree's file cap
  // before the project's own files are reached.
  const tree = await getProjectFileTree({
    projectRoot: root,
    fs,
    extraIgnore: ['/.freebuff/'],
  })
  const files = flattenTree(tree)
    .filter((node) => node.type === 'file')
    .map((node) => node.filePath)
  // The project tree hides every `.env*` name, templates included, so a
  // skill's check on the example env file found nothing and its `absent`
  // checks passed unread. Templates are the one env file a run writes: list
  // them beside each package.json, whatever the project's ignore rules say.
  const seen = new Set(files)
  const packages = files
    .filter((file) => path.posix.basename(file) === 'package.json')
    .map((file) => path.posix.dirname(file))
  for (const dir of new Set(['.', ...packages])) {
    for (const name of ENV_TEMPLATE_NAMES) {
      const relative = dir === '.' ? name : `${dir}/${name}`
      if (seen.has(relative)) continue
      if (await stamp(fs, root, relative)) files.push(relative)
    }
  }
  return files
}

async function stamp(
  fs: CodebuffFileSystem,
  root: string,
  relative: string,
): Promise<string | null> {
  try {
    const stat = await fs.stat(path.join(root, relative))
    return stat.isFile() ? `${stat.size}:${stat.mtimeMs}` : null
  } catch {
    return null
  }
}

/**
 * What "this run changed" is measured against. Taken before the agent's
 * first segment: in the user's own checkout the base revision is not the
 * baseline, because the user's uncommitted work is not the run's (and must
 * never earn a `file_contains` check credit).
 */
export async function captureSponsoredStepBaseline(
  fs: CodebuffFileSystem,
  root: string,
): Promise<SponsoredStepBaseline> {
  const baseline = new Map<string, string>()
  for (const file of await projectFiles(fs, root)) {
    const value = await stamp(fs, root, file)
    if (value) baseline.set(file, value)
  }
  return baseline
}

/** The lockfile names the package manager; npm when there is none. */
async function packageManagerOf(
  fs: CodebuffFileSystem,
  root: string,
): Promise<string> {
  return sponsoredPackageManagerFromLockfiles(
    async (name) => (await stamp(fs, root, name)) !== null,
  )
}

/**
 * The project's JavaScript package manager, from which lockfile it has: also
 * what `install_package` installs with (`sponsored-install-tool.ts`).
 */
export async function sponsoredPackageManagerFromLockfiles(
  has: (name: string) => Promise<boolean>,
): Promise<'bun' | 'pnpm' | 'yarn' | 'npm'> {
  if ((await has('bun.lock')) || (await has('bun.lockb'))) return 'bun'
  if (await has('pnpm-lock.yaml')) return 'pnpm'
  if (await has('yarn.lock')) return 'yarn'
  return 'npm'
}

/** One argv as a command line, quoted for the shell the broker runs. */
export function sponsoredStepCommandLine(
  argv: readonly string[],
  shell: 'posix' | 'powershell',
): string {
  return argv
    .map((arg) =>
      /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)
        ? arg
        : shell === 'powershell'
          ? `'${arg.replaceAll("'", "''")}'`
          : `'${arg.replaceAll("'", `'\\''`)}'`,
    )
    .join(' ')
}

/** The skill evaluator's view of this run's worktree and sandbox. */
export function sponsoredStepCheckContext(deps: {
  fs: CodebuffFileSystem
  workspaceRoot: string
  baseline: SponsoredStepBaseline
  /** A command line through the run's sandbox, under the agent's refusals. */
  runCommand: (
    commandLine: string,
    timeoutSeconds: number,
  ) => Promise<SponsoredSkillCommandResult>
  shell: 'posix' | 'powershell'
  credentialNames: () => readonly string[]
  /**
   * The user answered Yes to the run's signup handoff. A run has one, so it
   * stands for whichever user step's `user_confirmed` check asks.
   */
  signupConfirmed: () => boolean
}): SponsoredSkillCheckContext {
  const { fs, workspaceRoot: root } = deps
  const readFile = async (relative: string) => {
    try {
      const absolute = path.join(root, relative)
      const stat = await fs.stat(absolute)
      if (!stat.isFile() || stat.size > STEP_CHECK_MAX_FILE_BYTES) return null
      return await fs.readFile(absolute, 'utf8')
    } catch {
      return null
    }
  }
  return {
    files: () => projectFiles(fs, root),
    changedFiles: async () => {
      const changed: string[] = []
      for (const file of await projectFiles(fs, root)) {
        const now = await stamp(fs, root, file)
        if (now && deps.baseline.get(file) !== now) changed.push(file)
      }
      return changed
    },
    readFile,
    runScript: async (script, timeoutSeconds) => {
      const manifest = await readFile('package.json')
      let scripts: Record<string, unknown> = {}
      try {
        scripts =
          (
            JSON.parse(manifest ?? '{}') as {
              scripts?: Record<string, unknown>
            }
          ).scripts ?? {}
      } catch {
        // An unreadable package.json has no scripts to run.
      }
      if (typeof scripts[script] !== 'string') return 'missing'
      const pm = await packageManagerOf(fs, root)
      return deps.runCommand(
        sponsoredStepCommandLine([pm, 'run', script], deps.shell),
        timeoutSeconds,
      )
    },
    runCommand: (argv, timeoutSeconds) =>
      deps.runCommand(
        sponsoredStepCommandLine(argv, deps.shell),
        timeoutSeconds,
      ),
    credentialProvided: (env) => deps.credentialNames().includes(env),
    userConfirmed: () => deps.signupConfirmed(),
  }
}

/** The terminal tool's result, as the skill evaluator reads a command. */
export function sponsoredStepCommandResult(
  raw: unknown,
): SponsoredSkillCommandResult {
  const value = Array.isArray(raw)
    ? (raw[0] as { value?: Record<string, unknown> } | undefined)?.value
    : undefined
  const text = (key: string) =>
    value && typeof value[key] === 'string' ? (value[key] as string) : ''
  const exitCode =
    value && typeof value.exitCode === 'number' ? value.exitCode : null
  if (exitCode === null) {
    return {
      exitCode: 1,
      output: [text('stdout'), text('stderr'), text('message')]
        .filter(Boolean)
        .join('\n'),
      unavailable: true,
    }
  }
  return {
    exitCode,
    output: [text('stdout'), text('stderr')].filter(Boolean).join('\n'),
  }
}
