/**
 * Layer 2 skills (COD-965): the advertiser-specific half of a sponsored run,
 * as a handful of fields a model drafts and an admin edits. The shared
 * instructions every run gets are Layer 1 (`SPONSORED_RUN_LAYER1_FRAME` in
 * `sponsored-run-prompt.ts`).
 *
 * A Layer 2 record is never sent to a client as is. It compiles to an
 * ordinary format-1 `SponsoredSkill` with no `fit` block (the "any project"
 * form), so every shipped Desktop, CLI and Cloud build parses, hashes and
 * drives it with the code it already has. The offer is decided by relevance
 * alone; the agent scaffolds a project when the folder has none. Store the
 * compiled skill and its hashes once; never recompile on read, or a later
 * compiler change would move hashes that Accepts already locked.
 */

import { z } from 'zod/v4'
import { simpleConversionDefinitionSchema } from './sponsored-conversion'

import {
  isSponsoredCredentialEnvName,
  type SponsoredRunCredential,
} from './sponsored-run-credentials'
import {
  PYPI_EXACT_VERSION,
  PYPI_PACKAGE_NAME,
  parseSponsoredSkill,
  sponsoredSkillTrackedLink,
  SPONSORED_SKILL_TRACKED_LINK_ERROR,
  type SponsoredSkill,
  type SponsoredSkillCheck,
  type SponsoredSkillPackage,
  type SponsoredSkillParseError,
  type SponsoredSkillStep,
} from './sponsored-skill'

/**
 * The changelog every compiled Layer 2 skill carries. It is how the run
 * prompt tells a Layer 2 skill (which gets the short Layer 1 frame) from a
 * registered long-form skill (which keeps the frame it shipped with).
 */
export const LAYER2_SKILL_CHANGELOG =
  'Layer 2 skill (COD-965): compiled from a drafted goal, docs link, signup link and packages.'

export function isLayer2Skill(
  skill: Pick<SponsoredSkill, 'changelog'> | null | undefined,
): boolean {
  return skill?.changelog === LAYER2_SKILL_CHANGELOG
}

export const LAYER2_MAX_PACKAGES = 6
export const LAYER2_MAX_ENV_KEYS = 2
/** Advertiser checks that the integration is really in the code. */
export const LAYER2_MAX_VERIFY = 3

const slug = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase words joined by -.')

const httpsUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && !url.username && !url.password
    } catch {
      return false
    }
  }, 'Use an HTTPS URL.')

const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
const NPM_EXACT_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/

const layer2Package = z.discriminatedUnion('ecosystem', [
  z
    .object({
      ecosystem: z.literal('npm'),
      name: z.string().trim().regex(NPM_NAME, 'Not an npm package name.'),
      /**
       * Usually omitted: the save records the latest release as the compiled
       * skill's pin, a fallback for clients without install_package, and a
       * run with the tool installs the latest release (`decideSponsoredPackage`).
       */
      version: z
        .string()
        .trim()
        .regex(NPM_EXACT_VERSION, 'Use an exact version, e.g. 1.2.3.')
        .optional(),
    })
    .strict(),
  z
    .object({
      ecosystem: z.literal('pypi'),
      name: z.string().trim().regex(PYPI_PACKAGE_NAME, 'Not a PyPI name.'),
      version: z
        .string()
        .trim()
        .regex(PYPI_EXACT_VERSION, 'Use an exact release, e.g. 2.32.3.')
        .optional(),
    })
    .strict(),
])

const layer2Verify = z
  .object({
    /** What the check proves, e.g. "a changed file imports disk". */
    label: z.string().trim().min(1).max(100),
    /** A case-insensitive regex over the changed source files. */
    pattern: z
      .string()
      .min(1)
      .max(200)
      .refine((pattern) => {
        try {
          new RegExp(pattern, 'i')
          return true
        } catch {
          return false
        }
      }, 'Not a valid regular expression.'),
  })
  .strict()

export type SponsoredSkillLayer2Verify = z.infer<typeof layer2Verify>

export const sponsoredSkillLayer2Schema = z
  .object({
    /** Stable slug, `<advertiser>-<goal>`; one id has many versions. */
    id: slug,
    advertiser: slug,
    /** One sentence: what the agent builds in the user's project. */
    goal: z.string().trim().min(10).max(300),
    docsUrl: httpsUrl,
    /** Sign-up or key page, carrying `bfcid={bfcid}` (and any UTMs). */
    signupUrl: httpsUrl.refine(
      (value) => value.includes('bfcid={bfcid}'),
      'Must carry bfcid={bfcid} in its query.',
    ),
    packages: z.array(layer2Package).max(LAYER2_MAX_PACKAGES),
    /** Secret env vars the integration reads, collected at the signup step. */
    envKeys: z
      .array(
        z
          .string()
          .trim()
          .refine(
            (name) => isSponsoredCredentialEnvName(name),
            'Use an UPPER_SNAKE name ending in _KEY, _TOKEN, _SECRET or _PASSWORD, not a platform prefix (AWS_, GITHUB_, OPENAI_ …).',
          ),
      )
      .max(LAYER2_MAX_ENV_KEYS)
      .optional(),
    /** Onboarding evidence only; legacy stored sources may omit measurement. */
    conversion: simpleConversionDefinitionSchema.optional(),
    /**
     * Code checks that prove the integration landed (an import of the SDK, a
     * call to its client). Omitted or empty compiles to no checks.
     */
    verify: z.array(layer2Verify).max(LAYER2_MAX_VERIFY).optional(),
    consent: z
      .object({
        title: z.string().trim().min(1).max(100),
        summary: z.string().trim().min(1).max(280),
      })
      .strict(),
  })
  .strict()

