/**
 * `install_package`: a sponsored run's one way to add a package (COD-965).
 *
 * The agent names a package; the client works out how THIS project installs
 * (its lockfile, its uv project or its `.venv`), asks the server's resolver
 * (`sponsored-package-resolve.ts`) whether the package is allowed and at which
 * exact version, and runs the canonical command through the same sandboxed
 * path the run's shell commands take. The resolver records the decision.
 *
 * The one hard rule: install scripts stay OFF. npm, pnpm and bun always run
 * with `--ignore-scripts`; Python installs wheels only (`--only-binary=:all:`
 * for pip, `--no-build` for uv), because building a source distribution runs
 * the package's own code. Yarn is refused (Berry ignores `--ignore-scripts`,
 * and nothing here can tell it from classic), and so is a Python project with
 * neither uv nor a project `.venv` (the system pip cannot write outside the
 * sandbox).
 *
 * Nothing the model sends is interpolated into a command unvalidated: the
 * name and version are checked here, and again after the server answers.
 *
 * This module is the handler both clients and Cloud share; each supplies the
 * file probe, the resolver call and the sandboxed exec.
 */

import { z } from 'zod'

import {
  EXACT_SEMVER,
  NPM_PACKAGE_NAME,
  canonicalInstall,
  sponsoredInstallSubdir,
  type SponsoredNpmPackageManager,
} from './sponsored-declared-installs'
import { PYPI_EXACT_VERSION, PYPI_PACKAGE_NAME } from './sponsored-skill'
import { sponsoredPackageManagerFromLockfiles } from './sponsored-step-check-context'

import type { SponsoredPackageResolveResponse } from './sponsored-package-resolve'
import type { CodebuffFileSystem } from '../types/filesystem'

export const SPONSORED_INSTALL_TOOL_NAME = 'install_package'

export const SPONSORED_INSTALL_TOOL_DESCRIPTION =
  'Install one package this integration needs into the project. Use it instead of running npm, pnpm, bun, pip or uv install commands in the shell, which are refused. Give the ecosystem (npm or pypi), the package name, and the exact version when the procedure pins one (otherwise Freebuff picks one). Set dev true for a development-only dependency, and dir to the repository-relative subfolder that holds the package manifest when it is not the root. Install scripts never run and Python installs use wheels only. The answer says what was installed, or why not.'

/** Seconds an install may take before it is stopped. */
export const SPONSORED_INSTALL_TIMEOUT_SECONDS = 180

/** How much of a failed install's output goes back to the model. */
export const SPONSORED_INSTALL_OUTPUT_TAIL = 1_500

export const sponsoredInstallInputShape = {
  ecosystem: z
    .enum(['npm', 'pypi'])
    .describe('npm for JavaScript/TypeScript packages, pypi for Python.'),
  name: z
    .string()
    .min(1)
    .max(214)
    .describe('The package name exactly as published, e.g. @acme/sdk or requests.'),
  version: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'An exact version such as 1.2.3 when the procedure pins one; omit to let Freebuff choose.',
    ),
  dev: z
    .boolean()
    .optional()
    .describe('true for a development-only dependency.'),
  dir: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Repository-relative subfolder holding the package manifest, when it is not the root.',
    ),
}

export const sponsoredInstallInputSchema = z.object(sponsoredInstallInputShape)

export type SponsoredInstallInput = z.infer<typeof sponsoredInstallInputSchema>

/** How this project installs a package of one ecosystem, or why it cannot. */
export type SponsoredInstallProject =
  | { kind: 'npm'; manager: SponsoredNpmPackageManager }
  | { kind: 'uv' }
  /** `python` is the venv's own interpreter, relative to the project root. */
  | { kind: 'venv'; python: string }
  | { kind: 'refuse'; reason: string }

export const SPONSORED_INSTALL_YARN_REFUSAL =
  'This project uses Yarn, and a sponsored run cannot install with Yarn safely (Yarn Berry ignores --ignore-scripts). Do not install it with the shell either: tell the user which package and version to add with Yarn themselves, and carry on with what is installed.'

export const SPONSORED_INSTALL_NO_VENV_REFUSAL =
  'This Python project has no uv project (uv.lock, or [tool.uv] in pyproject.toml) and no .venv, and the system pip cannot install inside the sandbox. Create a .venv first (python -m venv .venv), then call install_package again.'

export const SPONSORED_INSTALL_CAP_REFUSAL =
  'This run has reached its install limit. Do not install anything else; work with what is installed and tell the user what is missing.'

/**
 * How the project at `dir` installs `ecosystem`. `has` answers whether a
 * project-relative path exists; `readText` returns a file's text or null.
 * The subfolder is checked first, then the root (a monorepo keeps its
 * lockfile and venv there).
 */
