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
 * npm ecosystem: npm, pnpm, bun. Yarn is refused: classic takes
 * `--ignore-scripts` and Berry does not, and nothing here can tell them apart.
 *
 * PyPI ecosystem (decided 2026-10-13): pip (`pip`, `pip3`, `python -m pip`,
 * `py -m pip`, or a project venv's own launcher) and uv (`uv pip install`,
 * `uv add`), WHEELS ONLY. Python has no `--ignore-scripts`: what runs package
 * code at install time is building a source distribution (`setup.py`, a PEP
 * 517 backend), so the canonical command always carries
 * `--only-binary=:all:` (pip) or `--no-build` (uv), and a command that does
 * not ask for wheels only is refused with the exact form to use. A package
 * with no wheel for the machine fails to install rather than build.
 *
 * Unlike npm, a pip install changes no file in the project, so it is not in
 * the diff the user reviews and the run's undo does not remove it; `uv add`
 * does write `pyproject.toml` and `uv.lock`. On macOS and Linux the sandbox
 * keeps writes inside the workspace (a project `.venv` works; the system
 * Python does not); Windows has no OS sandbox.
 *
 * cargo, gem, poetry and the rest stay refused.
 */

import {
  SPONSORED_LOCAL_INSTALL_REFUSAL,
  SPONSORED_LOCAL_INSTALL_TOOL_REFUSAL,
  commandInstallsDependencies,
} from './sponsored-local-execution'
import {
  PYPI_EXACT_VERSION,
  PYPI_PACKAGE_NAME,
  normalizePypiName,
} from './sponsored-skill'
import { sponsoredSkillForProcedureSha256 } from './sponsored-skills/registry'

/**
 * One package a skill may install. `version` is an exact semver (npm) or an
 * exact PEP 440 release (pypi).
 */
export type SponsoredDeclaredPackage = {
  ecosystem: 'npm' | 'pypi'
  name: string
  version: string
  /** Saved as a dev dependency even when the command does not say so (npm; pypi under `uv add`). */
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
export const NPM_PACKAGE_NAME =
  /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/** An exact semver: no range, no tag, no `v` prefix. */
export const EXACT_SEMVER =
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
  return raw.map((entry, index): SponsoredDeclaredPackage => {
    const value = (entry ?? {}) as Record<string, unknown>
    const { ecosystem, name, version, dev } = value
    if (ecosystem === 'pypi') {
      if (typeof name !== 'string' || !PYPI_PACKAGE_NAME.test(name)) {
        throw new Error(`Declared package ${index}: invalid PyPI name.`)
      }
      if (typeof version !== 'string' || !PYPI_EXACT_VERSION.test(version)) {
        throw new Error(
          `Declared package ${name}: version must be an exact PEP 440 release such as 2.32.3, not a range, extra or URL.`,
        )
      }
      const key = `pypi:${normalizePypiName(name)}`
      if (seen.has(key)) {
        throw new Error(`Declared package ${name} is listed twice.`)
      }
      if (dev !== undefined && typeof dev !== 'boolean') {
        throw new Error(`Declared package ${name}: dev must be true or false.`)
      }
      seen.add(key)
      return { ecosystem, name, version, ...(dev ? { dev } : {}) }
    }
    if (ecosystem !== 'npm') {
      throw new Error(
        `Declared package ${index}: ecosystem must be "npm" or "pypi".`,
      )
    }
    if (typeof name !== 'string' || !NPM_PACKAGE_NAME.test(name)) {
      throw new Error(`Declared package ${index}: invalid npm name.`)
    }
    if (typeof version !== 'string' || !EXACT_SEMVER.test(version)) {
      throw new Error(
        `Declared package ${name}: version must be an exact semver such as 1.2.3, not a range or tag.`,
      )
    }
    if (seen.has(`npm:${name}`)) {
      throw new Error(`Declared package ${name} is listed twice.`)
    }
    if (dev !== undefined && typeof dev !== 'boolean') {
      throw new Error(`Declared package ${name}: dev must be true or false.`)
    }
    seen.add(`npm:${name}`)
    return { ecosystem, name, version, ...(dev ? { dev } : {}) }
  })
}

export type SponsoredInstallDecision =
  /** Not an install at all: run the command as given. */
  | { kind: 'not-install' }
  /** Run `command` (the canonical spelling) instead of the model's. */
  | { kind: 'allow'; command: string }
  | { kind: 'refuse'; message: string }

export type SponsoredNpmPackageManager = 'npm' | 'pnpm' | 'bun'
type PackageManager = SponsoredNpmPackageManager

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

