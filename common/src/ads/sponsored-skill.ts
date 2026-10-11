/**
 * THE per-advertiser skill format for sponsored (agentic-ad) runs.
 *
 * The advertiser no longer writes a procedure. They state a goal, and we write
 * and test a skill for it: numbered steps, each marked as something the agent
 * does, something only the user can do, or a pure check, with a code check
 * per step, the environment it needs and the exact packages it may install.
 * Format, consent and hash-lock rules: `docs/ads/agentic/sponsored-skills.md`.
 *
 * Dependency-free on purpose, like {@link ./sponsored-acceptance-criteria.ts}:
 * Next, Convex V8 and Desktop all import this. Nothing here reads a file,
 * runs a command or sees a secret. The step driver evaluates checks; this
 * module only defines and validates them.
 *
 * A skill is DATA, never code: it is reviewed as text, shown at consent,
 * locked by {@link sponsoredSkillSha256} at Accept, and run by our own agent.
 */

import {
  declaredRunCredentials,
  type SponsoredRunCredential,
} from './sponsored-run-credentials'
import { parseSponsoredProcedureSteps } from './sponsored-procedure-steps'
import { sha256Hex } from '../util/hash'

export const SPONSORED_SKILL_FORMAT = 1 as const

export const SPONSORED_SKILL_STEP_KINDS = ['agent', 'user', 'check'] as const
/**
 * - `agent`: the agent does the work, then the step's checks run.
 * - `user`: only a person can do it (sign-up, login, API key, OAuth). The
 *   harness asks through `request_sponsored_signup`; checks confirm the
 *   result (usually `credential_provided`).
 * - `check`: no new work. The checks run; a failure is handed to the agent to
 *   fix, exactly like a failed `agent` step.
 */
export type SponsoredSkillStepKind = (typeof SPONSORED_SKILL_STEP_KINDS)[number]

export const SPONSORED_SKILL_OS = ['darwin', 'linux', 'win32'] as const
export type SponsoredSkillOs = (typeof SPONSORED_SKILL_OS)[number]

export const SPONSORED_SKILL_PACKAGE_MANAGERS = [
  'npm',
  'pnpm',
  'yarn',
  'bun',
] as const
export type SponsoredSkillPackageManager =
  (typeof SPONSORED_SKILL_PACKAGE_MANAGERS)[number]

export const SPONSORED_SKILL_RUNTIMES = [
  'node',
  'bun',
  'deno',
  'python',
] as const
export type SponsoredSkillRuntime = (typeof SPONSORED_SKILL_RUNTIMES)[number]

export const SPONSORED_SKILL_FRAMEWORKS = [
  'nextjs',
  'react-vite',
  'nodejs',
  'sveltekit',
  'remix',
  'astro',
  'expo',
] as const
export type SponsoredSkillFramework =
  (typeof SPONSORED_SKILL_FRAMEWORKS)[number]

export const SPONSORED_SKILL_SCRIPTS = [
  'typecheck',
  'lint',
  'build',
  'test',
] as const
export type SponsoredSkillScript = (typeof SPONSORED_SKILL_SCRIPTS)[number]

/**
 * Every check is deterministic code over the run's worktree, its diff, or the
 * run's own credential store. None asks a model. Paths are repo-relative
 * globs (`*`, `**`, `?`, `{a,b}`); patterns are JavaScript regex source.
 */
export type SponsoredSkillCheck = {
  /** Stable slug, unique within the skill. */
  id: string
  /** Shown to the agent when the check fails, and to the user in the report. */
  label: string
} & (
  | { kind: 'file_exists'; path: string }
  | {
      kind: 'file_contains'
      path: string
      pattern: string
      flags?: string
      /** The pattern must NOT appear in any matching file. */
      absent?: boolean
      /** Only files this run changed count (default true), so a base repo never earns credit. */
      changedOnly?: boolean
    }
  | { kind: 'package_declared'; name: string }
  | { kind: 'env_key_declared'; path: string; key: string }
  | { kind: 'credential_provided'; envKey: string }
  /** User steps only: the user answered Yes to this step's `request_sponsored_signup` prompt. */
  | { kind: 'user_confirmed' }
  | {
      kind: 'script_passes'
      script: SponsoredSkillScript
      /** A repo without this script skips the check (default) or fails it. */
      whenMissing?: 'skip' | 'fail'
      timeoutSeconds?: number
    }
  | {
      kind: 'command_succeeds'
      /** argv[0] is `node` or a declared tool's name; never a shell string. */
      argv: string[]
      timeoutSeconds?: number
    }
  | { kind: 'no_privileged_secrets'; paths: string[] }
  | { kind: 'changes_within'; paths: string[] }
)
export type SponsoredSkillCheckKind = SponsoredSkillCheck['kind']

