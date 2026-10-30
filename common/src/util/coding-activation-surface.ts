/** Where a first coding prompt ran, as the acquisition trackers (Meta, Google
 * Ads, Reddit) record and report it. 'android' and 'ios' are the phone apps,
 * whose runs execute in the cloud workspace like the browser's. */
export const CODING_ACTIVATION_SURFACES = [
  'web',
  'desktop',
  'cli',
  'android',
  'ios',
] as const

export type CodingActivationSurface =
  (typeof CODING_ACTIVATION_SURFACES)[number]

export function isCodingActivationSurface(
  value: unknown,
): value is CodingActivationSurface {
  return (CODING_ACTIVATION_SURFACES as readonly unknown[]).includes(value)
}