/**
 * Each manager's own "run in this folder" flag. A subfolder install is
 * rewritten to it rather than kept as `cd <dir> && …`, because the Windows
 * floor runs PowerShell 5.1, which has no `&&`.
 */
export const DIR_FLAGS: Readonly<Record<PackageManager, readonly string[]>> = {
  npm: ['--prefix'],
  pnpm: ['--dir', '-C'],
  bun: ['--cwd'],
}

/**
 * A leading `cd <dir> &&` (or `;`) the model adds to install into a
 * subfolder: every agent wrote it first, and every one was refused until it
 * retried without it (Respan bench, 2026-10-12).
 */
const LEADING_CD = /^\s*cd\s+(\S+)\s*(?:&&|;)\s*(.*)$/s

/**
 * `dir` as a relative path inside the project, `/`-separated, or null when it
 * could leave it (absolute, home, a drive, `..`) or is not a plain name.
 * `''` is the project root.
 */
export function sponsoredInstallSubdir(dir: string): string | null {
  if (/^([\\/~]|[A-Za-z]:)/.test(dir)) return null
  const segments = dir.split(/[\\/]+/).filter((s) => s !== '' && s !== '.')
  if (segments.some((s) => s === '..' || !/^[A-Za-z0-9._@+-]+$/.test(s))) {
    return null
  }
  return segments.join('/')
}

/**
 * The one spelling of an npm-ecosystem install the harness runs: scripts
 * skipped, exact version saved. Also what `install_package` runs
 * (`sponsored-install-tool.ts`); `specs` must already be validated.
 */
export function canonicalInstall(
  manager: PackageManager,
  specs: string[],
  dev: boolean,
  dir: string,
): string {
  const parts: string[] =
    manager === 'npm'
      ? ['npm', 'install', '--ignore-scripts', '--save-exact']
      : manager === 'pnpm'
        ? ['pnpm', 'add', '--ignore-scripts', '--save-exact']
        : ['bun', 'add', '--ignore-scripts', '--exact']
  if (dev) parts.push(manager === 'bun' ? '--dev' : '--save-dev')
  if (dir) parts.push(DIR_FLAGS[manager][0]!, dir)
  return [...parts, ...specs].join(' ')
}

/**
 * The refusal for a run whose skill this build could not load: the pinned
 * packages exist, this build just does not know them. Distinct from
 * {@link SPONSORED_LOCAL_INSTALL_REFUSAL} so a trace says which it was.
 */
export const SPONSORED_SKILL_UNRESOLVED_INSTALL_REFUSAL =
  "Refusing this install: this Freebuff build could not load the skill's list of pinned packages, so it cannot install them. Declare the pinned version in the package manifest, write the code against it, and tell the user to update Freebuff and run the procedure's pinned install command themselves."

const REFUSAL_PREFIX =
  'Refusing this install: a sponsored run may install only the packages its skill declares, at the declared versions, as one plain command (a leading `cd <subfolder> &&` is fine; no other chaining or quoting).'

function pypiSpec(pkg: SponsoredDeclaredPackage): string {
  return `${pkg.name}==${pkg.version}`
}

function declaredRefusal(
  declared: readonly SponsoredDeclaredPackage[],
): string {
  const npm = declared.filter((pkg) => pkg.ecosystem === 'npm')
  const pypi = declared.filter((pkg) => pkg.ecosystem === 'pypi')
  let message = REFUSAL_PREFIX
  if (npm.length) {
    const specs = npm.map((pkg) => `${pkg.name}@${pkg.version}`).join(' ')
    message += ` Allowed: \`npm install ${specs}\` (or \`pnpm add\` / \`bun add\`, optionally with --save-dev). Scripts are always skipped.`
  }
  if (pypi.length) {
    const specs = pypi.map(pypiSpec).join(' ')
    message += ` Allowed for Python, wheels only: \`pip install --only-binary=:all: ${specs}\` (or \`python -m pip install\` / \`py -m pip install\` with the same flag, \`uv pip install --no-build ${specs}\`, or \`uv add --no-build ${specs}\`).`
  }
  return `${message} Anything else, work with what the repository already has.`
}

