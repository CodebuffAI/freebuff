/**
 * Whether a client build can run a skill's pinned installs.
 *
 * A sponsored run may install only the packages its skill declares
 * (`evaluateSponsoredInstallCommand`), and the CLIENT supplies that list: the
 * skill kept with the run, else its own bundled registry, else (Desktop only)
 * the server's copy. A build that cannot resolve the skill runs with an empty
 * list and refuses even the skill's own pinned install, so the run writes code
 * against a package it never installed (2026-10-13/14: 9 of 30 Exa runs, on
 * Desktop builds older than declared installs or the skill fetch, and every
 * CLI build, none of which bundles exa-web-search-feature@2.0.0).
 *
 * So a skill that declares packages is offered, and accepted, only on a build
 * that can resolve it:
 *
 *  - Desktop from {@link SPONSORED_DESKTOP_SKILL_FETCH_MIN}: the first build
 *    with declared installs AND the server skill fetch, which resolves any
 *    skill version whether or not the build bundles it.
 *  - The CLI from {@link SPONSORED_CLI_SKILL_DELIVERY_MIN}, which takes the
 *    skill the Accept delivers (#6709). An older CLI only runs a skill it
 *    BUNDLES: the first such release is listed in
 *    {@link SPONSORED_SKILL_MIN_CLIENT}.
 *
 * A skill that declares no packages, a free-text procedure, and the web client
 * (server-run, always current) are never refused here.
 *
 * A client that runs the RUN SPEC (`runSpecVersion`, `./sponsored-run-spec.ts`)
 * is never refused for its version: the Accept hands it the skill and its
 * packages, and it resolves nothing itself. It is refused only when the
 * SERVER cannot resolve the skill the procedure names
 * (`skill_unresolved`), because then there is no spec to hand it.
 *
 * A skill that carries a CONVERSION DEFINITION (`conversion`, either
 * version) is the exception to all of the above, run-spec clients, the web
 * client and free-text procedures included: only a Desktop build that
 * advertises the conversion tools (`conversionToolsVersion`,
 * `SPONSORED_CONVERSION_TOOLS_VERSION` in `./sponsored-conversion.ts`) can
 * run it, so it is never offered to, nor accepted from, any other build. It
 * is a capability rather than a version floor because the tools ship on a
 * branch: a Desktop release cut without them must not pass on its number.
 */

import {
  CONVERSION_DIRECTIVE,
  conversionDefinitionFromProcedure,
  clientHasSponsoredConversionTools,
} from './sponsored-conversion'
import { clientRunsSponsoredRunSpec } from './sponsored-run-spec'
import { compareSponsoredSkillVersions } from './sponsored-skill'

/** Desktop 0.0.172: declared installs (#6427) and the server skill fetch. */
export const SPONSORED_DESKTOP_SKILL_FETCH_MIN = '0.0.172'

/**
 * The first CLI release that drives the skill delivered on the Accept (#6709,
 * merged after 0.2.28 was cut), so it resolves a skill it does not bundle.
 */
export const SPONSORED_CLI_SKILL_DELIVERY_MIN = '0.2.29'

/**
 * Per skill version (`<id>@<version>`), the first build of each client that
 * can run it, where that is later than the defaults above. `cli` is the
 * first CLI release whose bundled registry contains the skill, when that is
 * older than {@link SPONSORED_CLI_SKILL_DELIVERY_MIN}.
 */
export const SPONSORED_SKILL_MIN_CLIENT: Readonly<
  Record<string, { desktop?: string; cli?: string }>
> = {
  // CLI 0.2.27 is the first with declared installs (#6427).
  'supabase-persist-one-feature@1.0.0': { cli: '0.2.27' },
  'exa-web-search-feature@1.0.0': { cli: '0.2.28' },
  'exa-web-search-feature@1.1.0': { cli: '0.2.28' },
  'archil-persist-files-on-disk@2.0.0': { cli: '0.2.28' },
  'archil-persist-files-on-disk@2.0.1': { cli: '0.2.28' },
  'respan-agent-setup@2.0.1': { cli: '0.2.28' },
  'respan-agent-setup@2.0.2': { cli: '0.2.28' },
  // Not bundled by any CLI before 0.2.29: exa-web-search-feature@2.0.0,
  // respan-agent-setup@2.1.0, axonstream-realtime-one-feature@1.0.0.
}