export async function detectSponsoredInstallProject(
  ecosystem: 'npm' | 'pypi',
  dir: string,
  probe: {
    has: (relativePath: string) => Promise<boolean>
    readText: (relativePath: string) => Promise<string | null>
  },
): Promise<SponsoredInstallProject> {
  const folders = dir ? [dir, ''] : ['']
  const at = (folder: string, name: string) =>
    folder ? `${folder}/${name}` : name
  if (ecosystem === 'npm') {
    for (const folder of folders) {
      const manager = await sponsoredPackageManagerFromLockfiles((name) =>
        probe.has(at(folder, name)),
      )
      // `npm` is also the no-lockfile answer: keep looking toward the root.
      if (manager === 'npm' && !(await probe.has(at(folder, 'package-lock.json'))))
        continue
      if (manager === 'yarn')
        return { kind: 'refuse', reason: SPONSORED_INSTALL_YARN_REFUSAL }
      return { kind: 'npm', manager }
    }
    return { kind: 'npm', manager: 'npm' }
  }
  for (const folder of folders) {
    if (await probe.has(at(folder, 'uv.lock'))) return { kind: 'uv' }
    const pyproject = await probe.readText(at(folder, 'pyproject.toml'))
    if (pyproject !== null && /^\s*\[tool\.uv(?:\.[^\]]*)?\]/m.test(pyproject))
      return { kind: 'uv' }
    // `pyvenv.cfg` is a plain file in every venv; the interpreter itself is
    // usually a symlink out of the project, which a rooted probe may refuse.
    if (await probe.has(at(folder, '.venv/pyvenv.cfg'))) {
      const python = (await probe.has(at(folder, '.venv/Scripts')))
        ? '.venv/Scripts/python.exe'
        : '.venv/bin/python'
      return { kind: 'venv', python: at(folder, python) }
    }
  }
  return { kind: 'refuse', reason: SPONSORED_INSTALL_NO_VENV_REFUSAL }
}

/** The project probe over a file system rooted anywhere; `has` is any entry. */
export function sponsoredInstallProbe(
  fs: Pick<CodebuffFileSystem, 'stat' | 'readFile'>,
  root: string,
): Pick<SponsoredInstallToolDeps, 'has' | 'readText'> {
  const join = (relative: string) =>
    `${root.replace(/[\\/]+$/, '')}/${relative}`
  return {
    has: async (relative) => {
      try {
        await fs.stat(join(relative))
        return true
      } catch {
        return false
      }
    },
    readText: async (relative) => {
      try {
        return String(await fs.readFile(join(relative), 'utf8'))
      } catch {
        return null
      }
    },
  }
}

function validName(ecosystem: 'npm' | 'pypi', name: string): boolean {
  return ecosystem === 'npm'
    ? NPM_PACKAGE_NAME.test(name)
    : PYPI_PACKAGE_NAME.test(name)
}

function validVersion(ecosystem: 'npm' | 'pypi', version: string): boolean {
  return ecosystem === 'npm'
    ? EXACT_SEMVER.test(version)
    : PYPI_EXACT_VERSION.test(version)
}

/**
 * The command that installs `name@version` into this project, scripts off.
 * Only called with a validated name, version and subfolder.
 */
export function sponsoredInstallCommand(
  project: Exclude<SponsoredInstallProject, { kind: 'refuse' }>,
  pkg: { name: string; version: string; dev: boolean; dir: string },
): string {
  if (project.kind === 'npm') {
    return canonicalInstall(
      project.manager,
      [`${pkg.name}@${pkg.version}`],
      pkg.dev,
      pkg.dir,
    )
  }
  const spec = `${pkg.name}==${pkg.version}`
  if (project.kind === 'uv') {
    const uv = pkg.dir ? `uv --directory ${pkg.dir}` : 'uv'
    return `${uv} add --no-build${pkg.dev ? ' --dev' : ''} ${spec}`
  }
  // `./` so PowerShell runs a relative path as well as a POSIX shell does.
  return `./${project.python} -m pip install --only-binary=:all: ${spec}`
}

export type SponsoredInstallToolResult =
  | {
      status: 'installed'
      package: string
      ecosystem: 'npm' | 'pypi'
      declared: boolean
      command: string
      note?: string
    }
  | { status: 'refused'; reason: string }
  | { status: 'failed'; package: string; exitCode: number | null; output: string }

export type SponsoredInstallToolDeps = {
  has: (relativePath: string) => Promise<boolean>
  readText: (relativePath: string) => Promise<string | null>
  /** The server's resolver; a 429 already mapped to {@link SPONSORED_INSTALL_CAP_REFUSAL}. */
  resolve: (request: {
    ecosystem: 'npm' | 'pypi'
    name: string
    version?: string
  }) => Promise<SponsoredPackageResolveResponse>
  /**
   * Run `command` from the project root through the run's sandbox and its
   * command refusals (minus the shell-install refusal: this command is the
   * canonical one). `refused` when those refusals stopped it.
   */
  exec: (
    command: string,
    timeoutSeconds: number,
  ) => Promise<{ exitCode: number | null; output: string; refused?: boolean }>
}

