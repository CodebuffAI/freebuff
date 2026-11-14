import { createHash } from 'node:crypto'

import { z } from 'zod/v4'

/**
 * `latest.json` in an environment's Desktop bundle bucket (infra/aws-storage cdn.tf): what the
 * bundle publish workflow writes and the feed route (web/src/app/api/desktop/orchestrator-bundles)
 * reads through CloudFront. docs/desktop/hot-bundles.md describes the whole flow.
 *
 * The feed only routes: it never verifies `manifest` or `signature`. Desktop does, against the keys
 * it ships with, so a wrong file here can at worst offer a bundle every client refuses.
 */

/** Same shape as orchestrator-bundle.cjs VERSION_PATTERN, so the feed never offers a version a client rejects. */
export const DESKTOP_BUNDLE_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/

const version = z.string().regex(DESKTOP_BUNDLE_VERSION_PATTERN)

export const desktopBundleFeedSchema = z.object({
  format: z.literal(1),
  /** The bundle on offer, or null to offer nothing (the revoked list still reaches clients). */
  current: z
    .object({
      version,
      /** ORCHESTRATOR_SHELL_ABI it was built for: only a shell asking with the same value is offered it. */
      shellAbi: z.number().int().nonnegative(),
      /** 0-100. Installs are bucketed by `desktopBundleRolloutBucket`, so a ramp only adds installs. */
      rolloutPercent: z.number().min(0).max(100),
      /** Installs offered it whatever the percentage: internal machines first, the staging test. */
      installIds: z.array(z.string().min(1).max(128)).max(200).default([]),
      /** manifest.json, base64: the exact bytes the signature covers. */
      manifest: z.string().min(1),
      /** manifest.sig, base64. */
      signature: z.string().min(1),
    })
    .nullable(),
  /** Versions every client drops and never installs again, offered or not (the kill switch). */
  revoked: z.array(version).max(500).default([]),
})

export type DesktopBundleFeed = z.infer<typeof desktopBundleFeedSchema>

/**
 * An install's place in [0, 100) for one version. Salted with the version, so each bundle's first
 * 1% is a different 1%, and fixed for that version, so raising the percentage only ever adds
 * installs: one inside at 10% is still inside at 20%.
 */
export function desktopBundleRolloutBucket(installId: string, bundleVersion: string): number {
  const digest = createHash('sha256').update(`${bundleVersion}\n${installId}`).digest()
  return (digest.readUInt32BE(0) / 0x1_0000_0000) * 100
}

/** The S3 key, under the bucket or its CloudFront origin, of a version's files. */
export function desktopBundleFilesPrefix(bundleVersion: string): string {
  return `bundles/${bundleVersion}/`
}

export const DESKTOP_BUNDLE_FEED_KEY = 'latest.json'