/** The refusal for a pip/uv install that did not ask for wheels only. */
export function sponsoredWheelOnlyRefusal(canonical: string): string {
  return `Refusing this install: a sponsored run installs Python packages from wheels only, because building a source distribution runs the package's own setup code (the same reason npm install scripts are skipped). Run exactly: \`${canonical}\`. If the package has no wheel for this machine it cannot be installed here; report it as something the user must install.`
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
  /**
   * The run's procedure names a skill this build could not load, so its
   * declared list is unknown rather than empty: refused with that cause.
   */
  options: {
    skillUnresolved?: boolean
    /**
     * The run has the `install_package` tool (COD-965): every refusal tells
     * the agent to use it instead of the shell. Absent, the wording is the
     * one every released build shows.
     */
    installTool?: boolean
  } = {},
): SponsoredInstallDecision {
  if (!commandInstallsDependencies(command)) return { kind: 'not-install' }
  if (!declared || declared.length === 0) {
    return {
      kind: 'refuse',
      message: options.installTool
        ? SPONSORED_LOCAL_INSTALL_TOOL_REFUSAL
        : options.skillUnresolved
          ? SPONSORED_SKILL_UNRESOLVED_INSTALL_REFUSAL
          : SPONSORED_LOCAL_INSTALL_REFUSAL,
    }
  }
  const refuse = {
    kind: 'refuse',
    message: options.installTool
      ? SPONSORED_LOCAL_INSTALL_TOOL_REFUSAL
      : declaredRefusal(declared),
  } as const

  let dir: string | null = ''
  const cd = LEADING_CD.exec(command)
  if (cd) {
    dir = sponsoredInstallSubdir(cd[1]!)
    if (dir === null) return refuse
    command = cd[2]!
  }
  if (SHELL_METACHARACTERS.test(command)) return refuse

  const tokens = command.trim().split(/\s+/)
  const python = evaluatePythonInstall(
    tokens,
    dir,
    declared.filter((pkg) => pkg.ecosystem === 'pypi'),
  )
  if (python !== 'not-python') {
    // The wheel-only refusal names the exact command to re-run; with the
    // tool, the tool is the way.
    if (python?.kind === 'refuse' && options.installTool) return refuse
    return python ?? refuse
  }

  const manager = tokens[0] as PackageManager
  if (manager !== 'npm' && manager !== 'pnpm' && manager !== 'bun') {
    return refuse
  }
  if (!INSTALL_SUBCOMMANDS[manager].has(tokens[1] ?? '')) return refuse

  const byName = new Map(
    declared
      .filter((pkg) => pkg.ecosystem === 'npm')
      .map((pkg) => [pkg.name, pkg]),
  )
  const specs: string[] = []
  const matched: SponsoredDeclaredPackage[] = []
  let dev = false
  const rest = tokens.slice(2)
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!
    if (DIR_FLAGS[manager].includes(token)) {
      // One folder: a `cd` and a flag together, or two flags, is refused.
      const flagDir = sponsoredInstallSubdir(rest[i + 1] ?? '/')
      if (dir || flagDir === null) return refuse
      dir = flagDir
      i++
      continue
    }
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
  return { kind: 'allow', command: canonicalInstall(manager, specs, dev, dir) }
}

// ------------------------------------------------------------------ PyPI

/** `pip`, `pip3`, with `.exe` on Windows. */
const PIP_EXECUTABLE = /^pip3?(?:\.exe)?$/i
/** `python`, `python3`, with `.exe` on Windows; `py` is the Windows launcher. */
const PYTHON_EXECUTABLE = /^python3?(?:\.exe)?$/i
const PY_LAUNCHER = /^py(?:\.exe)?$/i

/** uv's own "run in this folder" flags; the canonical command uses the first. */
const UV_DIR_FLAGS = ['--directory', '--project']

/**
 * A pip or python launcher as written: bare (`pip`, `python3`, `py`) or a
 * project venv's own (`.venv/bin/pip`, `venv/Scripts/python.exe`), whose
 * folder must stay inside the project. `cd` is the leading-cd folder, which a
 * relative launcher is resolved against. Null when it is not a launcher this
 * accepts.
 */
function pythonLauncher(
  token: string,
  executable: RegExp,
  cd: string,
): string | null {
  const slash = token.lastIndexOf('/')
  const base = token.slice(slash + 1)
  if (!executable.test(base)) return null
  if (slash < 0) return base
  const folder = sponsoredInstallSubdir(token.slice(0, slash))
  if (!folder) return null
  // No `&&` on PowerShell 5.1: a venv under a `cd` folder is named from the root.
  return [cd, folder, base].filter(Boolean).join('/')
}

type PythonInstaller = 'pip' | 'uv-pip' | 'uv-add'

/**
 * A pip or uv install, decided: an allow or a wheel-only refusal; null for
 * any other refusal (the caller's declared-packages message); `not-python`
 * when the command is not pip or uv at all.
 *
 * Accepted, for declared pypi packages only (`name` or `name==<declared>`,
 * name compared in PEP 503 normalized form):
 *  - `pip|pip3|python -m pip|python3 -m pip|py -m pip install` with
 *    `--only-binary :all:` / `--only-binary=:all:`, and a venv launcher such
 *    as `.venv/bin/pip`;
 *  - `uv pip install --no-build`, `uv add --no-build [--dev]`, optionally
 *    `--directory|--project <subfolder>`.
 * Either wheel-only spelling is accepted for any of them: the harness runs the
 * canonical command, never the model's.
 */