/** The whole tool: validate, detect, resolve, install. Never throws. */
export async function runSponsoredInstallTool(
  deps: SponsoredInstallToolDeps,
  raw: unknown,
): Promise<SponsoredInstallToolResult> {
  const parsed = sponsoredInstallInputSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      status: 'refused',
      reason: 'Give ecosystem (npm or pypi) and the package name.',
    }
  }
  const input = parsed.data
  if (!validName(input.ecosystem, input.name)) {
    return {
      status: 'refused',
      reason: `"${input.name.slice(0, 80)}" is not a valid ${input.ecosystem} package name. Give the bare name only (no version, URL, path or flags).`,
    }
  }
  if (input.version !== undefined && !validVersion(input.ecosystem, input.version)) {
    return {
      status: 'refused',
      reason: `The version must be exact (such as 1.2.3), not a range, tag or URL. Omit it to let Freebuff choose.`,
    }
  }
  const dir = sponsoredInstallSubdir(input.dir ?? '')
  if (dir === null) {
    return {
      status: 'refused',
      reason: 'dir must be a plain subfolder inside the repository.',
    }
  }
  try {
    const project = await detectSponsoredInstallProject(input.ecosystem, dir, deps)
    if (project.kind === 'refuse') return { status: 'refused', reason: project.reason }

    const resolved = await deps.resolve({
      ecosystem: input.ecosystem,
      name: input.name,
      ...(input.version ? { version: input.version } : {}),
    })
    if (!resolved.allowed) return { status: 'refused', reason: resolved.reason }
    // The server's answer is checked like the model's: it is interpolated next.
    if (
      resolved.ecosystem !== input.ecosystem ||
      !validName(resolved.ecosystem, resolved.name) ||
      !validVersion(resolved.ecosystem, resolved.version)
    ) {
      return {
        status: 'refused',
        reason: 'Freebuff could not resolve this package to an exact version. Carry on without it and tell the user.',
      }
    }
    const command = sponsoredInstallCommand(project, {
      name: resolved.name,
      version: resolved.version,
      dev: input.dev === true,
      dir,
    })
    const label =
      resolved.ecosystem === 'npm'
        ? `${resolved.name}@${resolved.version}`
        : `${resolved.name}==${resolved.version}`
    const result = await deps.exec(command, SPONSORED_INSTALL_TIMEOUT_SECONDS)
    if (result.refused) return { status: 'refused', reason: result.output }
    if (result.exitCode !== 0) {
      return {
        status: 'failed',
        package: label,
        exitCode: result.exitCode,
        output: result.output.slice(-SPONSORED_INSTALL_OUTPUT_TAIL),
      }
    }
    return {
      status: 'installed',
      package: label,
      ecosystem: resolved.ecosystem,
      declared: resolved.declared,
      command,
      ...(resolved.note ? { note: resolved.note } : {}),
    }
  } catch (error) {
    return {
      status: 'refused',
      reason: `The install could not run: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
    }
  }
}

/**
 * The resolver's HTTP answer as the tool's input: a 2xx body read as the
 * response (malformed reads as a refusal), a 429 as the run's cap, anything
 * else as a refusal carrying the server's sentence.
 */
export function sponsoredPackageResolveOutcome(
  status: number,
  body: unknown,
  message?: string,
): SponsoredPackageResolveResponse {
  if (status === 429) return { allowed: false, reason: SPONSORED_INSTALL_CAP_REFUSAL }
  if (status >= 200 && status < 300) {
    const parsed = sponsoredPackageResolveResponseSchema.safeParse(body)
    if (parsed.success) return parsed.data
    return {
      allowed: false,
      reason: 'Freebuff answered this install request in a form this build does not understand. Carry on without it.',
    }
  }
  if (status === 0) {
    return {
      allowed: false,
      reason: 'Could not reach Freebuff to approve this install. Carry on without it and tell the user.',
    }
  }
  return {
    allowed: false,
    reason: message?.trim() || `Freebuff refused this install (${status}).`,
  }
}

const sponsoredPackageResolveResponseSchema: z.ZodType<SponsoredPackageResolveResponse> =
  z.union([
    z.object({
      allowed: z.literal(true),
      ecosystem: z.enum(['npm', 'pypi']),
      name: z.string(),
      version: z.string(),
      declared: z.boolean(),
      note: z.string().max(1_000).optional(),
    }),
    z.object({ allowed: z.literal(false), reason: z.string().max(2_000) }),
  ])