/**
 * The first build of each client that PARSES format 2 (the structured `fit`
 * block, `sponsored-skill-fit-format.ts`): the next releases cut after #7039.
 * An older build cannot parse a format-2 skill, so it would run the rendered
 * procedure as text with no fit, step or security checks, or (a run-spec
 * client) refuse the Accept. A format-2 skill is never offered to one.
 * Re-check these against the release that actually ships format 2.
 */
export const SPONSORED_SKILL_FORMAT_2_MIN_CLIENT = {
  desktop: '0.0.174',
  cli: '0.2.29',
} as const

export type SponsoredSkillClientRefusal =
  /** A Desktop or CLI user agent whose version cannot be read. */
  | 'client_version_unknown'
  /**
   * A Desktop older than the skill needs, or (a conversion skill) one that
   * does not advertise the conversion tools.
   */
  | 'desktop_too_old'
  /** A CLI that neither bundles the skill nor takes it from the Accept. */
  | 'cli_too_old'
  /**
   * A run-spec client, and the server could not resolve the skill the
   * procedure names, so it has no spec to deliver.
   */
  | 'skill_unresolved'
  /**
   * The skill carries a conversion definition and this client has no
   * conversion tools in any build: the CLI and the web (Cloud) client. No
   * update fixes it, only running the offer in Desktop. A Desktop that does
   * not advertise the tools is `desktop_too_old`.
   */
  | 'conversion_tools_missing'

/**
 * Why `clientVersion` (`desktop/<v>` or `cli/<v>`, from
 * `sponsoredClientVersionFromUserAgent`) cannot run the named skill, or null
 * when it can.
 *
 * `skill` is the resolved skill, or null when the procedure names one that
 * could not be read: that is treated as declaring packages, since an unknown
 * verdict must not serve. `dev` builds always pass.
 *
 * `procedure` is the text the client would run. When `skill` is null it is
 * the only way to see a conversion definition (the `conversion-definition:`
 * line the skill renders), so pass it wherever it is at hand. A free-text
 * procedure (`skillRef` null) with that line is gated too.
 *
 * `conversionToolsVersion` is the request's field, as sent: a Desktop runs a
 * conversion skill only when it advertises the tools, `dev` builds included.
 */
