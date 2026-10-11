/**
 * THE evaluator for a sponsored skill's checks. The Desktop step driver and
 * the sponsored eval both call this, over their own worktree, so "step 3
 * passed" means the same thing in a user's run and on the eval bench.
 *
 * Dependency-free: the caller supplies file access and command execution
 * through {@link SponsoredSkillCheckContext}; commands run wherever the
 * caller's sandbox runs them. Nothing here asks a model.
 */

import {
  sponsoredSkillGlob,
  type SponsoredSkill,
  type SponsoredSkillCheck,
  type SponsoredSkillScript,
} from './sponsored-skill'

export type SponsoredSkillCheckStatus = 'pass' | 'fail' | 'skipped'

export type SponsoredSkillCheckResult = {
  id: string
  label: string
  status: SponsoredSkillCheckStatus
  /** Why, in one line. On `fail` this is what the agent is told to fix. */
  detail: string
}

export type SponsoredSkillCommandResult = {
  exitCode: number
  output: string
  /** The command could not be started at all (missing binary, sandbox refusal). */
  unavailable?: boolean
}

export type SponsoredSkillCheckContext = {
  /** Every file in the worktree (tracked and untracked, ignored files excluded), repo-relative. */
  files(): Promise<string[]> | string[]
  /** Paths this run added or modified since the base revision. Deleted paths excluded. */
  changedFiles(): Promise<string[]> | string[]
  /** File text, or null when absent. */
  readFile(path: string): Promise<string | null> | string | null
  /** Runs `<package manager> run <script>`; `missing` when package.json has no such script. */
  runScript(
    script: SponsoredSkillScript,
    timeoutSeconds: number,
  ): Promise<SponsoredSkillCommandResult | 'missing'>
  /** Runs argv with `argv[0]` already resolved (node, or a declared tool's pinned npx form). */
  runCommand(
    argv: string[],
    timeoutSeconds: number,
  ): Promise<SponsoredSkillCommandResult>
  /** Whether the user handed this run the named credential. Never its value. */
  credentialProvided(env: string): boolean
  /** Whether the user answered Yes to the prompt of the step that owns `checkId`. */
  userConfirmed(checkId: string): boolean
}

const DEFAULT_TIMEOUT_SECONDS = 120
const OUTPUT_TAIL = 600

/**
 * A service-role key by name anywhere, a secret behind a browser-visible
 * prefix, and live secret literals. A server-only `<VENDOR>_SECRET_KEY` name
 * is legitimate and passes; its VALUE in a committed file does not.
 */
const PRIVILEGED_SECRET_PATTERNS: readonly RegExp[] = [
  /SERVICE_ROLE_KEY/i,
  /\b(?:NEXT_PUBLIC|VITE|EXPO_PUBLIC|PUBLIC)_[A-Z0-9_]*(?:SERVICE_ROLE|SECRET)/i,
  /\bsb_secret_[A-Za-z0-9_-]{12,}/,
  /\bsk_live_[A-Za-z0-9]{12,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?:service[_ -]?role|secret[_ -]?key)\s*[:=]\s*["'][^"']{12,}["']/i,
]

function result(
  check: SponsoredSkillCheck,
  status: SponsoredSkillCheckStatus,
  detail: string,
): SponsoredSkillCheckResult {
  return { id: check.id, label: check.label, status, detail }
}

function tail(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > OUTPUT_TAIL
    ? `…${trimmed.slice(-OUTPUT_TAIL)}`
    : trimmed
}

async function matching(
  ctx: SponsoredSkillCheckContext,
  glob: string,
  changedOnly: boolean,
): Promise<string[]> {
  const re = sponsoredSkillGlob(glob)
  const candidates = changedOnly ? await ctx.changedFiles() : await ctx.files()
  return candidates.filter((path) => re.test(path)).sort()
}

function packageDeclared(packageJson: string, name: string): boolean {
  try {
    const parsed = JSON.parse(packageJson) as Record<string, unknown>
    return [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ].some((field) => {
      const deps = parsed[field]
      return typeof deps === 'object' && deps !== null && name in deps
    })
  } catch {
    return false
  }
}

function envKeyDeclared(text: string, key: string): boolean {
  return text
    .split(/\r?\n/)
    .some((line) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line))
}

/**
 * Runs one check. Never throws for a check's own failure: a missing file or a
 * non-zero exit is a `fail` with a reason the agent can act on.
 */
