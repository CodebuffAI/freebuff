/**
 * Where this process runs, without reading a platform's own variables at the
 * call site (COD-1298, O1 of the Render → AWS observability plan).
 *
 * Render injects RENDER, RENDER_SERVICE_NAME, RENDER_INSTANCE_ID and
 * RENDER_GIT_COMMIT. ECS injects ECS_CONTAINER_METADATA_URI_V4 into every
 * container; the task's id and availability zone come from that endpoint, and
 * the task definition carries SERVICE_NAME (the logical Render name, e.g.
 * `freebuff-web`, so dashboards and gates keep one key across platforms) and
 * GIT_SHA.
 *
 * Never shim RENDER=true on ECS to reuse old gates: isRunningOnRender()
 * (packages/internal/src/db/database-url.ts) would then rewrite database URLs
 * to Render hosts that do not resolve inside AWS.
 *
 * The Python twin is infra/postgres-pooler/deploy_identity.py; the parity cases
 * live in both test files.
 */

export type DeployPlatform = 'render' | 'aws' | 'local'

export type DeployIdentity = {
  platform: DeployPlatform
  /** Logical (Render) service name, the same on both platforms. */
  service: string | null
  /** Render instance id, or the ECS task id. */
  instance: string | null
  commit: string | null
  /** Availability zone (ECS only; Render does not expose one). */
  az: string | null
}

type Env = Readonly<Record<string, string | undefined>>

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function processEnv(): Env {
  return typeof process === 'undefined' ? {} : process.env
}

/** Render first: a Render process never has the ECS metadata variable. */
export function deployPlatformFor(env: Env): DeployPlatform {
  if (env.RENDER === 'true' || clean(env.RENDER_SERVICE_NAME)) return 'render'
  if (clean(env.ECS_CONTAINER_METADATA_URI_V4)) return 'aws'
  return 'local'
}

/** Filled once by loadDeployIdentity() from the ECS task metadata endpoint. */
let ecsTaskMetadata: { instance: string | null; az: string | null } | null =
  null

export function deployIdentity(env: Env = processEnv()): DeployIdentity {
  // Each field reads the Render variable first and the ECS one second, so a
  // process that has a RENDER_* value keeps exactly what it reported before.
  return {
    platform: deployPlatformFor(env),
    service: clean(env.RENDER_SERVICE_NAME) ?? clean(env.SERVICE_NAME),
    instance: clean(env.RENDER_INSTANCE_ID) ?? ecsTaskMetadata?.instance ?? null,
    commit: clean(env.RENDER_GIT_COMMIT) ?? clean(env.GIT_SHA),
    az: ecsTaskMetadata?.az ?? null,
  }
}

/** The task id is the last path segment of the task ARN. */
export function ecsTaskIdFromArn(taskArn: unknown): string | null {
  if (typeof taskArn !== 'string') return null
  const id = taskArn.split('/').pop()
  return id ? id : null
}

export function parseEcsTaskMetadata(body: unknown): {
  instance: string | null
  az: string | null
} {
  const task = (body ?? {}) as { TaskARN?: unknown; AvailabilityZone?: unknown }
  return {
    instance: ecsTaskIdFromArn(task.TaskARN),
    az:
      typeof task.AvailabilityZone === 'string' && task.AvailabilityZone
        ? task.AvailabilityZone
        : null,
  }
}

let loading: Promise<DeployIdentity> | null = null

/**
 * Reads the ECS task metadata once (instance and AZ), then returns the full
 * identity. Off ECS it resolves at once. Never throws: a failed read leaves
 * instance and az null, and deployIdentity() keeps working.
 */
export function loadDeployIdentity(
  env: Env = processEnv(),
  fetchImpl: typeof fetch = fetch,
): Promise<DeployIdentity> {
  if (deployPlatformFor(env) !== 'aws' || ecsTaskMetadata) {
    return Promise.resolve(deployIdentity(env))
  }
  loading ??= (async () => {
    try {
      const response = await fetchImpl(
        `${clean(env.ECS_CONTAINER_METADATA_URI_V4)}/task`,
        { signal: AbortSignal.timeout(2_000) },
      )
      if (response.ok) ecsTaskMetadata = parseEcsTaskMetadata(await response.json())
    } catch {
      // Identity without instance/az is still correct; logs carry the rest.
    } finally {
      loading = null
    }
    return deployIdentity(env)
  })()
  return loading
}

/**
 * A production deploy of the prod environment on Render or AWS, not a PR
 * preview, a test or a laptop. The ad-model scorers and loaders are gated on
 * this (they used to read RENDER === 'true', which ECS never sets).
 */
export function isProductionDeploy(env: Env = processEnv()): boolean {
  return (
    env.NEXT_PUBLIC_CB_ENVIRONMENT === 'prod' &&
    env.NODE_ENV === 'production' &&
    deployPlatformFor(env) !== 'local' &&
    env.IS_PULL_REQUEST !== 'true'
  )
}

/** For tests only. */
export function resetDeployIdentityForTests(): void {
  ecsTaskMetadata = null
  loading = null
}
