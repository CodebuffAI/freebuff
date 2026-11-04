import { afterEach, describe, expect, test } from 'bun:test'

import {
  deployIdentity,
  deployPlatformFor,
  isProductionDeploy,
  loadDeployIdentity,
  parseEcsTaskMetadata,
  resetDeployIdentityForTests,
} from '../deploy-identity'

// Parity cases with infra/postgres-pooler/deploy_identity_test.py.
const RENDER_ENV = {
  RENDER: 'true',
  RENDER_SERVICE_NAME: 'freebuff-web',
  RENDER_INSTANCE_ID: 'srv-abc-xyz',
  RENDER_GIT_COMMIT: 'deadbeef',
}
const ECS_ENV = {
  ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/c1',
  SERVICE_NAME: 'freebuff-web',
  GIT_SHA: 'cafe',
}
const TASK = {
  TaskARN: 'arn:aws:ecs:us-west-2:1:task/production/0123abcd',
  AvailabilityZone: 'us-west-2b',
}

afterEach(resetDeployIdentityForTests)

describe('deployIdentity', () => {
  test('render', () => {
    expect(deployIdentity(RENDER_ENV)).toEqual({
      platform: 'render',
      service: 'freebuff-web',
      instance: 'srv-abc-xyz',
      commit: 'deadbeef',
      az: null,
    })
  })

  test('aws before and after the task metadata read', async () => {
    expect(deployIdentity(ECS_ENV)).toEqual({
      platform: 'aws',
      service: 'freebuff-web',
      instance: null,
      commit: 'cafe',
      az: null,
    })
    const urls: string[] = []
    const fetchImpl = (async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify(TASK))
    }) as unknown as typeof fetch
    const loaded = await loadDeployIdentity(ECS_ENV, fetchImpl)
    await loadDeployIdentity(ECS_ENV, fetchImpl)
    expect(urls).toEqual(['http://169.254.170.2/v4/c1/task'])
    const expected = {
      platform: 'aws',
      service: 'freebuff-web',
      instance: '0123abcd',
      commit: 'cafe',
      az: 'us-west-2b',
    }
    expect(loaded).toEqual(expected)
    expect(deployIdentity(ECS_ENV)).toEqual(expected)
  })

  test('a failed metadata read keeps the rest', async () => {
    const fetchImpl = (async () => {
      throw new Error('unreachable')
    }) as unknown as typeof fetch
    const identity = await loadDeployIdentity(ECS_ENV, fetchImpl)
    expect(identity.platform).toBe('aws')
    expect(identity.service).toBe('freebuff-web')
    expect(identity.instance).toBeNull()
  })

  test('local', () => {
    expect(deployIdentity({}).platform).toBe('local')
  })

  test('render wins over ecs', () => {
    expect(
      deployPlatformFor({ RENDER_SERVICE_NAME: 'web', ...ECS_ENV }),
    ).toBe('render')
  })

  test('parseEcsTaskMetadata tolerates junk', () => {
    expect(parseEcsTaskMetadata(null)).toEqual({ instance: null, az: null })
    expect(parseEcsTaskMetadata(TASK)).toEqual({
      instance: '0123abcd',
      az: 'us-west-2b',
    })
  })
})

describe('isProductionDeploy', () => {
  const prod = { NEXT_PUBLIC_CB_ENVIRONMENT: 'prod', NODE_ENV: 'production' }

  test('on Render and on ECS', () => {
    expect(isProductionDeploy({ ...prod, RENDER: 'true' })).toBe(true)
    expect(isProductionDeploy({ ...prod, ...ECS_ENV })).toBe(true)
  })

  test('never on a laptop, a preview or a non-prod environment', () => {
    expect(isProductionDeploy(prod)).toBe(false)
    expect(
      isProductionDeploy({ ...prod, RENDER: 'true', IS_PULL_REQUEST: 'true' }),
    ).toBe(false)
    expect(
      isProductionDeploy({ ...prod, ...ECS_ENV, NODE_ENV: 'development' }),
    ).toBe(false)
    expect(
      isProductionDeploy({
        ...ECS_ENV,
        NEXT_PUBLIC_CB_ENVIRONMENT: 'dev',
        NODE_ENV: 'production',
      }),
    ).toBe(false)
  })
})
