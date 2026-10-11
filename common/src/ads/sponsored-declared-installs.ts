/**
 * Installs a sponsored run MAY make: the exact packages its skill declares.
 *
 * COD-336 decision item 5 refuses every install, because a `postinstall`
 * script runs outside the tool loop and outside the diff the user reviews.
 * This narrows that rule (decided 2026-10-11): a run whose skill declares
 * nothing is still refused every install, exactly as before.
 *
 * Otherwise an install command is allowed only if it names nothing but the
 * skill's declared packages, at their declared EXACT versions, as one plain
 * command. The harness never runs the model's spelling: it runs the canonical
 * command built here, which always carries `--ignore-scripts` and pins the
 * exact version into `package.json`. So:
 *
 *  - no lifecycle script runs (the package's own `postinstall` or its
 *    dependencies'), which is the hole the original refusal named;
 *  - the version is the one reviewed when the skill was written, and the
 *    `package.json` and lockfile changes land in the diff the user reviews;
 *  - nothing undeclared rides along (`npm install declared evil`), and a bare
 *    `npm install` of the whole tree is still refused.
 *
 * npm-ecosystem only (npm, pnpm, bun). Yarn is refused: classic takes
 * `--ignore-scripts` and Berry does not, and nothing here can tell them apart.
 * pip, cargo and the rest stay refused.
 */

import {
  SPONSORED_LOCAL_INSTALL_REFUSAL,
  commandInstallsDependencies,
} from './sponsored-local-execution'
import { sponsoredSkillForProcedureSha256 } from './sponsored-skills/registry'

/** One package a skill may install. `version` is an exact semver. */
export type SponsoredDeclaredPackage = {
  ecosystem: 'npm'
  name: string
  version: string
  /** Saved as a dev dependency even when the command does not say so. */
  dev?: boolean
}

/**
 * The packages a run may install, from the procedure it was granted: the
 * skill version whose rendered text has that hash (`procedure_sha256`, which
 * the compute grant already pins). Empty for a legacy free-text procedure, so
 * every install is refused as before.
 */
export function sponsoredDeclaredPackagesForProcedureSha256(
  procedureSha256: string | null | undefined,
): SponsoredDeclaredPackage[] {
  return sponsoredSkillForProcedureSha256(procedureSha256)?.packages ?? []
}

/** A skill declaring more than this is a skill that should be split. */
export const SPONSORED_DECLARED_PACKAGES_MAX = 20

/** npm's package-name rules, lowercase only (new packages cannot be uppercase). */
const NPM_PACKAGE_NAME =
  /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/** An exact semver: no range, no tag, no `v` prefix. */
const EXACT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Validates a skill's declared package list. Throws on anything malformed
 * rather than dropping it, so a bad skill fails where it is written and never
 * reaches a run as a silently shorter list.
 */
export function parseSponsoredDeclaredPackages(
  raw: unknown,
): SponsoredDeclaredPackage[] {
  if (!Array.isArray(raw)) {
    throw new Error('Declared packages must be a list.')
  }
  if (raw.length > SPONSORED_DECLARED_PACKAGES_MAX) {
    throw new Error(
      `A skill may declare at most ${SPONSORED_DECLARED_PACKAGES_MAX} packages.`,
    )
  }
  const seen = new Set<string>()
  return raw.map((entry, index) => {
    const value = (entry ?? {}) as Record<string, unknown>
    const { ecosystem, name, version, dev } = value
    if (ecosystem !== 'npm') {
      throw new Error(`Declared package ${index}: ecosystem must be "npm".`)
    }
    if (typeof name !== 'string' || !NPM_PACKAGE_NAME.test(name)) {
      throw new Error(`Declared package ${index}: invalid npm name.`)
    }
    if (typeof version !== 'string' || !EXACT_SEMVER.test(version)) {
      throw new Error(
        `Declared package ${name}: version must be an exact semver such as 1.2.3, not a range or tag.`,
      )
    }
    if (seen.has(name)) {
      throw new Error(`Declared package ${name} is listed twice.`)
    }
    if (dev !== undefined && typeof dev !== 'boolean') {
      throw new Error(`Declared package ${name}: dev must be true or false.`)
    }
    seen.add(name)
    return { ecosystem, name, version, ...(dev ? { dev } : {}) }
  })
}

