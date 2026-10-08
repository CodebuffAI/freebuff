/**
 * Deterministic user bucketing for experiments recorded in Postgres
 * (`experiment` / `experiment_assignment`, docs/experiments.md).
 *
 * The bucket only decides the arm a user gets on FIRST assignment; after that
 * the persisted row is the truth and this is never consulted again for them.
 * So a weight edit mid-experiment moves no one who is already assigned.
 *
 * FNV-1a then the lowbias32 finalizer, as in `glideHash`
 * (`constants/freebuff-ads.ts`). The finalizer matters: user ids share long
 * prefixes and raw FNV-1a leaves the changing tail in the low bits, which is
 * exactly what `% 10000` reads. Existing callers of the older hashes are left
 * untouched on purpose — changing them would reassign live experiments.
 */

export const EXPERIMENT_BUCKETS = 10_000

export type ExperimentArmWeight = {
  readonly name: string
  /** Basis points; the arms of one experiment sum to 10,000. */
  readonly bps: number
}

/** FNV-1a 32-bit with a lowbias32 avalanche finalizer. */
export function stableHash32(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x7feb352d) >>> 0
  hash ^= hash >>> 15
  hash = Math.imul(hash, 0x846ca68b) >>> 0
  hash ^= hash >>> 16
  return hash >>> 0
}

/** The user's bucket in [0, 10000) for an experiment's salt. */
export function experimentBucket(salt: string, userId: string): number {
  return stableHash32(`${salt}:${userId}`) % EXPERIMENT_BUCKETS
}

/**
 * Basis-point walk: the first arm whose cumulative weight exceeds `bucket`.
 * Arm ORDER is part of the definition — reordering arms reassigns buckets.
 * Weights that sum under 10,000 leave the remainder to the LAST arm rather
 * than to nobody; `validateArmWeights` rejects such a definition anyway.
 */
export function armForBucket(
  arms: readonly ExperimentArmWeight[],
  bucket: number,
): string {
  if (arms.length === 0) throw new Error('experiment has no arms')
  let ceiling = 0
  for (const arm of arms) {
    ceiling += arm.bps
    if (bucket < ceiling) return arm.name
  }
  return arms[arms.length - 1].name
}

/** Why an arm list is not a valid experiment definition, or null if it is. */
export function validateArmWeights(
  arms: readonly ExperimentArmWeight[],
): string | null {
  if (arms.length < 2) return 'an experiment needs at least two arms'
  const names = new Set<string>()
  let total = 0
  for (const arm of arms) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(arm.name)) {
      return `arm name "${arm.name}" must be snake_case, at most 40 chars`
    }
    if (names.has(arm.name)) return `duplicate arm "${arm.name}"`
    names.add(arm.name)
    if (!Number.isInteger(arm.bps) || arm.bps < 0) {
      return `arm "${arm.name}" weight must be a non-negative integer`
    }
    total += arm.bps
  }
  if (!names.has('control')) return 'an experiment needs a `control` arm'
  if (total !== EXPERIMENT_BUCKETS) {
    return `arm weights sum to ${total}, not ${EXPERIMENT_BUCKETS}`
  }
  return null
}
