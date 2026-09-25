/** Local development only. Never accepts authority from an HTTP request. */
type Environment = Readonly<Record<string, string | undefined>>

export function isLoopbackUrl(value: string | undefined): boolean {
  try {
    const url = new URL(value ?? '')
    return (
      [
        'http:',
        'https:',
        'postgres:',
        'postgresql:',
        'redis:',
        'rediss:',
      ].includes(url.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      !url.search &&
      !url.hash
    )
  } catch {
    return false
  }
}

export function localAgenticTestCampaign(env: Environment): string | null {
  if (env.TEST_AGENTIC_ADS !== 'true') return null
  if (env.NODE_ENV === 'production' || env.NEXT_PUBLIC_CB_ENVIRONMENT !== 'dev')
    throw new Error('TEST_AGENTIC_ADS requires a development runtime')
  const id = env.TEST_AGENTIC_ADS_CAMPAIGN
  if (
    !id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  )
    throw new Error('TEST_AGENTIC_ADS_CAMPAIGN must be a local campaign UUID')
  for (const name of [
    'NEXT_PUBLIC_CODEBUFF_APP_URL',
    'NEXT_PUBLIC_FREEBUFF_APP_URL',
  ]) {
    if (!isLoopbackUrl(env[name]))
      throw new Error(`TEST_AGENTIC_ADS requires loopback ${name}`)
  }
  return id
}

/** Recheck the actual backend environment, after Next's dotenv loading. */
export function localAgenticBackendCampaign(env: Environment): string | null {
  const id = localAgenticTestCampaign(env)
  if (!id) return null
  for (const name of [
    'DATABASE_URL',
    'DIRECT_DATABASE_URL',
    'NEXT_PUBLIC_CONVEX_URL',
    'REDIS_URL',
  ]) {
    if (!isLoopbackUrl(env[name]))
      throw new Error(`TEST_AGENTIC_ADS requires loopback ${name}`)
  }
  for (const name of ['DATABASE_URL', 'DIRECT_DATABASE_URL']) {
    if (new URL(env[name]!).pathname !== '/freebuff_agentic_test')
      throw new Error(
        'TEST_AGENTIC_ADS requires the dedicated freebuff_agentic_test database',
      )
  }
  if (
    env.CONVEX_DEPLOY_KEY?.startsWith('prod:') ||
    env.CONVEX_ADMIN_KEY?.startsWith('prod:')
  )
    throw new Error('TEST_AGENTIC_ADS refuses production Convex credentials')
  return id
}