export type SponsoredInstallDecision =
  /** Not an install at all: run the command as given. */
  | { kind: 'not-install' }
  /** Run `command` (the canonical spelling) instead of the model's. */
  | { kind: 'allow'; command: string }
  | { kind: 'refuse'; message: string }

type PackageManager = 'npm' | 'pnpm' | 'bun'

const INSTALL_SUBCOMMANDS: Readonly<
  Record<PackageManager, ReadonlySet<string>>
> = {
  npm: new Set(['install', 'i', 'add']),
  pnpm: new Set(['add', 'install', 'i']),
  bun: new Set(['add', 'install', 'i']),
}

const DEV_FLAGS = new Set(['-D', '--save-dev', '--dev'])
/** Flags the canonical command always carries, so they are accepted and dropped. */
const IMPLIED_FLAGS = new Set([
  '-E',
  '--save-exact',
  '--exact',
  '--ignore-scripts',
])

/** Anything a shell would treat as more than one plain command. */
const SHELL_METACHARACTERS = /[;&|<>`$(){}\n\r'"\\*?]/

function canonicalInstall(
  manager: PackageManager,
  specs: string[],
  dev: boolean,
): string {
  const parts: string[] =
    manager === 'npm'
      ? ['npm', 'install', '--ignore-scripts', '--save-exact']
      : manager === 'pnpm'
        ? ['pnpm', 'add', '--ignore-scripts', '--save-exact']
        : ['bun', 'add', '--ignore-scripts', '--exact']
  if (dev) parts.push(manager === 'bun' ? '--dev' : '--save-dev')
  return [...parts, ...specs].join(' ')
}

function declaredRefusal(
  declared: readonly SponsoredDeclaredPackage[],
): string {
  const specs = declared.map((pkg) => `${pkg.name}@${pkg.version}`).join(' ')
  return `Refusing this install: a sponsored run may install only the packages its skill declares, at the declared versions, as one plain command (no \`cd\`, chaining or quoting; use the cwd argument). Allowed: \`npm install ${specs}\` (or \`pnpm add\` / \`bun add\`, optionally with --save-dev). Scripts are always skipped. Anything else, work with what the repository already has.`
}

/**
 * What the harness does with `command` in a sponsored run.
 *
 * Pure, and the only install decision a surface makes:
 * Desktop and the CLI both call it in place of `commandInstallsDependencies`.
 */
export function evaluateSponsoredInstallCommand(
  command: string,
  declared: readonly SponsoredDeclaredPackage[] | undefined,
): SponsoredInstallDecision {
  if (!commandInstallsDependencies(command)) return { kind: 'not-install' }
  if (!declared || declared.length === 0) {
    return { kind: 'refuse', message: SPONSORED_LOCAL_INSTALL_REFUSAL }
  }
  const refuse = { kind: 'refuse', message: declaredRefusal(declared) } as const
  if (SHELL_METACHARACTERS.test(command)) return refuse

  const tokens = command.trim().split(/\s+/)
  const manager = tokens[0] as PackageManager
  if (manager !== 'npm' && manager !== 'pnpm' && manager !== 'bun') {
    return refuse
  }
  if (!INSTALL_SUBCOMMANDS[manager].has(tokens[1] ?? '')) return refuse

  const byName = new Map(declared.map((pkg) => [pkg.name, pkg]))
  const specs: string[] = []
  const matched: SponsoredDeclaredPackage[] = []
  let dev = false
  for (const token of tokens.slice(2)) {
    if (DEV_FLAGS.has(token)) {
      dev = true
      continue
    }
    if (IMPLIED_FLAGS.has(token)) continue
    if (token.startsWith('-')) return refuse
    // `@scope/name@1.2.3`: the version separator is the LAST `@` past index 0.
    const at = token.lastIndexOf('@')
    const name = at > 0 ? token.slice(0, at) : token
    const version = at > 0 ? token.slice(at + 1) : undefined
    const pkg = byName.get(name)
    if (!pkg) return refuse
    if (version !== undefined && version !== pkg.version) return refuse
    specs.push(`${pkg.name}@${pkg.version}`)
    matched.push(pkg)
  }
  // A bare `npm install` installs the repository's whole tree, none of it
  // declared.
  if (specs.length === 0) return refuse
  // Declared dev packages land in devDependencies without the flag.
  if (matched.every((pkg) => pkg.dev)) dev = true
  return { kind: 'allow', command: canonicalInstall(manager, specs, dev) }
}
