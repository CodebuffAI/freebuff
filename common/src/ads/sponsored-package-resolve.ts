/**
 * The `install_package` tool's server half (COD-965): before a sponsored run
 * installs a package, its client asks
 * `POST /api/v1/ads/proposal/{id}/packages/resolve` which version to install,
 * or whether to install it at all. The policy is deliberately loose: the
 * skill's declared packages at their pins, and any other package that exists
 * on its registry and is not known malware
 * (`freebuff/web/src/server/ads/sponsored-package-policy.ts`).
 *
 * Shared by the route and every client, so the wire shape lives in one place.
 */

import { z } from 'zod/v4'

import { PYPI_EXACT_VERSION, PYPI_PACKAGE_NAME } from './sponsored-skill'

/**
 * The Accept field a client sends when it has the `install_package` tool. The
 * run spec's prompt then tells the agent to install through it.
 */
export const SPONSORED_INSTALL_TOOL_VERSION = 1 as const

/**
 * Whether an Accept's `installToolVersion` (untrusted, as sent) says the
 * client has the tool: a positive integer. Anything else reads as absent.
 */
export function clientHasSponsoredInstallTool(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

export const SPONSORED_PACKAGE_RESOLVE_PATH = (proposalId: string) =>
  `/api/v1/ads/proposal/${encodeURIComponent(proposalId)}/packages/resolve`

/** npm's package name rule (lowercase, optional scope), at most 214 characters. */
export const SPONSORED_NPM_PACKAGE_NAME =
  /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/** An exact semver, prerelease allowed (`1.2.3`, `2.0.0-beta.1`). */
export const SPONSORED_NPM_EXACT_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/

export const sponsoredPackageResolveBodySchema = z.discriminatedUnion(
  'ecosystem',
  [
    z.object({
      runToken: z.string().min(1).max(4096),
      ecosystem: z.literal('npm'),
      name: z.string().max(214).regex(SPONSORED_NPM_PACKAGE_NAME),
      version: z.string().max(64).regex(SPONSORED_NPM_EXACT_VERSION).optional(),
    }),
    z.object({
      runToken: z.string().min(1).max(4096),
      ecosystem: z.literal('pypi'),
      name: z.string().max(100).regex(PYPI_PACKAGE_NAME),
      version: z.string().max(64).regex(PYPI_EXACT_VERSION).optional(),
    }),
  ],
)

export type SponsoredPackageResolveBody = z.infer<
  typeof sponsoredPackageResolveBodySchema
>

/**
 * The 200. `allowed: true` names the exact version to install; `declared`
 * says the skill pinned the package; `note` is advice for the agent (an npm
 * deprecation, a malware check that could not run). `allowed: false` says
 * why, for the agent to report or work around. A 429 means the run has
 * resolved too many packages.
 */
export type SponsoredPackageResolveResponse =
  | {
      allowed: true
      ecosystem: 'npm' | 'pypi'
      name: string
      version: string
      declared: boolean
      note?: string
    }
  | { allowed: false; reason: string }