function evaluatePythonInstall(
  tokens: string[],
  dir: string,
  declared: readonly SponsoredDeclaredPackage[],
): SponsoredInstallDecision | null | 'not-python' {
  let installer: PythonInstaller
  let launcher: string
  let rest: string[]
  const first = tokens[0] ?? ''
  if (first === 'uv') {
    // uv takes its options anywhere; its subcommand is the first positional.
    const positional = tokens
      .slice(1)
      .filter(
        (token, i, all) =>
          !token.startsWith('-') &&
          !UV_DIR_FLAGS.includes(all[i - 1] ?? '') &&
          !(all[i - 1] === '--only-binary' && token === ':all:'),
      )
    if (positional[0] === 'add') installer = 'uv-add'
    else if (positional[0] === 'pip' && positional[1] === 'install')
      installer = 'uv-pip'
    else return null
    launcher = 'uv'
    rest = tokens.slice(1)
    const sub = installer === 'uv-add' ? ['add'] : ['pip', 'install']
    rest = removeSubcommand(rest, sub)
  } else {
    const pip = pythonLauncher(first, PIP_EXECUTABLE, dir)
    const python =
      pythonLauncher(first, PYTHON_EXECUTABLE, dir) ??
      (PY_LAUNCHER.test(first) ? first : null)
    if (pip !== null) {
      if (tokens[1] !== 'install') return null
      launcher = pip
      rest = tokens.slice(2)
    } else if (python !== null) {
      if (tokens[1] !== '-m' || tokens[2] !== 'pip') return 'not-python'
      if (tokens[3] !== 'install') return null
      launcher = `${python} -m pip`
      rest = tokens.slice(4)
    } else {
      return 'not-python'
    }
    installer = 'pip'
  }

  const byName = new Map(
    declared.map((pkg) => [normalizePypiName(pkg.name), pkg]),
  )
  const matched: SponsoredDeclaredPackage[] = []
  let wheelOnly = false
  let dev = false
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!
    if (installer !== 'pip' && UV_DIR_FLAGS.includes(token)) {
      const flagDir = sponsoredInstallSubdir(rest[i + 1] ?? '/')
      if (dir || flagDir === null) return null
      dir = flagDir
      i++
      continue
    }
    if (token === '--only-binary' && rest[i + 1] === ':all:') {
      wheelOnly = true
      i++
      continue
    }
    if (token === '--only-binary=:all:' || token === '--no-build') {
      wheelOnly = true
      continue
    }
    if (installer === 'uv-add' && token === '--dev') {
      dev = true
      continue
    }
    if (token.startsWith('-')) return null
    const eq = token.indexOf('==')
    const name = eq > 0 ? token.slice(0, eq) : token
    const version = eq > 0 ? token.slice(eq + 2) : undefined
    if (!PYPI_PACKAGE_NAME.test(name)) return null
    const pkg = byName.get(normalizePypiName(name))
    if (!pkg) return null
    if (version !== undefined && version !== pkg.version) return null
    if (matched.includes(pkg)) return null
    matched.push(pkg)
  }
  // A bare `pip install` / `uv add` names nothing declared.
  if (matched.length === 0) return null
  if (installer === 'uv-add' && matched.every((pkg) => pkg.dev)) dev = true
  const specs = matched.map(pypiSpec).join(' ')
  const uv = dir ? `uv --directory ${dir}` : 'uv'
  const canonical =
    installer === 'pip'
      ? `${launcher} install --only-binary=:all: ${specs}`
      : installer === 'uv-pip'
        ? `${uv} pip install --no-build ${specs}`
        : `${uv} add --no-build${dev ? ' --dev' : ''} ${specs}`
  if (!wheelOnly) {
    return { kind: 'refuse', message: sponsoredWheelOnlyRefusal(canonical) }
  }
  return { kind: 'allow', command: canonical }
}

/** `rest` without the subcommand words, in order (uv options may sit between them). */
function removeSubcommand(rest: string[], words: string[]): string[] {
  const out: string[] = []
  let next = 0
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!
    const isValue =
      UV_DIR_FLAGS.includes(rest[i - 1] ?? '') ||
      (rest[i - 1] === '--only-binary' && token === ':all:')
    if (next < words.length && !token.startsWith('-') && !isValue) {
      if (token !== words[next]) return [token, ...rest.slice(i + 1)]
      next++
      continue
    }
    out.push(token)
  }
  return out
}