export type SponsoredSkillStep = {
  /** Stable slug, unique within the skill. */
  id: string
  kind: SponsoredSkillStepKind
  /** One line. For a `user` step it reads as the user's action ("Ask the user to …"). */
  title: string
  /** What to do and how, for the agent. Empty for a `check` step. */
  instructions: string
  checks: SponsoredSkillCheck[]
  /** Agent attempts (first try + fixes) before the step is blocked. 1-5, default 3. */
  maxAttempts?: number
  /**
   * `user` steps only: the one credential the user hands the run. Rendered as
   * a `requires-credential:` line, so it follows that directive's rules
   * (`sponsored-run-credentials.ts`): the env name ends in _KEY, _TOKEN,
   * _SECRET or _PASSWORD, the value is masked, held for this run only and
   * redacted from the model. At most two per skill.
   */
  credential?: SponsoredRunCredential
}

export type SponsoredSkillPackage = {
  ecosystem: 'npm'
  name: string
  /** Exact version. Installed pinned, with lifecycle scripts off. */
  version: string
  dev?: boolean
}

/**
 * A CLI the skill calls by `name` (in `command_succeeds` and its instructions).
 * - `npm`: run through the package runner at a pinned version (`npx --yes <package>@<version>`).
 * - `path`: a vendor binary installed outside npm (a curl installer, Homebrew).
 *   It must already be on PATH: today's runs install nothing, so the skill
 *   checks for it and the run stops at that check when it is missing.
 */
export type SponsoredSkillTool =
  | { name: string; source: 'npm'; package: string; version: string }
  | {
      name: string
      source: 'path'
      /** How a person installs it, shown in the report when it is missing. */
      installHint: string
    }

export type SponsoredSkillRequirements = {
  os: SponsoredSkillOs[]
  runtimes: Array<{ name: SponsoredSkillRuntime; minVersion?: string }>
  packageManagers: SponsoredSkillPackageManager[]
  frameworks: SponsoredSkillFramework[]
}

export type SponsoredSkill = {
  format: typeof SPONSORED_SKILL_FORMAT
  /** Stable slug, `<advertiser>-<goal>`. */
  id: string
  /** Exact semver. Any change to a registered skill is a new version; see `sponsored-skills/versions.lock.ts`. */
  version: string
  /** What changed from the previous version, and why (the eval or run evidence). */
  changelog: string
  advertiser: string
  /** The advertiser's goal, as agreed with them. Not shown to the agent as instructions. */
  goal: string
  /** When this skill fits a user's task; read by the offer model, never by the run. */
  fits: string
  consent: {
    title: string
    /** One or two sentences: what the user ends up with. */
    summary: string
  }
  requirements: SponsoredSkillRequirements
  packages: SponsoredSkillPackage[]
  tools: SponsoredSkillTool[]
  /**
   * What the agent should know to adapt the steps to the repo it finds:
   * names, versions, syntax, traps, from the advertiser's docs. Facts, not
   * orders; the steps say what must be true, the agent decides how.
   */
  knowledge: string[]
  /** Run before the first step. A failure is fixed in the run when it can be (toolchain), else the run stops before any edit. */
  preflight: SponsoredSkillCheck[]
  steps: SponsoredSkillStep[]
  /** Funnel outcomes the verifier may credit (see `sponsored-run-outcomes.ts`). */
  outcomes: Array<'api_key_issued' | 'mcp_installed'>
}

export const MAX_SKILL_STEPS = 12
export const MAX_SKILL_CHECKS_PER_STEP = 12
export const MAX_SKILL_PREFLIGHT_CHECKS = 8
export const MAX_SKILL_TITLE_CHARS = 100
export const MAX_SKILL_INSTRUCTIONS_CHARS = 1_500
export const MAX_SKILL_SUMMARY_CHARS = 280
export const MAX_SKILL_GOAL_CHARS = 600
export const MAX_SKILL_KNOWLEDGE_ITEMS = 12
export const MAX_SKILL_KNOWLEDGE_CHARS = 400
/** The rendered procedure the agent reads; the old free-text field was 8,000. */
export const MAX_SKILL_RENDERED_CHARS = 12_000
export const DEFAULT_SKILL_MAX_ATTEMPTS = 3
export const MAX_SKILL_ATTEMPTS = 5
export const MAX_SKILL_TIMEOUT_SECONDS = 600