export function sponsoredSkillClientRefusal(input: {
  client: 'desktop' | 'cli' | 'web' | null
  clientVersion: string | null
  /** The skill the procedure names (`sponsoredSkillDirective`), or null for free text. */
  skillRef: { id: string; version: string } | null
  skill: {
    packages: readonly unknown[]
    format?: number
    conversion?: unknown
  } | null
  /** The procedure text the skill renders to, when the caller has it. */
  procedure?: string | null
  /** The request's `runSpecVersion`, as sent. */
  runSpecVersion?: unknown
  /** The request's `conversionToolsVersion`, as sent. */
  conversionToolsVersion?: unknown
}): SponsoredSkillClientRefusal | null {
  // CONVERSION FIRST, for every client, run-spec, web and free text
  // included: only a Desktop build with the conversion tools can run it.
  const conversion = sponsoredConversionClientRefusal(input)
  if (conversion) return conversion
  if (!input.skillRef) return null
  // FORMAT 2 FIRST, for every Desktop and CLI build, run-spec ones included:
  // a build that cannot parse the skill cannot drive it.
  if (
    input.skill?.format === 2 &&
    (input.client === 'desktop' || input.client === 'cli')
  ) {
    const version = clientVersionOf(input.client, input.clientVersion)
    if (version === null) return 'client_version_unknown'
    if (
      version !== 'dev' &&
      compareSponsoredSkillVersions(
        version,
        SPONSORED_SKILL_FORMAT_2_MIN_CLIENT[input.client],
      ) < 0
    )
      return input.client === 'desktop' ? 'desktop_too_old' : 'cli_too_old'
  }
  if (clientRunsSponsoredRunSpec(input.runSpecVersion)) {
    return input.skill ? null : 'skill_unresolved'
  }
  if (input.client !== 'desktop' && input.client !== 'cli') return null
  if (input.skill && input.skill.packages.length === 0) return null

  const prefix = `${input.client}/`
  if (!input.clientVersion?.startsWith(prefix)) return 'client_version_unknown'
  const version = input.clientVersion.slice(prefix.length)
  if (version === 'dev') return null
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    return 'client_version_unknown'
  }

  const listed =
    SPONSORED_SKILL_MIN_CLIENT[`${input.skillRef.id}@${input.skillRef.version}`]
  if (input.client === 'desktop') {
    const min = maxVersion(SPONSORED_DESKTOP_SKILL_FETCH_MIN, listed?.desktop)
    return compareSponsoredSkillVersions(version, min) < 0
      ? 'desktop_too_old'
      : null
  }
  // The Accept delivers the skill only when the server could read it: with
  // no skill here the CLI would get none and cannot fetch one later.
  if (
    input.skill &&
    compareSponsoredSkillVersions(version, SPONSORED_CLI_SKILL_DELIVERY_MIN) >=
      0
  ) {
    return null
  }
  return listed?.cli && compareSponsoredSkillVersions(version, listed.cli) >= 0
    ? null
    : 'cli_too_old'
}

/**
 * The conversion part of {@link sponsoredSkillClientRefusal} alone: why this
 * client cannot run a skill (or free-text procedure) that carries a
 * conversion definition, or null when it carries none or the client can.
 * Needs no skill lookup when `procedure` is the rendered text, which always
 * carries the `conversion-definition:` line of a skill that has one.
 */
export function sponsoredConversionClientRefusal(input: {
  client: 'desktop' | 'cli' | 'web' | null
  skill?: { conversion?: unknown } | null
  procedure?: string | null
  conversionToolsVersion?: unknown
}): 'conversion_tools_missing' | 'desktop_too_old' | 'client_version_unknown' | null {
  if (
    input.skill?.conversion == null &&
    !procedureCarriesConversion(input.procedure)
  )
    return null
  if (input.client === 'cli' || input.client === 'web')
    return 'conversion_tools_missing'
  if (input.client !== 'desktop') return 'client_version_unknown'
  const definition =
    input.skill?.conversion ??
    conversionDefinitionFromProcedure(input.procedure)
  if (
    definition &&
    typeof definition === 'object' &&
    'version' in definition &&
    definition.version === 3 &&
    !(
      typeof input.conversionToolsVersion === 'number' &&
      Number.isInteger(input.conversionToolsVersion) &&
      input.conversionToolsVersion >= 2
    )
  )
    return 'desktop_too_old'
  return clientHasSponsoredConversionTools(input.conversionToolsVersion)
    ? null
    : 'desktop_too_old'
}

/** `desktop/<v>` → `<v>` (or `dev`); null when it is not this client's or not a version. */
function clientVersionOf(
  client: 'desktop' | 'cli',
  clientVersion: string | null,
): string | null {
  const prefix = `${client}/`
  if (!clientVersion?.startsWith(prefix)) return null
  const version = clientVersion.slice(prefix.length)
  if (version === 'dev') return version
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : null
}

/**
 * Whether a procedure text carries a conversion definition line, well-formed
 * or not: a malformed one still asks the client for conversion tools.
 */
function procedureCarriesConversion(
  procedure: string | null | undefined,
): boolean {
  return (
    procedure
      ?.replace(/\r\n?/g, '\n')
      .split('\n')
      .some((line) => line.startsWith(CONVERSION_DIRECTIVE)) === true
  )
}

function maxVersion(a: string, b: string | undefined): string {
  return b && compareSponsoredSkillVersions(b, a) > 0 ? b : a
}