export type SponsoredSkillLayer2 = z.infer<typeof sponsoredSkillLayer2Schema>

/** `npm:posthog-js`: the key of a package's recorded release. */
export function layer2PackageKey(pkg: {
  ecosystem: 'npm' | 'pypi'
  name: string
}): string {
  return `${pkg.ecosystem}:${pkg.name}`
}

export type Layer2BuildResult =
  | {
      ok: true
      source: SponsoredSkillLayer2
      skill: SponsoredSkill
    }
  | { ok: false; errors: SponsoredSkillParseError[] }

/** `posthog` → `Posthog`, `open-router` → `Open Router`: a label, never parsed. */
function advertiserLabel(advertiser: string): string {
  return advertiser
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/** `POSTHOG_PROJECT_TOKEN` → `project token`, `EXA_API_KEY` → `API key`. */
function keyLabel(env: string, advertiser: string): string {
  const prefix = `${advertiser.replace(/-/g, '_').toUpperCase()}_`
  const rest = env.startsWith(prefix) ? env.slice(prefix.length) : env
  return rest
    .split('_')
    .map((word) => (word === 'API' ? word : word.toLowerCase()))
    .join(' ')
}

/** `a Posthog`, `an Archil`. */
function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const ENV_EXAMPLE_PATH =
  '**/{.env.example,.env.local.example,.env.sample,.env.template}'
/** The source files a verify check reads. */
const SOURCE_FILES = '**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,py}'

/**
 * The format-1, fit-free skill a Layer 2 record stands for (COD-965: no
 * project gate, so any folder can take the offer). Deterministic: the same
 * source and version always give the same bytes, and nothing optional is
 * emitted empty or as a default, so the hash only moves when a field does.
 */
export function compileLayer2Skill(
  source: SponsoredSkillLayer2,
  version: string,
): SponsoredSkill {
  const npm = source.packages.filter((pkg) => pkg.ecosystem === 'npm')
  const pypi = source.packages.filter((pkg) => pkg.ecosystem === 'pypi')
  const envKeys = source.envKeys ?? []
  const label = advertiserLabel(source.advertiser)

  // Format 1 has no fit block, so `frameworks` must be non-empty even for a
  // Python-only skill; it is informational there, like the archil skill's.
  const requirements: SponsoredSkill['requirements'] = {
    os: ['darwin', 'linux', 'win32'],
    runtimes: [
      // Native HTTP skills have no packages; retain a valid informational runtime.
      ...(npm.length || !pypi.length ? [{ name: 'node' as const }] : []),
      ...(pypi.length ? [{ name: 'python' as const }] : []),
    ],
    frameworks: ['nodejs'],
    packageManagers: ['npm', 'pnpm', 'bun'],
  }

  const packages: SponsoredSkillPackage[] = source.packages.map((pkg) => ({
    ecosystem: pkg.ecosystem,
    name: pkg.name,
    // buildLayer2Skill fills an unpinned package's recorded release first.
    version: pkg.version ?? '',
  }))

  // One deliberately loose check that the SDK landed: any file the run
  // changed names any of the skill's packages (an import, package.json, a
  // lockfile, requirements.txt, pyproject.toml). Install success is never
  // reported back, so this stands in for it; a mixed npm/PyPI skill passes
  // on either ecosystem.
  const packageNames = source.packages.map((pkg) => escapeRegex(pkg.name))
  const packageChecks: SponsoredSkillCheck[] = packageNames.length
    ? [
        {
          id: 'sdk-used',
          kind: 'file_contains',
          label: `the ${label} SDK shows up in the changes`,
          path: '**',
          pattern: `(^|[^A-Za-z0-9_-])(${packageNames.join('|')})([^A-Za-z0-9_-]|$)`,
          flags: 'im',
        },
      ]
    : []

  const envChecks: SponsoredSkillCheck[] = envKeys.map((key, index) => ({
    id: `env-${index + 1}`,
    kind: 'env_key_declared',
    label: `${key} is declared, empty, in an example env file`,
    path: ENV_EXAMPLE_PATH,
    key,
  }))

  const verifyChecks: SponsoredSkillCheck[] = (source.verify ?? []).map(
    (item, index) => ({
      id: `verify-${index + 1}`,
      kind: 'file_contains',
      label: item.label,
      path: SOURCE_FILES,
      pattern: item.pattern,
      flags: 'i',
    }),
  )

  // Guidance the agent adapts to the project, not a script; the checks are
  // what it must meet. No wording here may read as user work
  // (`NEEDS_USER_PATTERNS` in sponsored-procedure-steps.ts).
  const envLine = envKeys.length
    ? `\nRead ${envKeys.join(' and ')} from the environment; declare ${
        envKeys.length === 1 ? 'it' : 'each'
      } empty in the example env file.`
    : ''
  const integrate: SponsoredSkillStep = {
    id: 'integrate',
    kind: 'agent',
    title: `Build the ${label} integration in this project`,
    // Layer 1 already says fit the project, fewest changes, read the docs;
    // the renderer says a step is done when its checks pass.
    instructions: `${source.goal}\nDocs: ${source.docsUrl}\nIn an empty folder, scaffold a minimal project first.${envLine}`,
    checks: [
      ...verifyChecks,
      ...packageChecks,
      ...envChecks,
      {
        id: 'no-secrets',
        kind: 'no_privileged_secrets',
        label: 'changed files carry no secrets',
        paths: ['**'],
      },
    ],
  }

  const userSteps: SponsoredSkillStep[] = envKeys.length
    ? envKeys.map((env, index) => {
        const credential: SponsoredRunCredential = {
          env,
          label: `${label} ${keyLabel(env, source.advertiser)}`.slice(0, 60),
          getUrl: source.signupUrl,
        }
        return {
          id: `connect-${index + 1}`,
          kind: 'user',
          title: `Ask the user to create ${withArticle(`${label} ${keyLabel(env, source.advertiser)}`)} and paste it`,
          instructions: `The harness saves the value; never read, write or print it or an env file. Once ${env} is set, run the feature once and report whether ${label} answered.`,
          checks: [
            {
              id: `credential-${index + 1}`,
              kind: 'credential_provided',
              label: `the ${label} ${keyLabel(env, source.advertiser)} was provided`,
              envKey: env,
            },
          ],
          credential,
        }
      })
    : [
        {
          id: 'connect',
          kind: 'user',
          title: `Ask the user to sign up for ${label}`,
          instructions: `Open ${source.signupUrl} so the user can create an account, then say what is left to finish the integration.`,
          checks: [
            {
              id: 'signed-up',
              kind: 'user_confirmed',
              label: `the user finished signing up for ${label}`,
            },
          ],
        },
      ]

  return {
    format: 1,
    id: source.id,
    version,
    changelog: LAYER2_SKILL_CHANGELOG,
    advertiser: source.advertiser,
    goal: source.goal,
    fits: source.goal,
    consent: { title: source.consent.title, summary: source.consent.summary },
    requirements,
    packages,
    tools: [],
    // The docs link is in the integrate step.
    knowledge: [],
    preflight: [],
    steps: [integrate, ...userSteps],
    outcomes: envKeys.length ? ['api_key_issued'] : [],
    ...(source.conversion ? { conversion: source.conversion } : {}),
  }
}

/** Zod issues as the skill parser's `{ path, message }` errors. */
function zodErrors(error: z.ZodError): SponsoredSkillParseError[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }))
}

