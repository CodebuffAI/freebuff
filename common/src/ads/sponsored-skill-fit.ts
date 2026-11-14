/**
 * THE fit oracle: whether a sponsored skill's preflight would refuse a
 * repository, decided from the repository's FACTS before anything is
 * offered. Pure, no I/O: serving (freebuff-web), Desktop, the Web worker, the
 * CLI and the bench all call it, over facts built by the one builder here
 * ({@link sponsoredRepoFacts}).
 *
 * Each preflight check gets a three-valued verdict, ANDed across checks:
 * - `requirements.os` against the device OS;
 * - `file_exists` when its glob can only match fit files
 *   (`SPONSORED_FIT_FILE_NAMES`), so the facts' listing decides it;
 * - `file_contains changedOnly:false` against the manifests' dependency names
 *   (projected back into manifest-shaped text and matched with the check's
 *   own regex);
 * - `package_declared` against the root package.json's names;
 * - an `absent` check on a marker file (`.coderabbit.yaml`);
 * - a format-2 `fit` block directly.
 * Command and script checks are never fit checks: always `unknown`.
 *
 * Only a KNOWN misfit refuses ({@link sponsoredSkillFitRefusal}): an unknown
 * verdict serves, as today, and the skill's own preflight decides in the run.
 * Doc: `docs/ads/agentic/sponsored-skills.md`, "Fit".
 */

import {
  isSponsoredFitFileName,
  sponsoredFitGlobDecidable,
  sponsoredFitRoutes,
  expandSponsoredGlobBraces,
  SPONSORED_FIT_ECOSYSTEMS,
  SPONSORED_FIT_MANIFEST_NAMES,
  SPONSORED_FIT_MARKER_NAMES,
  type SponsoredFitRouteEcosystem,
} from './sponsored-skill-fit-format'
import {
  normalizePypiName,
  sponsoredSkillGlob,
  sponsoredSkillWebRefusal,
  type SponsoredSkill,
  type SponsoredSkillCheck,
  type SponsoredSkillOs,
  type SponsoredSkillWebRefusal,
} from './sponsored-skill'

import type {
  SponsoredSkillCheckContext,
  SponsoredSkillCommandResult,
} from './sponsored-skill-checks'

export * from './sponsored-skill-fit-format'

/** At most this many fit paths in one facts object; more marks the listing incomplete. */
export const MAX_REPO_FACT_PATHS = 256
/** Owen, 2026-10-14: at most 16 manifests and 400 dependency names, in memory only. */
export const MAX_REPO_FACT_MANIFESTS = 16
export const MAX_REPO_FACT_DEPENDENCY_NAMES = 400
/** The largest manifest the builder reads; a bigger one is listed with no names. */
export const MAX_REPO_FACT_MANIFEST_BYTES = 256 * 1024
const MAX_DEPENDENCY_NAME_CHARS = 214

export type SponsoredRepoManifestEcosystem = 'npm' | 'pypi'

export type SponsoredRepoManifest = {
  /** Repo-relative, `/`-separated. */
  path: string
  ecosystem: SponsoredRepoManifestEcosystem
  /**
   * Dependency names as written. npm: the keys of dependencies,
   * devDependencies, peerDependencies and optionalDependencies. Python: each
   * requirement's project name. NEVER logged, persisted or put in the
   * training log (Owen, 2026-10-14): memory only.
   */
  names: string[]
  /** Every name in the file is in `names` (not cut by a cap, and it parsed). */
  complete: boolean
}

/**
 * What the fit oracle knows about a repository. Built by
 * {@link sponsoredRepoFacts} on the client (or from legacy capability facts on
 * the server, {@link sponsoredRepoFactsFromLegacyFramework}).
 */