export async function evaluateSponsoredSkillCheck(
  check: SponsoredSkillCheck,
  ctx: SponsoredSkillCheckContext,
  skill: Pick<SponsoredSkill, 'tools'>,
): Promise<SponsoredSkillCheckResult> {
  switch (check.kind) {
    case 'file_exists': {
      const hits = await matching(ctx, check.path, false)
      return hits.length
        ? result(check, 'pass', `found ${hits[0]}`)
        : result(check, 'fail', `no file matches ${check.path}`)
    }
    case 'file_contains': {
      const files = await matching(ctx, check.path, check.changedOnly ?? true)
      const re = new RegExp(check.pattern, check.flags)
      const scope = (check.changedOnly ?? true) ? 'changed file' : 'file'
      if (check.absent) {
        for (const path of files) {
          if (re.test((await ctx.readFile(path)) ?? '')) {
            return result(
              check,
              'fail',
              `${path} matches /${check.pattern}/, which must not appear`,
            )
          }
        }
        return result(check, 'pass', `${files.length} ${scope}(s) checked`)
      }
      if (!files.length)
        return result(check, 'fail', `no ${scope} matches ${check.path}`)
      for (const path of files) {
        if (re.test((await ctx.readFile(path)) ?? ''))
          return result(check, 'pass', `${path} matches`)
      }
      return result(
        check,
        'fail',
        `no ${scope} matching ${check.path} contains /${check.pattern}/`,
      )
    }
    case 'package_declared': {
      const packageJson = await ctx.readFile('package.json')
      if (packageJson === null)
        return result(check, 'fail', 'package.json is missing')
      return packageDeclared(packageJson, check.name)
        ? result(check, 'pass', `package.json declares ${check.name}`)
        : result(check, 'fail', `package.json does not declare ${check.name}`)
    }
    case 'env_key_declared': {
      for (const path of await matching(ctx, check.path, false)) {
        if (envKeyDeclared((await ctx.readFile(path)) ?? '', check.key)) {
          return result(check, 'pass', `${path} declares ${check.key}`)
        }
      }
      return result(
        check,
        'fail',
        `no file matching ${check.path} declares ${check.key}=`,
      )
    }
    case 'credential_provided':
      return ctx.credentialProvided(check.envKey)
        ? result(check, 'pass', `${check.envKey} was provided`)
        : result(check, 'fail', `${check.envKey} was not provided`)
    case 'user_confirmed':
      return ctx.userConfirmed(check.id)
        ? result(check, 'pass', 'the user confirmed it')
        : result(check, 'fail', 'the user has not confirmed it')
    case 'script_passes': {
      const out = await ctx.runScript(
        check.script,
        check.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      )
      if (out === 'missing') {
        return (check.whenMissing ?? 'skip') === 'skip'
          ? result(
              check,
              'skipped',
              `package.json has no ${check.script} script`,
            )
          : result(check, 'fail', `package.json has no ${check.script} script`)
      }
      if (out.unavailable)
        return result(
          check,
          'fail',
          `could not run ${check.script}: ${tail(out.output)}`,
        )
      return out.exitCode === 0
        ? result(check, 'pass', `${check.script} exited 0`)
        : result(
            check,
            'fail',
            `${check.script} exited ${out.exitCode}: ${tail(out.output)}`,
          )
    }
    case 'command_succeeds': {
      const [head, ...rest] = check.argv
      const tool = skill.tools.find((candidate) => candidate.name === head)
      const argv =
        tool?.source === 'npm'
          ? ['npx', '--yes', `${tool.package}@${tool.version}`, ...rest]
          : check.argv
      const out = await ctx.runCommand(
        argv,
        check.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      )
      const shown = check.argv.join(' ')
      if (out.unavailable)
        return result(
          check,
          'fail',
          `could not run ${shown}: ${tail(out.output)}`,
        )
      return out.exitCode === 0
        ? result(check, 'pass', `${shown} exited 0`)
        : result(
            check,
            'fail',
            `${shown} exited ${out.exitCode}: ${tail(out.output)}`,
          )
    }
    case 'no_privileged_secrets': {
      const patterns = check.paths.map(sponsoredSkillGlob)
      const files = (await ctx.changedFiles()).filter((path) =>
        patterns.some((re) => re.test(path)),
      )
      for (const path of files) {
        const text = (await ctx.readFile(path)) ?? ''
        if (PRIVILEGED_SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
          return result(
            check,
            'fail',
            `${path} names or contains a privileged key`,
          )
        }
      }
      return result(check, 'pass', `${files.length} changed file(s) are clean`)
    }
    case 'changes_within': {
      const patterns = check.paths.map(sponsoredSkillGlob)
      const outside = (await ctx.changedFiles()).filter(
        (path) => !patterns.some((re) => re.test(path)),
      )
      return outside.length
        ? result(
            check,
            'fail',
            `changed outside the skill's scope: ${outside.slice(0, 5).join(', ')}`,
          )
        : result(check, 'pass', 'every change is in scope')
    }
  }
}

/** Runs a list of checks in order; the step passes when none fails. */
export async function evaluateSponsoredSkillChecks(
  checks: readonly SponsoredSkillCheck[],
  ctx: SponsoredSkillCheckContext,
  skill: Pick<SponsoredSkill, 'tools'>,
): Promise<{ passed: boolean; results: SponsoredSkillCheckResult[] }> {
  const results: SponsoredSkillCheckResult[] = []
  for (const check of checks)
    results.push(await evaluateSponsoredSkillCheck(check, ctx, skill))
  return { passed: results.every((r) => r.status !== 'fail'), results }
}

/** The retry prompt the step driver hands the agent after a failed check. */
export function sponsoredSkillCheckFeedback(
  results: readonly SponsoredSkillCheckResult[],
): string {
  const failed = results.filter((r) => r.status === 'fail')
  return [
    'These checks failed. Fix the cause, then stop; the checks run again.',
    ...failed.map((r) => `- ${r.label}: ${r.detail}`),
  ].join('\n')
}