/**
 * Validate a Layer 2 record and compile it: the schema, then the full skill
 * parser every client runs, then the tracked-link rule (COD-882). Any failure
 * comes back as errors an admin can act on.
 */
export function buildLayer2Skill(
  value: unknown,
  version: string,
  /**
   * The release recorded for each package the source leaves unpinned, by
   * {@link layer2PackageKey}. A package with neither is refused.
   */
  releases: ReadonlyMap<string, string> = new Map(),
): Layer2BuildResult {
  const parsed = sponsoredSkillLayer2Schema.safeParse(value)
  if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) }
  const missing: SponsoredSkillParseError[] = []
  const recorded: SponsoredSkillLayer2 = {
    ...parsed.data,
    packages: parsed.data.packages.map((pkg, index) => {
      const release = pkg.version ?? releases.get(layer2PackageKey(pkg))
      if (!release)
        missing.push({
          path: `packages.${index}`,
          message: `No release recorded for ${pkg.name}.`,
        })
      return { ...pkg, version: release ?? '' }
    }),
  }
  if (missing.length) return { ok: false, errors: missing }
  const compiled = parseSponsoredSkill(compileLayer2Skill(recorded, version))
  if (!compiled.ok) return { ok: false, errors: compiled.errors }
  if (!sponsoredSkillTrackedLink(compiled.skill)) {
    return {
      ok: false,
      errors: [
        { path: 'signupUrl', message: SPONSORED_SKILL_TRACKED_LINK_ERROR },
      ],
    }
  }
  return { ok: true, source: parsed.data, skill: compiled.skill }
}