export type SponsoredRepoFacts = {
  v: 1
  /** Every fit-file path found (basename in SPONSORED_FIT_FILE_NAMES), repo-relative, sorted. */
  paths: string[]
  /**
   * The listing covered the whole project and nothing was cut, so a fit file
   * NOT in `paths` is absent. False makes every absence unknown.
   */
  complete: boolean
  /** Exact paths known to be absent even when `complete` is false (legacy facts). */
  absent?: string[]
  manifests: SponsoredRepoManifest[]
  /** Fit marker files (`.coderabbit.yaml`) that are empty or whitespace-only. */
  empty?: string[]
}

type MaybePromise<T> = T | Promise<T>

/**
 * THE builder of repository facts. `paths` is the project's file listing,
 * repo-relative (either separator; tracked and untracked, ignored files
 * excluded, like the step driver's `files()`); `complete` says that listing
 * is the whole project. `read` returns a file's text, or null when it is
 * missing or unreadable. Reads only manifests (≤16, ≤256 KiB each) and fit
 * marker files.
 */
export async function sponsoredRepoFacts(input: {
  paths: Iterable<string>
  complete: boolean
  read: (path: string) => MaybePromise<string | null>
}): Promise<SponsoredRepoFacts> {
  let complete = input.complete
  const found = new Set<string>()
  for (const raw of input.paths) {
    const path = raw.replace(/\\/g, '/').replace(/^\.\//, '')
    if (!path || path.split('/').includes('node_modules')) continue
    const basename = path.split('/').at(-1) ?? ''
    if (isSponsoredFitFileName(basename)) found.add(path)
  }
  let paths = [...found].sort(byDepthThenPath)
  if (paths.length > MAX_REPO_FACT_PATHS) {
    paths = paths.slice(0, MAX_REPO_FACT_PATHS)
    complete = false
  }

  const manifests: SponsoredRepoManifest[] = []
  let budget = MAX_REPO_FACT_DEPENDENCY_NAMES
  const manifestPaths = paths.filter((path) =>
    manifestEcosystem(path.split('/').at(-1) ?? ''),
  )
  for (const path of manifestPaths.slice(0, MAX_REPO_FACT_MANIFESTS)) {
    const basename = path.split('/').at(-1)!
    const ecosystem = manifestEcosystem(basename)!
    const text = await safeRead(input.read, path)
    const parsed =
      text === null || text.length > MAX_REPO_FACT_MANIFEST_BYTES
        ? { names: [], complete: false }
        : manifestDependencyNames(basename, text)
    const names = parsed.names.slice(0, Math.max(0, budget))
    budget -= names.length
    manifests.push({
      path,
      ecosystem,
      names,
      complete: parsed.complete && names.length === parsed.names.length,
    })
  }

  const empty: string[] = []
  for (const path of paths) {
    const basename = path.split('/').at(-1) ?? ''
    if (!(SPONSORED_FIT_MARKER_NAMES as readonly string[]).includes(basename))
      continue
    const text = await safeRead(input.read, path)
    if (text !== null && !/\S/.test(text)) empty.push(path)
  }

  return {
    v: 1,
    paths: paths.sort(),
    complete,
    manifests: manifests.sort((a, b) => a.path.localeCompare(b.path)),
    ...(empty.length ? { empty } : {}),
  }
}

async function safeRead(
  read: (path: string) => MaybePromise<string | null>,
  path: string,
): Promise<string | null> {
  try {
    return await read(path)
  } catch {
    return null
  }
}

function byDepthThenPath(a: string, b: string): number {
  const depth = a.split('/').length - b.split('/').length
  return depth || a.localeCompare(b)
}

const PYTHON_MANIFEST_REGEXES = SPONSORED_FIT_ECOSYSTEMS.python.manifests.map(
  (glob) => new RegExp(`^${glob.replace(/\./g, '\\.').replace(/\*/g, '[^/]*')}$`),
)

function manifestEcosystem(
  basename: string,
): SponsoredRepoManifestEcosystem | null {
  if (basename === 'package.json') return 'npm'
  return PYTHON_MANIFEST_REGEXES.some((re) => re.test(basename)) ? 'pypi' : null
}

const PYTHON_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*/

/** A requirement string's project name (`fastapi[all]>=0.1; python_version>"3"` → fastapi). */
function requirementName(requirement: string): string | null {
  const text = requirement.trim().replace(/^["']|["']$/g, '')
  if (!text || /^(?:-|git\+|https?:|file:|\.|\/)/.test(text)) return null
  const match = PYTHON_NAME.exec(text)
  return match ? match[0] : null
}

/** A TOML line with its string literals removed (`"fastapi[all]"` holds a `]`). */
function outsideStrings(line: string): string {
  return line.replace(/"[^"]*"|'[^']*'/g, '""')
}

/**
 * The dependency names one manifest declares. Never throws: a manifest that
 * does not parse is `complete: false` with whatever was read.
 */
export function manifestDependencyNames(
  basename: string,
  text: string,
): { names: string[]; complete: boolean } {
  const names = new Set<string>()
  let complete = true
  const add = (name: string | null) => {
    if (name && name.length <= MAX_DEPENDENCY_NAME_CHARS) names.add(name)
  }
  if (basename === 'package.json') {
    try {
      const parsed = JSON.parse(text.replace(/^﻿/, '')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return { names: [], complete: false }
      for (const field of [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ]) {
        const deps = (parsed as Record<string, unknown>)[field]
        if (deps && typeof deps === 'object' && !Array.isArray(deps))
          for (const key of Object.keys(deps)) add(key)
      }
    } catch {
      return { names: [], complete: false }
    }
    return { names: [...names], complete }
  }
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  if (/^requirements[^/]*\.txt$/.test(basename)) {
    for (const line of lines) add(requirementName(line.replace(/\s#.*$|^#.*$/, '')))
    return { names: [...names], complete }
  }
  if (basename === 'Pipfile' || basename === 'pyproject.toml') {
    let table = ''
    let arrayOpen = false
    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+#.*$/, '').trim()
      if (!line || line.startsWith('#')) continue
      const header = /^\[\[?([^\]]+)\]\]?$/.exec(line)
      if (header) {
        table = header[1]!.trim()
        arrayOpen = false
        continue
      }
      if (arrayOpen) {
        for (const literal of line.matchAll(/["']([^"']+)["']/g))
          add(requirementName(literal[1]!))
        if (outsideStrings(line).includes(']')) arrayOpen = false
        continue
      }
      const assign = /^([A-Za-z0-9_.\-"']+)\s*=\s*(.*)$/.exec(line)
      if (!assign) continue
      const key = assign[1]!.replace(/["']/g, '')
      const value = assign[2]!
      const keyTable =
        table === 'packages' ||
        table === 'dev-packages' ||
        /^tool\.poetry(?:\.group\.[^.]+)?\.(?:dev-)?dependencies$/.test(table)
      if (keyTable) {
        if (key !== 'python') add(requirementName(key))
        continue
      }
      const arrayTable =
        (table === 'project' && key === 'dependencies') ||
        table === 'project.optional-dependencies' ||
        table === 'dependency-groups' ||
        (table === 'tool.uv' && key === 'dev-dependencies')
      if (arrayTable && value.startsWith('[')) {
        for (const literal of value.matchAll(/["']([^"']+)["']/g))
          add(requirementName(literal[1]!))
        if (!outsideStrings(value).slice(1).includes(']')) arrayOpen = true
      }
    }
    return { names: [...names], complete }
  }
  if (basename === 'setup.cfg') {
    let collecting = false
    let table = ''
    for (const rawLine of lines) {
      const header = /^\s*\[([^\]]+)\]\s*$/.exec(rawLine)
      if (header) {
        table = header[1]!.trim()
        collecting = false
        continue
      }
      const assign = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(rawLine)
      if (assign) {
        collecting =
          (table === 'options' && assign[1] === 'install_requires') ||
          table === 'options.extras_require'
        if (collecting) add(requirementName(assign[2]!.replace(/#.*$/, '')))
        continue
      }
      if (collecting && /^\s+\S/.test(rawLine))
        add(requirementName(rawLine.replace(/#.*$/, '')))
    }
    return { names: [...names], complete }
  }
  if (basename === 'setup.py') {
    // A setup.py is code: read the literal install_requires / extras_require
    // lists, and say the answer may be partial.
    complete = false
    for (const block of text.matchAll(
      /(?:install_requires|extras_require)\s*=\s*([[{][\s\S]*?[\]}])\s*[,)]/g,
    )) {
      for (const literal of block[1]!.matchAll(/["']([^"']+)["']/g))
        add(requirementName(literal[1]!))
    }
    return { names: [...names], complete }
  }
  return { names: [], complete: false }
}

/**
 * Facts from a Desktop V1 local capability, which has no listing: its
 * `framework` is `unknown` exactly when there is no root package.json
 * (`desktopLocalCapability`), `nextjs` when the root package.json declares
 * `next`, `unsupported` for any other root package.json. Null for anything
 * else.
 */
export function sponsoredRepoFactsFromLegacyFramework(
  framework: string | null | undefined,
): SponsoredRepoFacts | null {
  if (framework === 'unknown')
    return { v: 1, paths: [], complete: false, absent: ['package.json'], manifests: [] }
  if (framework === 'nextjs')
    return {
      v: 1,
      paths: ['package.json'],
      complete: false,
      manifests: [
        { path: 'package.json', ecosystem: 'npm', names: ['next'], complete: false },
      ],
    }
  if (framework === 'unsupported')
    return { v: 1, paths: ['package.json'], complete: false, manifests: [] }
  return null
}

export type SponsoredFitCheckVerdict = 'pass' | 'fail' | 'unknown'

export type SponsoredFitInput = {
  /** The device OS the run would execute on, as `requirements.os` names it; null is unknown. */
  os?: SponsoredSkillOs | null
  repo?: SponsoredRepoFacts | null
  /** A Freebuff Web (browser workspace) request: folds in `sponsoredSkillWebRefusal`. */
  web?: boolean
}

export type SponsoredFitMisfitReason =
  | 'os'
  | 'no_manifest'
  | 'no_route'
  | 'file_missing'
  | 'file_content'
  | 'file_present'
  | 'package_missing'
  | SponsoredSkillWebRefusal

export type SponsoredSkillFitVerdict =
  | { fit: 'fits' }
  | {
      fit: 'unknown'
      /** The checks the facts could not decide (`fit` for the block, `requirements-os`). */
      unknownChecks: string[]
    }
  | {
      fit: 'misfit'
      reason: SponsoredFitMisfitReason
      checkId: string
      /** `known`: the facts prove the skill's own preflight refuses. */
      proof: 'known'
      unknownChecks: string[]
    }

export const SPONSORED_FIT_OS_CHECK_ID = 'requirements-os'
export const SPONSORED_FIT_BLOCK_CHECK_ID = 'fit'
export const SPONSORED_FIT_WEB_CHECK_ID = 'web'

type Facts = SponsoredRepoFacts

function pathsMatching(facts: Facts, glob: string): string[] {
  const re = sponsoredSkillGlob(glob)
  return facts.paths.filter((path) => re.test(path))
}

/** Whether no fit path the glob could match exists, as far as the facts prove. */
function provenAbsent(facts: Facts, glob: string): boolean {
  if (facts.complete) return sponsoredFitGlobDecidable(glob)
  // Without a full listing, only a glob of exact paths the facts name absent.
  const literals = expandSponsoredGlobBraces(glob)
  return (
    literals.every((literal) => !/[*?]/.test(literal)) &&
    literals.every((literal) => facts.absent?.includes(literal))
  )
}

function manifestAt(facts: Facts, path: string): SponsoredRepoManifest | null {
  return facts.manifests.find((manifest) => manifest.path === path) ?? null
}

/**
 * A manifest as text a check's regex can read: package.json as a JSON
 * object of its dependencies, a Python manifest as one requirement per line.
 * What the facts carry of the real file, never more.
 */
export function sponsoredManifestProjection(
  manifest: SponsoredRepoManifest,
): string {
  if (manifest.ecosystem === 'npm')
    return `{\n${manifest.names.map((name) => `  "${name}": "*"`).join(',\n')}\n}\n`
  return `${manifest.names.join('\n')}\n`
}

/** Whether a check can ever be decided from repository facts. */
export function sponsoredFitCheckDecidable(check: SponsoredSkillCheck): boolean {
  switch (check.kind) {
    case 'file_exists':
      return sponsoredFitGlobDecidable(check.path)
    case 'file_contains':
      return (check.changedOnly ?? true) === false && sponsoredFitGlobDecidable(check.path)
    case 'package_declared':
    case 'no_privileged_secrets':
    case 'changes_within':
      return true
    default:
      return false
  }
}

/** The preflight check kinds that test the user's project. */
const SPONSORED_FIT_TEST_KINDS: readonly string[] = [
  'file_exists',
  'file_contains',
  'package_declared',
]

/**
 * A skill's own preflight checks that test the project but that no
 * repository facts can decide (COD-965). The offer serves on `unknown`, so
 * such a check refuses only after the charged Accept. A format-2 `fit` block
 * compiles to decidable checks and is never listed.
 */
export function sponsoredSkillUndecidableFitChecks(
  skill: Pick<SponsoredSkill, 'preflight'>,
): SponsoredSkillCheck[] {
  return (skill.preflight ?? []).filter(
    (check) =>
      SPONSORED_FIT_TEST_KINDS.includes(check.kind) &&
      !sponsoredFitCheckDecidable(check),
  )
}

/** One preflight check's three-valued verdict over the facts. */
export function evaluateSponsoredFitCheck(
  check: SponsoredSkillCheck,
  facts: Facts | null | undefined,
): SponsoredFitCheckVerdict {
  // Before the first edit nothing has changed: these pass in every preflight.
  if (check.kind === 'no_privileged_secrets' || check.kind === 'changes_within')
    return 'pass'
  if (!facts) return 'unknown'
  switch (check.kind) {
    case 'file_exists':
      if (pathsMatching(facts, check.path).length) return 'pass'
      return provenAbsent(facts, check.path) ? 'fail' : 'unknown'
    case 'file_contains': {
      // A changed-only check reads the run's own changes; none exist yet.
      if ((check.changedOnly ?? true) !== false) return 'unknown'
      let re: RegExp
      try {
        re = new RegExp(check.pattern, check.flags)
      } catch {
        return 'unknown'
      }
      const files = pathsMatching(facts, check.path)
      if (check.absent) {
        let unknown = false
        for (const path of files) {
          if (facts.empty?.includes(path)) {
            if (re.test('')) return 'fail'
            continue
          }
          const manifest = manifestAt(facts, path)
          const isMarker = (SPONSORED_FIT_MARKER_NAMES as readonly string[]).includes(
            path.split('/').at(-1) ?? '',
          )
          // A present marker that is not empty has a non-blank character:
          // a pattern any such text matches fails it.
          if (isMarker && (check.pattern === '\\S' || check.pattern === '^'))
            return 'fail'
          if (manifest && re.test(sponsoredManifestProjection(manifest))) return 'fail'
          if (check.pattern === '^') return 'fail'
          unknown = true
        }
        if (unknown) return 'unknown'
        if (files.length === 0 && !provenAbsent(facts, check.path)) return 'unknown'
        return 'pass'
      }
      let unknown = false
      for (const path of files) {
        const manifest = manifestAt(facts, path)
        if (facts.empty?.includes(path)) {
          if (re.test('')) return 'pass'
          continue
        }
        if (!manifest) {
          unknown = true
          continue
        }
        if (re.test(sponsoredManifestProjection(manifest))) return 'pass'
        if (!manifest.complete) unknown = true
      }
      if (unknown) return 'unknown'
      if (files.length === 0 && !provenAbsent(facts, check.path)) return 'unknown'
      return 'fail'
    }
    case 'package_declared': {
      const root = manifestAt(facts, 'package.json')
      if (root) {
        if (root.names.includes(check.name)) return 'pass'
        return root.complete ? 'fail' : 'unknown'
      }
      if (facts.paths.includes('package.json')) return 'unknown'
      return provenAbsent(facts, 'package.json') ? 'fail' : 'unknown'
    }
    default:
      return 'unknown'
  }
}

function routeVerdict(
  facts: Facts,
  ecosystem: SponsoredFitRouteEcosystem,
  dependencies: string[] | null,
): SponsoredFitCheckVerdict {
  const glob = `**/{${SPONSORED_FIT_ECOSYSTEMS[ecosystem].manifests.join(',')}}`
  const files = pathsMatching(facts, glob)
  if (!files.length) return provenAbsent(facts, glob) ? 'fail' : 'unknown'
  if (!dependencies) return 'pass'
  const wanted = new Set(
    ecosystem === 'python' ? dependencies.map(normalizePypiName) : dependencies,
  )
  let unknown = false
  for (const path of files) {
    const manifest = manifestAt(facts, path)
    if (!manifest) {
      unknown = true
      continue
    }
    const names =
      ecosystem === 'python' ? manifest.names.map(normalizePypiName) : manifest.names
    if (names.some((name) => wanted.has(name))) return 'pass'
    if (!manifest.complete) unknown = true
  }
  return unknown ? 'unknown' : 'fail'
}

/** A format-2 fit block over the facts: the routes ORed, then `mustNotExist`. */
function fitBlockVerdict(
  skill: SponsoredSkill,
  facts: Facts | null | undefined,
): { verdict: SponsoredFitCheckVerdict; reason?: SponsoredFitMisfitReason } {
  const fit = skill.fit
  if (!fit) return { verdict: 'pass' }
  if (!facts) return { verdict: 'unknown' }
  const routes = sponsoredFitRoutes(fit)
  const verdicts = routes.map((route) =>
    routeVerdict(facts, route.ecosystem, route.dependencies),
  )
  let route: SponsoredFitCheckVerdict = verdicts.includes('pass')
    ? 'pass'
    : verdicts.includes('unknown')
      ? 'unknown'
      : 'fail'
  if (route === 'fail') {
    const anyManifest = routes.some(
      (r) =>
        pathsMatching(
          facts,
          `**/{${SPONSORED_FIT_ECOSYSTEMS[r.ecosystem].manifests.join(',')}}`,
        ).length > 0,
    )
    return { verdict: 'fail', reason: anyManifest ? 'no_route' : 'no_manifest' }
  }
  for (const glob of fit.mustNotExist ?? []) {
    if (pathsMatching(facts, glob).length)
      return { verdict: 'fail', reason: 'file_present' }
    if (!provenAbsent(facts, glob)) route = route === 'pass' ? 'unknown' : route
  }
  return { verdict: route }
}

function checkMisfitReason(check: SponsoredSkillCheck): SponsoredFitMisfitReason {
  switch (check.kind) {
    case 'file_exists':
      return 'file_missing'
    case 'package_declared':
      return 'package_missing'
    case 'file_contains':
      return check.absent ? 'file_present' : 'file_content'
    default:
      return 'file_content'
  }
}

/**
 * THE fit verdict of one skill for one repository and device. `fits` only
 * when every fit check passes; `misfit` as soon as one is proven to fail
 * (the first, in the order the step driver runs them); `unknown` otherwise.
 */
export function evaluateSponsoredSkillFit(
  skill: SponsoredSkill,
  input: SponsoredFitInput,
): SponsoredSkillFitVerdict {
  const unknownChecks: string[] = []
  const misfit = (
    reason: SponsoredFitMisfitReason,
    checkId: string,
  ): SponsoredSkillFitVerdict => ({
    fit: 'misfit',
    reason,
    checkId,
    proof: 'known',
    unknownChecks,
  })
  if (input.web) {
    const web = sponsoredSkillWebRefusal(skill)
    if (web) return misfit(web, SPONSORED_FIT_WEB_CHECK_ID)
  }
  const supported = skill.requirements?.os ?? []
  if (supported.length) {
    if (!input.os) unknownChecks.push(SPONSORED_FIT_OS_CHECK_ID)
    else if (!supported.includes(input.os))
      return misfit('os', SPONSORED_FIT_OS_CHECK_ID)
  }
  if (skill.fit) {
    const block = fitBlockVerdict(skill, input.repo)
    if (block.verdict === 'fail')
      return misfit(block.reason ?? 'no_route', SPONSORED_FIT_BLOCK_CHECK_ID)
    if (block.verdict === 'unknown') unknownChecks.push(SPONSORED_FIT_BLOCK_CHECK_ID)
  }
  for (const check of skill.preflight ?? []) {
    const verdict = evaluateSponsoredFitCheck(check, input.repo)
    if (verdict === 'fail') return misfit(checkMisfitReason(check), check.id)
    if (verdict === 'unknown') unknownChecks.push(check.id)
  }
  return unknownChecks.length ? { fit: 'unknown', unknownChecks } : { fit: 'fits' }
}

export type SponsoredSkillFitRefusal = {
  reason: SponsoredFitMisfitReason
  checkId: string
}

/**
 * Why `skill` must not be offered for this repository and device, or null.
 * Refuses ONLY a known misfit: an unknown verdict serves.
 */
export function sponsoredSkillFitRefusal(
  skill: SponsoredSkill,
  input: SponsoredFitInput,
): SponsoredSkillFitRefusal | null {
  const verdict = evaluateSponsoredSkillFit(skill, input)
  return verdict.fit === 'misfit' && verdict.proof === 'known'
    ? { reason: verdict.reason, checkId: verdict.checkId }
    : null
}

/**
 * The repository's ecosystems, for logs: which manifests exist, never what
 * they declare. `root` counts only manifests at the repository root.
 */
export function sponsoredRepoFactsSummary(facts: SponsoredRepoFacts | null | undefined): {
  ecosystems: string[]
  rootEcosystems: string[]
  complete: boolean | null
  empty: boolean | null
  monorepo: boolean | null
} {
  if (!facts)
    return { ecosystems: [], rootEcosystems: [], complete: null, empty: null, monorepo: null }
  const ecosystemOf = (basename: string): string | null => {
    if (basename === 'package.json' || basename === 'deno.json' || basename === 'deno.jsonc')
      return basename === 'package.json' ? 'node' : 'deno'
    if (manifestEcosystem(basename) === 'pypi') return 'python'
    if (basename === 'go.mod') return 'go'
    if (basename === 'Cargo.toml') return 'rust'
    if (basename === 'composer.json') return 'php'
    if (basename === 'Gemfile') return 'ruby'
    if (basename === 'pom.xml' || basename.startsWith('build.gradle')) return 'java'
    return null
  }
  const all = new Set<string>()
  const root = new Set<string>()
  let packageJsons = 0
  for (const path of facts.paths) {
    const parts = path.split('/')
    const ecosystem = ecosystemOf(parts.at(-1) ?? '')
    if (!ecosystem) continue
    all.add(ecosystem)
    if (parts.length === 1) root.add(ecosystem)
    if (parts.at(-1) === 'package.json') packageJsons++
  }
  return {
    ecosystems: [...all].sort(),
    rootEcosystems: [...root].sort(),
    complete: facts.complete,
    empty: facts.complete ? facts.paths.length === 0 : null,
    monorepo:
      packageJsons > 1 ||
      facts.paths.includes('pnpm-workspace.yaml') ||
      (all.size > 1 && root.size < all.size),
  }
}

/** Which fit file names a manifest-reading client should open (and nothing else). */
export const SPONSORED_FIT_READ_NAMES: readonly string[] = [
  ...SPONSORED_FIT_MANIFEST_NAMES,
  ...SPONSORED_FIT_MARKER_NAMES,
]

/** What a listed file that is neither a manifest nor an empty marker holds. */
const LISTED_FILE_PLACEHOLDER = '#\n'

/**
 * The repository exactly as its facts show it, as files the REAL check
 * evaluator can read ({@link sponsoredStaticCheckContext}):
 * - each listed manifest, rendered from its dependency names (package.json
 *   as a `dependencies` object, a Python manifest one name per line, as
 *   {@link sponsoredManifestProjection}); a listed manifest with no names is
 *   an empty one (`{}`, or nothing);
 * - an empty marker empty, and any other listed file a non-blank line;
 * - and NOTHING the facts do not list.
 *
 * That last point is an assumption about what the facts leave out, and it is
 * what lets the run's own preflight answer over facts
 * (`runSponsoredSkillPreflightOverFacts` in `./sponsored-step-driver`): a
 * check that needs a file or a dependency the facts do not show fails. Only
 * a caller that has decided to hold the facts to that should use it; the
 * offer route does it for a Desktop V1 snapshot (docs/freebuff-agentic-ads.md,
 * "Skill fit on the offer route").
 */
export function sponsoredRepoFactsFiles(
  facts: SponsoredRepoFacts,
): Record<string, string> {
  const files: Record<string, string> = {}
  for (const path of facts.paths) {
    const basename = path.split('/').at(-1) ?? ''
    const manifest = manifestAt(facts, path)
    const ecosystem = manifest?.ecosystem ?? manifestEcosystem(basename)
    if (ecosystem === 'npm') {
      const dependencies = Object.fromEntries(
        (manifest?.names ?? []).map((name) => [name, '*']),
      )
      files[path] = `${JSON.stringify({ dependencies }, null, 2)}\n`
    } else if (ecosystem === 'pypi') {
      files[path] = manifest ? sponsoredManifestProjection(manifest) : ''
    } else {
      files[path] = facts.empty?.includes(path) ? '' : LISTED_FILE_PLACEHOLDER
    }
  }
  return files
}

/**
 * `skill` with only the preflight checks repository facts can decide
 * ({@link sponsoredFitCheckDecidable}). A format-2 fit block compiles into
 * such checks and is kept whole. Commands, scripts and checks of any other
 * file are left to the run's own preflight, which sees the real project.
 */
export function sponsoredSkillFactChecksOnly(
  skill: SponsoredSkill,
): SponsoredSkill {
  return {
    ...skill,
    preflight: (skill.preflight ?? []).filter(sponsoredFitCheckDecidable),
  }
}

/**
 * A check context over a fixed set of files, for evaluating the REAL checks
 * against a snapshot (fidelity tests, the bench oracle). Nothing has changed,
 * every command is unavailable, no credential or confirmation exists.
 */
export function sponsoredStaticCheckContext(
  files: Readonly<Record<string, string>>,
): SponsoredSkillCheckContext {
  const unavailable: SponsoredSkillCommandResult = {
    exitCode: 127,
    output: 'commands do not run in a static check context',
    unavailable: true,
  }
  return {
    files: () => Object.keys(files).sort(),
    changedFiles: () => [],
    readFile: (path) => files[path] ?? null,
    runScript: async () => unavailable,
    runCommand: async () => unavailable,
    credentialProvided: () => false,
    userConfirmed: () => false,
  }
}