const SLUG = /^[a-z][a-z0-9-]{0,63}$/
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const ENV_KEY = /^[A-Z][A-Z0-9_]{0,63}$/
const REGEX_FLAGS = /^[ims]*$/
const ARGV_TOKEN = /^[^\s;&|`$<>(){}]+$/

export type SponsoredSkillParseError = { path: string; message: string }
export type SponsoredSkillParseResult =
  | { ok: true; skill: SponsoredSkill }
  | { ok: false; errors: SponsoredSkillParseError[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function oneOf<T extends string>(
  list: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === 'string' && (list as readonly string[]).includes(value)
  )
}

/**
 * Compiles a repo-relative glob: `**` crosses directories, `*` and `?` do not,
 * `{a,b}` is alternation. The step driver matches paths with this too, so
 * review and execution never disagree on what a glob covers.
 */
export function sponsoredSkillGlob(glob: string): RegExp {
  let source = ''
  let depth = 0
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') source += '[^/]'
    else if (char === '{') {
      depth++
      source += '(?:'
    } else if (char === '}' && depth > 0) {
      depth--
      source += ')'
    } else if (char === ',' && depth > 0) source += '|'
    else source += char.replace(/[.+^$()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

function validGlob(glob: unknown): glob is string {
  if (typeof glob !== 'string' || !glob || glob.length > 200) return false
  if (glob.startsWith('/') || glob.split('/').includes('..')) return false
  let depth = 0
  for (const char of glob) {
    if (char === '{') depth++
    if (char === '}') depth--
    if (depth < 0) return false
  }
  return depth === 0
}

function validRegex(source: unknown, flags: unknown): boolean {
  if (typeof source !== 'string' || !source || source.length > 300) return false
  if (
    flags !== undefined &&
    (typeof flags !== 'string' || !REGEX_FLAGS.test(flags))
  )
    return false
  try {
    new RegExp(source, flags as string | undefined)
    return true
  } catch {
    return false
  }
}

function text(
  errors: SponsoredSkillParseError[],
  path: string,
  value: unknown,
  max: number,
  { allowEmpty = false } = {},
): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    errors.push({ path, message: 'must be a non-empty string' })
    return ''
  }
  if (value.length > max) {
    errors.push({ path, message: `must be at most ${max} characters` })
  }
  return value
}

function timeout(
  errors: SponsoredSkillParseError[],
  path: string,
  value: unknown,
): void {
  if (value === undefined) return
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_SKILL_TIMEOUT_SECONDS
  ) {
    errors.push({
      path,
      message: `must be an integer from 1 to ${MAX_SKILL_TIMEOUT_SECONDS}`,
    })
  }
}

function parseCheck(
  errors: SponsoredSkillParseError[],
  path: string,
  value: unknown,
  ids: Set<string>,
  tools: ReadonlySet<string>,
  stepKind: SponsoredSkillStepKind | 'preflight',
): void {
  if (!isRecord(value)) {
    errors.push({ path, message: 'must be an object' })
    return
  }
  if (typeof value.id !== 'string' || !SLUG.test(value.id)) {
    errors.push({ path: `${path}.id`, message: 'must be a lowercase slug' })
  } else if (ids.has(value.id)) {
    errors.push({
      path: `${path}.id`,
      message: `duplicate check id "${value.id}"`,
    })
  } else ids.add(value.id)
  text(errors, `${path}.label`, value.label, MAX_SKILL_TITLE_CHARS)

  const at = (field: string) => `${path}.${field}`
  switch (value.kind) {
    case 'file_exists':
      if (!validGlob(value.path))
        errors.push({
          path: at('path'),
          message: 'must be a repo-relative glob',
        })
      return
    case 'file_contains':
      if (!validGlob(value.path))
        errors.push({
          path: at('path'),
          message: 'must be a repo-relative glob',
        })
      if (!validRegex(value.pattern, value.flags)) {
        errors.push({
          path: at('pattern'),
          message: 'must be a valid regex (flags: i, m, s)',
        })
      }
      if (value.absent !== undefined && typeof value.absent !== 'boolean') {
        errors.push({ path: at('absent'), message: 'must be a boolean' })
      }
      if (
        value.changedOnly !== undefined &&
        typeof value.changedOnly !== 'boolean'
      ) {
        errors.push({ path: at('changedOnly'), message: 'must be a boolean' })
      }
      return
    case 'package_declared':
      if (typeof value.name !== 'string' || !NPM_NAME.test(value.name)) {
        errors.push({
          path: at('name'),
          message: 'must be an npm package name',
        })
      }
      return
    case 'env_key_declared':
      if (!validGlob(value.path))
        errors.push({
          path: at('path'),
          message: 'must be a repo-relative glob',
        })
      if (typeof value.key !== 'string' || !ENV_KEY.test(value.key)) {
        errors.push({
          path: at('key'),
          message: 'must be an UPPER_SNAKE env key',
        })
      }
      return
    case 'user_confirmed':
      if (stepKind !== 'user') {
        errors.push({ path, message: 'user_confirmed belongs on a user step' })
      }
      return
    case 'credential_provided':
      if (stepKind !== 'user') {
        errors.push({
          path,
          message: 'credential_provided belongs on a user step',
        })
      }
      if (typeof value.envKey !== 'string' || !ENV_KEY.test(value.envKey)) {
        errors.push({
          path: at('envKey'),
          message: 'must be an UPPER_SNAKE env key',
        })
      }
      return
    case 'script_passes':
      if (!oneOf(SPONSORED_SKILL_SCRIPTS, value.script)) {
        errors.push({
          path: at('script'),
          message: `must be one of ${SPONSORED_SKILL_SCRIPTS.join(', ')}`,
        })
      }
      if (
        value.whenMissing !== undefined &&
        !oneOf(['skip', 'fail'] as const, value.whenMissing)
      ) {
        errors.push({
          path: at('whenMissing'),
          message: 'must be skip or fail',
        })
      }
      timeout(errors, at('timeoutSeconds'), value.timeoutSeconds)
      return
    case 'command_succeeds': {
      const argv = value.argv
      if (
        !Array.isArray(argv) ||
        argv.length === 0 ||
        argv.length > 16 ||
        !argv.every(
          (token) => typeof token === 'string' && ARGV_TOKEN.test(token),
        )
      ) {
        errors.push({
          path: at('argv'),
          message: 'must be 1-16 plain argv tokens (no shell syntax)',
        })
      } else if (argv[0] !== 'node' && !tools.has(argv[0] as string)) {
        errors.push({
          path: at('argv'),
          message: `argv[0] must be node or a declared tool, not "${argv[0]}"`,
        })
      }
      timeout(errors, at('timeoutSeconds'), value.timeoutSeconds)
      return
    }
    case 'no_privileged_secrets':
    case 'changes_within':
      if (
        !Array.isArray(value.paths) ||
        value.paths.length === 0 ||
        !value.paths.every(validGlob)
      ) {
        errors.push({
          path: at('paths'),
          message: 'must be a non-empty list of repo-relative globs',
        })
      }
      return
    default:
      errors.push({
        path: at('kind'),
        message: `unknown check kind ${JSON.stringify(value.kind)}`,
      })
  }
}

/**
 * Validates an untrusted value (a stored campaign row, a file in review) as a
 * skill. Every error is reported, not just the first, so a reviewer or the
 * authoring skill can fix them in one pass.
 */
export function parseSponsoredSkill(value: unknown): SponsoredSkillParseResult {
  const errors: SponsoredSkillParseError[] = []
  if (!isRecord(value))
    return { ok: false, errors: [{ path: '', message: 'must be an object' }] }

  if (value.format !== SPONSORED_SKILL_FORMAT) {
    errors.push({
      path: 'format',
      message: `must be ${SPONSORED_SKILL_FORMAT}`,
    })
  }
  if (typeof value.id !== 'string' || !SLUG.test(value.id)) {
    errors.push({ path: 'id', message: 'must be a lowercase slug' })
  }
  if (typeof value.version !== 'string' || !EXACT_SEMVER.test(value.version)) {
    errors.push({ path: 'version', message: 'must be an exact semver' })
  }
  if (typeof value.advertiser !== 'string' || !SLUG.test(value.advertiser)) {
    errors.push({ path: 'advertiser', message: 'must be a lowercase slug' })
  }
  text(errors, 'changelog', value.changelog, MAX_SKILL_GOAL_CHARS)
  text(errors, 'goal', value.goal, MAX_SKILL_GOAL_CHARS)
  text(errors, 'fits', value.fits, MAX_SKILL_GOAL_CHARS)
  if (!isRecord(value.consent)) {
    errors.push({ path: 'consent', message: 'must be an object' })
  } else {
    text(errors, 'consent.title', value.consent.title, MAX_SKILL_TITLE_CHARS)
    text(
      errors,
      'consent.summary',
      value.consent.summary,
      MAX_SKILL_SUMMARY_CHARS,
    )
  }

  const requirements = value.requirements
  if (!isRecord(requirements)) {
    errors.push({ path: 'requirements', message: 'must be an object' })
  } else {
    const list = <T extends string>(field: string, allowed: readonly T[]) => {
      const items = requirements[field]
      if (
        !Array.isArray(items) ||
        items.length === 0 ||
        !items.every((item) => oneOf(allowed, item))
      ) {
        errors.push({
          path: `requirements.${field}`,
          message: `must be a non-empty list of ${allowed.join(', ')}`,
        })
      }
    }
    list('os', SPONSORED_SKILL_OS)
    list('packageManagers', SPONSORED_SKILL_PACKAGE_MANAGERS)
    list('frameworks', SPONSORED_SKILL_FRAMEWORKS)
    const runtimes = requirements.runtimes
    if (
      !Array.isArray(runtimes) ||
      runtimes.length === 0 ||
      !runtimes.every(
        (runtime) =>
          isRecord(runtime) &&
          oneOf(SPONSORED_SKILL_RUNTIMES, runtime.name) &&
          (runtime.minVersion === undefined ||
            (typeof runtime.minVersion === 'string' &&
              /^\d+(?:\.\d+){0,2}$/.test(runtime.minVersion))),
      )
    ) {
      errors.push({
        path: 'requirements.runtimes',
        message: 'must be a non-empty list of { name, minVersion? }',
      })
    }
  }

  if (
    !Array.isArray(value.knowledge) ||
    value.knowledge.length > MAX_SKILL_KNOWLEDGE_ITEMS
  ) {
    errors.push({
      path: 'knowledge',
      message: `must be a list of at most ${MAX_SKILL_KNOWLEDGE_ITEMS} facts`,
    })
  } else {
    value.knowledge.forEach((fact, index) =>
      text(errors, `knowledge[${index}]`, fact, MAX_SKILL_KNOWLEDGE_CHARS),
    )
  }

  const packages = Array.isArray(value.packages) ? value.packages : null
  if (!packages) errors.push({ path: 'packages', message: 'must be a list' })
  const packageNames = new Set<string>()
  packages?.forEach((pkg, index) => {
    const path = `packages[${index}]`
    if (
      !isRecord(pkg) ||
      pkg.ecosystem !== 'npm' ||
      typeof pkg.name !== 'string' ||
      !NPM_NAME.test(pkg.name)
    ) {
      errors.push({
        path,
        message: 'must be { ecosystem: "npm", name, version }',
      })
      return
    }
    if (typeof pkg.version !== 'string' || !EXACT_SEMVER.test(pkg.version)) {
      errors.push({
        path: `${path}.version`,
        message: 'must be an exact version, not a range',
      })
    }
    if (pkg.dev !== undefined && typeof pkg.dev !== 'boolean') {
      errors.push({ path: `${path}.dev`, message: 'must be a boolean' })
    }
    if (packageNames.has(pkg.name))
      errors.push({ path, message: `duplicate package ${pkg.name}` })
    packageNames.add(pkg.name)
  })

  const tools = new Set<string>()
  if (!Array.isArray(value.tools))
    errors.push({ path: 'tools', message: 'must be a list' })
  else {
    value.tools.forEach((tool, index) => {
      const path = `tools[${index}]`
      if (
        !isRecord(tool) ||
        typeof tool.name !== 'string' ||
        !SLUG.test(tool.name)
      ) {
        errors.push({ path, message: 'must have a slug name' })
        return
      }
      if (tool.source === 'npm') {
        if (
          typeof tool.package !== 'string' ||
          !NPM_NAME.test(tool.package) ||
          typeof tool.version !== 'string' ||
          !EXACT_SEMVER.test(tool.version)
        ) {
          errors.push({
            path,
            message:
              'an npm tool needs { package, version } with an exact version',
          })
          return
        }
      } else if (tool.source === 'path') {
        if (typeof tool.installHint !== 'string' || !tool.installHint.trim()) {
          errors.push({ path, message: 'a path tool needs an installHint' })
          return
        }
      } else {
        errors.push({ path, message: 'source must be npm or path' })
        return
      }
      if (tool.name === 'node')
        errors.push({ path, message: 'a tool may not be named node' })
      tools.add(tool.name)
    })
  }

  const checkIds = new Set<string>()
  if (
    !Array.isArray(value.preflight) ||
    value.preflight.length > MAX_SKILL_PREFLIGHT_CHECKS
  ) {
    errors.push({
      path: 'preflight',
      message: `must be a list of at most ${MAX_SKILL_PREFLIGHT_CHECKS} checks`,
    })
  } else {
    value.preflight.forEach((check, index) =>
      parseCheck(
        errors,
        `preflight[${index}]`,
        check,
        checkIds,
        tools,
        'preflight',
      ),
    )
  }

  const steps = value.steps
  if (
    !Array.isArray(steps) ||
    steps.length === 0 ||
    steps.length > MAX_SKILL_STEPS
  ) {
    errors.push({
      path: 'steps',
      message: `must list 1-${MAX_SKILL_STEPS} steps`,
    })
  } else {
    const stepIds = new Set<string>()
    steps.forEach((step, index) => {
      const path = `steps[${index}]`
      if (!isRecord(step)) {
        errors.push({ path, message: 'must be an object' })
        return
      }
      if (typeof step.id !== 'string' || !SLUG.test(step.id)) {
        errors.push({ path: `${path}.id`, message: 'must be a lowercase slug' })
      } else if (stepIds.has(step.id)) {
        errors.push({
          path: `${path}.id`,
          message: `duplicate step id "${step.id}"`,
        })
      } else stepIds.add(step.id)
      const kind = oneOf(SPONSORED_SKILL_STEP_KINDS, step.kind)
        ? step.kind
        : null
      if (!kind) {
        errors.push({
          path: `${path}.kind`,
          message: 'must be agent, user or check',
        })
      }
      const title = text(
        errors,
        `${path}.title`,
        step.title,
        MAX_SKILL_TITLE_CHARS,
      )
      if (/\n/.test(title))
        errors.push({ path: `${path}.title`, message: 'must be one line' })
      text(
        errors,
        `${path}.instructions`,
        step.instructions,
        MAX_SKILL_INSTRUCTIONS_CHARS,
        {
          allowEmpty: kind === 'check',
        },
      )
      if (step.maxAttempts !== undefined) {
        if (
          typeof step.maxAttempts !== 'number' ||
          !Number.isInteger(step.maxAttempts) ||
          step.maxAttempts < 1 ||
          step.maxAttempts > MAX_SKILL_ATTEMPTS
        ) {
          errors.push({
            path: `${path}.maxAttempts`,
            message: `must be 1-${MAX_SKILL_ATTEMPTS}`,
          })
        }
      }
      if (kind === 'user') {
        const credential = step.credential
        if (
          credential !== undefined &&
          (!isRecord(credential) ||
            declaredRunCredentials(
              credentialDirective(credential as SponsoredRunCredential),
            ).length !== 1)
        ) {
          errors.push({
            path: `${path}.credential`,
            message:
              'a user step needs { env, label, getUrl } valid as a requires-credential line (env ends in _KEY/_TOKEN/_SECRET/_PASSWORD, label ≤ 60 chars, https getUrl)',
          })
        }
      } else if (step.credential !== undefined) {
        errors.push({
          path: `${path}.credential`,
          message: 'only a user step asks for a credential',
        })
      }
      if (
        !Array.isArray(step.checks) ||
        step.checks.length === 0 ||
        step.checks.length > MAX_SKILL_CHECKS_PER_STEP
      ) {
        // A step with no check is a step the harness cannot call done.
        errors.push({
          path: `${path}.checks`,
          message: `must list 1-${MAX_SKILL_CHECKS_PER_STEP} checks`,
        })
      } else if (kind) {
        step.checks.forEach((check, checkIndex) =>
          parseCheck(
            errors,
            `${path}.checks[${checkIndex}]`,
            check,
            checkIds,
            tools,
            kind,
          ),
        )
      }
    })
  }

  if (
    !Array.isArray(value.outcomes) ||
    !value.outcomes.every((outcome) =>
      oneOf(['api_key_issued', 'mcp_installed'] as const, outcome),
    )
  ) {
    errors.push({
      path: 'outcomes',
      message: 'must be a list of api_key_issued, mcp_installed',
    })
  }

  if (errors.length) return { ok: false, errors }
  const skill = value as unknown as SponsoredSkill

  const credentials = skill.steps.flatMap((step) =>
    step.credential ? [step.credential] : [],
  )
  if (
    declaredRunCredentials(renderSponsoredSkillProcedure(skill)).length !==
    credentials.length
  ) {
    errors.push({
      path: 'steps',
      message: 'user steps must ask for at most two distinct credentials',
    })
  }
  for (const check of allChecks(skill)) {
    if (
      check.kind === 'credential_provided' &&
      !credentials.some((credential) => credential.env === check.envKey)
    ) {
      errors.push({
        path: check.id,
        message: `checks credential ${check.envKey}, which no user step asks for`,
      })
    }
  }

  for (const check of allChecks(skill)) {
    if (check.kind === 'package_declared' && !packageNames.has(check.name)) {
      errors.push({
        path: check.id,
        message: `checks package ${check.name}, which the skill does not declare`,
      })
    }
  }
  const rendered = renderSponsoredSkillProcedure(skill)
  if (rendered.length > MAX_SKILL_RENDERED_CHARS) {
    errors.push({
      path: 'steps',
      message: `renders to ${rendered.length} characters; the limit is ${MAX_SKILL_RENDERED_CHARS}`,
    })
  }
  // The run card and the grader count steps, and read "needs the user", from
  // the rendered text (sponsored-procedure-steps.ts). The kinds here must
  // agree, or the grader would forgive an agent step as the user's.
  const parsed = parseSponsoredProcedureSteps(rendered)
  if (parsed.length !== skill.steps.length) {
    errors.push({
      path: 'steps',
      message: `renders to ${parsed.length} parsed steps, not ${skill.steps.length}`,
    })
  } else {
    skill.steps.forEach((step, index) => {
      if (parsed[index]!.needsUser !== (step.kind === 'user')) {
        errors.push({
          path: `steps[${index}]`,
          message:
            step.kind === 'user'
              ? 'a user step must read as the user\'s action, e.g. "Ask the user to …"'
              : 'its wording reads as a user action; reword it or make it a user step',
        })
      }
    })
  }
  return errors.length ? { ok: false, errors } : { ok: true, skill }
}

function allChecks(skill: SponsoredSkill): SponsoredSkillCheck[] {
  return [...skill.preflight, ...skill.steps.flatMap((step) => step.checks)]
}

/** Semver order (prerelease below its release), for picking the latest version. */
export function compareSponsoredSkillVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const [core = '', pre] = version.split('-', 2)
    return { parts: core.split('.').map(Number), pre }
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i++) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0)
    if (diff) return diff
  }
  if (left.pre === right.pre) return 0
  if (left.pre === undefined) return 1
  if (right.pre === undefined) return -1
  return left.pre < right.pre ? -1 : 1
}

export function sponsoredSkillKey(
  skill: Pick<SponsoredSkill, 'id' | 'version'>,
): string {
  return `${skill.id}@${skill.version}`
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    )
  }
  return value
}

/** Canonical JSON: keys sorted at every depth, `undefined` dropped. Array order is meaning. */
export function canonicalizeSponsoredSkill(skill: SponsoredSkill): string {
  return JSON.stringify(canonical(skill))
}

/**
 * THE hash Accept locks. It covers every field, so a changed step, check,
 * package or consent line is a different skill, and a stored proposal whose
 * hash no longer matches the version it names is refused rather than run.
 */
export function sponsoredSkillSha256(
  skill: SponsoredSkill,
): `sha256:${string}` {
  return `sha256:${sha256Hex(canonicalizeSponsoredSkill(skill))}`
}

/**
 * The first line of a rendered skill: `skill: <id>@<version> sha256:<hex>`.
 * The existing pipeline hashes and locks the procedure TEXT at Accept
 * (`procedure_sha256`, `compute_procedure_sha256`); because this line carries
 * the skill's own hash, locking the text locks every check and package too.
 */
export const SPONSORED_SKILL_DIRECTIVE = 'skill:'
const SKILL_DIRECTIVE_LINE =
  /^skill:\s+([a-z][a-z0-9-]{0,63})@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s+(sha256:[0-9a-f]{64})\s*$/

/** The skill a procedure text names, or null for a legacy free-text procedure. */
export function sponsoredSkillDirective(
  procedure: string | null | undefined,
): { id: string; version: string; sha256: `sha256:${string}` } | null {
  const first = procedure?.replace(/\r\n?/g, '\n').trimStart().split('\n', 1)[0]
  const match = first ? SKILL_DIRECTIVE_LINE.exec(first) : null
  if (!match) return null
  return {
    id: match[1]!,
    version: match[2]!,
    sha256: match[3] as `sha256:${string}`,
  }
}

/**
 * Whether `skill` is the one an accepted procedure text locked: same id,
 * version and hash. The step driver refuses to run a skill that fails this.
 */
export function sponsoredSkillMatchesProcedure(
  skill: SponsoredSkill,
  procedure: string,
): boolean {
  const directive = sponsoredSkillDirective(procedure)
  return (
    directive !== null &&
    directive.id === skill.id &&
    directive.version === skill.version &&
    directive.sha256 === sponsoredSkillSha256(skill) &&
    procedure.trim() === renderSponsoredSkillProcedure(skill)
  )
}

function credentialDirective(credential: SponsoredRunCredential): string {
  return [
    `requires-credential: env=${credential.env}`,
    `label="${credential.label}"`,
    ...(credential.getUrl ? [`get_url=${credential.getUrl}`] : []),
  ].join(' ')
}

function indent(body: string, spaces: number): string {
  const pad = ' '.repeat(spaces)
  return body
    .split('\n')
    .map((line) => (line.trim() ? pad + line : ''))
    .join('\n')
}

/**
 * The procedure text the agent reads in the prompt's procedure slot. Its
 * top-level numbered items are exactly the skill's steps, so the run card's
 * tracker and the grader (`parseSponsoredProcedureSteps`) count the same
 * steps the step driver runs.
 */
export function renderSponsoredSkillProcedure(skill: SponsoredSkill): string {
  const lines: string[] = [
    `${SPONSORED_SKILL_DIRECTIVE} ${sponsoredSkillKey(skill)} ${sponsoredSkillSha256(skill)}`,
    // The directives today's Desktop already reads, so a skill runs on the
    // current harness before the step driver ships.
    ...skill.steps.flatMap((step) =>
      step.credential ? [credentialDirective(step.credential)] : [],
    ),
    ...(skill.outcomes.length
      ? [`outcomes: ${skill.outcomes.join(', ')}`]
      : []),
    '',
    `Goal: ${skill.consent.summary}`,
    '',
    'Fit every step to this repository: its framework, layout and conventions decide where',
    'files go and how code is written. Each step is done when its checks pass, however you get there.',
    '',
  ]
  if (skill.knowledge.length) {
    lines.push('What to know:')
    for (const fact of skill.knowledge) lines.push(`- ${fact}`)
    lines.push('')
  }
  const npmTools = skill.tools.filter((tool) => tool.source === 'npm')
  if (skill.packages.length || npmTools.length) {
    lines.push('Pinned installs (install exactly these, nothing else):')
    for (const pkg of skill.packages) {
      lines.push(`- ${pkg.name}@${pkg.version}${pkg.dev ? ' (dev)' : ''}`)
    }
    for (const tool of npmTools) {
      lines.push(
        `- \`${tool.name}\` = npx --yes ${tool.package}@${tool.version}`,
      )
    }
    lines.push('')
  }
  const pathTools = skill.tools.filter((tool) => tool.source === 'path')
  if (pathTools.length) {
    lines.push(
      'Already-installed CLIs (do not install them; if one is missing, stop and report it):',
    )
    for (const tool of pathTools) {
      if (tool.source === 'path')
        lines.push(`- \`${tool.name}\` (${tool.installHint})`)
    }
    lines.push('')
  }
  skill.steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${step.title}`)
    if (step.instructions.trim())
      lines.push(indent(step.instructions.trim(), 3))
    lines.push(
      indent(
        `Done when: ${step.checks.map((check) => check.label).join('; ')}.`,
        3,
      ),
    )
    lines.push('')
  })
  return lines.join('\n').trim()
}

export type SponsoredSkillConsentView = {
  key: string
  sha256: `sha256:${string}`
  title: string
  summary: string
  steps: Array<{ number: number; title: string; byUser: boolean }>
  installs: string[]
  /** Vendor CLIs that must already be installed. */
  requiredClis: string[]
}

/**
 * What the consent dialog shows. The user reads the steps by title and the
 * exact installs; the full instructions are one click away and covered by the
 * same hash.
 */
export function sponsoredSkillConsentView(
  skill: SponsoredSkill,
): SponsoredSkillConsentView {
  return {
    key: sponsoredSkillKey(skill),
    sha256: sponsoredSkillSha256(skill),
    title: skill.consent.title,
    summary: skill.consent.summary,
    steps: skill.steps.map((step, index) => ({
      number: index + 1,
      title: step.title,
      byUser: step.kind === 'user',
    })),
    installs: [
      ...skill.packages.map((pkg) => `${pkg.name}@${pkg.version}`),
      ...skill.tools.flatMap((tool) =>
        tool.source === 'npm' ? [`${tool.package}@${tool.version}`] : [],
      ),
    ],
    requiredClis: skill.tools.flatMap((tool) =>
      tool.source === 'path' ? [tool.name] : [],
    ),
  }
}
