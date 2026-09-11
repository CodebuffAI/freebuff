export const GRAVITY_SHOWCASE_EXPERIMENT_VERSION = 'gravity-showcase-v1'

export type GravityShowcaseExperimentArm = 'treatment' | 'control'

export type GravityShowcaseExperiment = {
  version: string
  configId: string
  arm: GravityShowcaseExperimentArm
  attemptId: string
  opportunityId: string
}

export type GravityShowcaseAssignment = Pick<
  GravityShowcaseExperiment,
  'version' | 'configId' | 'arm'
>

const ASSIGNMENT_SALT = 'gravity_showcase_artwork_2026_09'

function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

export function gravityShowcaseConfig(params: {
  percent: number | undefined
  domains: string | undefined
  endsAt: string | undefined
  nowMs?: number
}): { percent: number; domains: readonly string[]; configId: string } | null {
  if (
    !Number.isInteger(params.percent) ||
    params.percent! <= 0 ||
    params.percent! > 100
  ) {
    return null
  }
  const domains = [
    ...new Set(
      (params.domains ?? '')
        .split(',')
        .map((domain) => domain.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].sort()
  if (domains.length === 0) return null
  if (
    !params.endsAt ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(params.endsAt)
  ) {
    return null
  }
  const endsAtMs = Date.parse(params.endsAt)
  if (!Number.isFinite(endsAtMs) || endsAtMs <= (params.nowMs ?? Date.now())) {
    return null
  }
  const fingerprint = fnv1a(
    `${params.percent}:${domains.join(',')}:${params.endsAt}`,
  ).toString(36)
  return { percent: params.percent!, domains, configId: `gsc_${fingerprint}` }
}

export function gravityShowcaseAssignment(params: {
  userId: string
  percent: number | undefined
  domains: string | undefined
  endsAt: string | undefined
  nowMs?: number
}): GravityShowcaseAssignment | null {
  if (!params.userId) return null
  const config = gravityShowcaseConfig(params)
  if (!config) return null
  const bucket = fnv1a(`${ASSIGNMENT_SALT}:${params.userId}`) % 10_000
  return {
    version: GRAVITY_SHOWCASE_EXPERIMENT_VERSION,
    configId: config.configId,
    arm: bucket < config.percent * 100 ? 'treatment' : 'control',
  }
}
