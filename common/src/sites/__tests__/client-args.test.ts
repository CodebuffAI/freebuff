import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'

import { SitesClient } from '../client'
import { SITE_ARGS, SITE_RESERVED_BINDINGS, SITE_TOOL_SPECS } from '../tools'

/**
 * Reported 2026-10-14: "All of the `sites_*` tools are broken. Every model says
 * they see 'Could not prepare the Sites request' and can't create Sites."
 *
 * Two halves to that. The published input schemas said `z.string()` where the
 * client enforced a uuid, a binding regex or a length bound, so a model could
 * satisfy the schema and still be refused; and the refusal named nothing, so it
 * could not learn what to change and retried the same call.
 */
const client = new SitesClient({
  getToken: () => undefined,
  host: 'https://example.invalid',
  originApp: 'web',
  fetcher: async () => {
    throw new Error('no request should be attempted for an invalid argument')
  },
})

const run = (tool: string, args: unknown, mode = 'build') =>
  client.runToolWithContext(tool, args, '/workspace', mode) as Promise<{
    error?: string
    message?: string
  }>

test('Next.js preparation runs in the workspace without creating or deploying a site', async () => {
  const calls: unknown[] = []
  const result = {
    manifestPath: 'app/freebuff-sites-build/manifest.json',
    localWranglerConfigPath: 'app/freebuff.wrangler.jsonc',
    logPath: 'app/freebuff-sites-build/build.log',
    runtime: 'opennext' as const,
    nextVersion: '16.4.1',
    adapterVersion: '1.20.12',
  }
  const client = new SitesClient({
    getToken: () => undefined,
    host: 'https://example.invalid',
    originApp: 'desktop',
    fetcher: async () => {
      throw new Error('Preparation must not make hosting requests')
    },
    prepareNext: async (...args) => {
      calls.push(args)
      return result
    },
  })
  const signal = new AbortController().signal
  expect(
    await client.runToolWithContext(
      'sites_prepare_next',
      { projectDirectory: 'app' },
      '/workspace',
      'build',
      signal,
    ),
  ).toEqual(result)
  expect(calls).toEqual([['/workspace', 'app', signal]])
  expect(
    await client.runToolWithContext(
      'sites_prepare_next',
      {},
      '/workspace',
      'plan',
    ),
  ).toMatchObject({ error: 'invalid_site_request' })
  expect(calls).toHaveLength(1)
})

test('realtime preparation runs locally without credentials and Next passes the explicit capability', async () => {
  const calls: unknown[] = []
  const realtimeResult = {
    directory: 'app/freebuff-realtime',
    localWranglerConfigPath: 'app/freebuff-realtime/wrangler.jsonc',
    serverModulePath: 'app/freebuff-realtime/server.js',
    browserModulePath: 'app/freebuff-realtime/browser.js',
    readmePath: 'app/freebuff-realtime/README.md',
    created: [],
    preserved: [],
  }
  const local = new SitesClient({
    getToken: () => undefined,
    host: 'https://example.invalid',
    originApp: 'desktop',
    fetcher: async () => {
      throw new Error('No hosting request is permitted')
    },
    prepareRealtime: async (...args) => {
      calls.push(args)
      return realtimeResult
    },
    prepareNext: async (...args) => {
      calls.push(args)
      return {
        manifestPath: 'manifest.json',
        localWranglerConfigPath: 'wrangler.jsonc',
        logPath: 'build.log',
        runtime: 'opennext',
        nextVersion: '16.4.1',
        adapterVersion: '1.20.12',
      }
    },
  })
  const signal = new AbortController().signal
  expect(
    await local.runToolWithContext(
      'sites_prepare_realtime',
      { projectDirectory: 'app' },
      '/workspace',
      'build',
      signal,
    ),
  ).toEqual(realtimeResult)
  await local.runToolWithContext(
    'sites_prepare_next',
    { realtime: true },
    '/workspace',
    'build',
    signal,
  )
  expect(calls).toEqual([
    ['/workspace', 'app', signal],
    ['/workspace', '.', signal, { realtime: true }],
  ])
  expect(
    await local.runToolWithContext(
      'sites_prepare_realtime',
      {},
      '/workspace',
      'plan',
    ),
  ).toMatchObject({ error: 'invalid_site_request' })
  expect(
    await local.runToolWithContext(
      'sites_prepare_next',
      { realtime: false },
      '/workspace',
      'build',
    ),
  ).toMatchObject({ error: 'invalid_site_request' })
  expect(calls).toHaveLength(2)
})

describe('the published schema is the schema that is enforced', () => {
  // The drift itself: every constraint the client applies must be visible in
  // the JSON Schema the model reads, or a refusal is unexplainable by design.
  test('every spec serialises to JSON Schema with its arguments', () => {
    for (const spec of SITE_TOOL_SPECS) {
      const json = z.toJSONSchema(z.object(spec.shape), { io: 'input' }) as {
        properties?: Record<string, unknown>
      }
      expect(Object.keys(json.properties ?? {})).toEqual(
        Object.keys(spec.shape),
      )
    }
  })

  /**
   * The hosted runtime serializes each spec to JSON Schema, rehydrates it with
   * `zod-from-json-schema` and re-serializes for the provider. A shape that
   * THROWS on the way back is silently replaced by an empty schema, and a model
   * shown a tool with no arguments emits `{}` while the local parse still
   * demands them — every call then dead-ends with exactly the refusal this
   * file is about. Desktop's `harness/tools.test.ts` guards the same thing for
   * the thread tools it folds these into; this keeps the guard next to the
   * specs, so `common` cannot ship a schema that only Desktop's suite rejects.
   */
  test('every spec survives the hosted schema round-trip, keeping its patterns', async () => {
    const { convertJsonSchemaToZod } = await import('zod-from-json-schema')
    for (const spec of SITE_TOOL_SPECS) {
      const original = z.toJSONSchema(z.object(spec.shape), { io: 'input' })
      const roundTripped = z.toJSONSchema(
        convertJsonSchemaToZod(original as never) as never,
        { io: 'input' },
      ) as { properties?: Record<string, { pattern?: string }> }
      expect(Object.keys(roundTripped.properties ?? {})).toEqual(
        Object.keys(spec.shape),
      )
      // `format` and the length bounds do not survive; a pattern does, which is
      // why every constraint a model must satisfy is expressed as one.
      if ('siteId' in spec.shape)
        expect(roundTripped.properties?.siteId.pattern).toContain(
          '[0-9a-fA-F]{8}',
        )
      if (spec.name === 'sites_add_storage' || spec.name === 'sites_set_secret')
        expect(roundTripped.properties?.name.pattern).toBe(
          '^[A-Z][A-Z0-9_]{0,63}$',
        )
    }
  })

  test('siteId publishes the uuid format the client requires', () => {
    const json = z.toJSONSchema(SITE_ARGS.siteId, { io: 'input' }) as {
      format?: string
    }
    expect(json.format).toBe('uuid')
  })

  test('a binding name publishes its pattern, and the reserved list is in its description', () => {
    const json = z.toJSONSchema(SITE_ARGS.bindingName, { io: 'input' }) as {
      pattern?: string
    }
    expect(json.pattern).toBe('^[A-Z][A-Z0-9_]{0,63}$')
    for (const reserved of SITE_RESERVED_BINDINGS) {
      expect(SITE_ARGS.bindingName.description).toContain(reserved)
    }
    // A refinement is dropped by toJSONSchema, so it may never be the only
    // place a model could have learned the rule.
    expect(SITE_ARGS.bindingName.safeParse('ASSETS').success).toBe(false)
    expect(SITE_ARGS.bindingName.safeParse('DB').success).toBe(true)
    expect(SITE_ARGS.bindingName.safeParse('db').success).toBe(false)
  })

  test('a site name publishes its length bounds', () => {
    const json = z.toJSONSchema(SITE_ARGS.siteName, { io: 'input' }) as {
      minLength?: number
      maxLength?: number
    }
    expect(json).toMatchObject({ minLength: 1, maxLength: 80 })
    expect(SITE_ARGS.siteName.safeParse('x'.repeat(81)).success).toBe(false)
  })
})

describe('a rejected argument says which one', () => {
  test('sites_create with a slug for siteId names siteId', async () => {
    const result = await run('sites_create', {
      siteId: 'my-first-site',
      name: 'My Site',
    })
    expect(result.error).toBe('invalid_site_request')
    expect(result.message).toContain('siteId')
    expect(result.message).not.toContain('workspace files')
    // The value the model sent is never echoed back.
    expect(result.message).not.toContain('my-first-site')
  })

  test('sites_add_storage with a lowercase binding names name', async () => {
    const result = await run('sites_add_storage', {
      siteId: '11111111-1111-4111-8111-111111111111',
      environment: 'preview',
      requestId: 'request-0001',
      kind: 'd1',
      name: 'db',
    })
    expect(result.error).toBe('invalid_site_request')
    expect(result.message).toContain('name')
    expect(result.message).not.toContain('workspace files')
  })

  test('an unexpected extra argument is named rather than hidden', async () => {
    const result = await run('sites_create', {
      siteId: '11111111-1111-4111-8111-111111111111',
      name: 'My Site',
      environment: 'production',
    })
    expect(result.error).toBe('invalid_site_request')
    expect(result.message).toContain('environment (unrecognized_keys)')
  })

  test('arguments that are not an object say so instead of a bare check name', async () => {
    const result = await run(
      'sites_deploy',
      JSON.stringify({ siteId: '11111111-1111-4111-8111-111111111111' }),
    )
    expect(result.error).toBe('invalid_site_request')
    expect(result.message).toContain('the arguments object (invalid_type)')
    expect(result.message).not.toContain('11111111')
  })

  test('a Zod failure while preparing files is not blamed on the arguments', async () => {
    // Cloud's bundler parsed a VM refusal as `undefined` (2026-11-08):
    // "Sites rejected these arguments: invalid_type" for valid arguments.
    const requests: string[] = []
    const client = new SitesClient({
      getToken: () => 'token',
      host: 'https://example.invalid',
      originApp: 'web',
      fetcher: async (url) => {
        requests.push(url)
        return Response.json({})
      },
      files: {
        bundle: async () => z.object({}).parse(undefined) as never,
        secret: async () => z.string().max(1).parse('too long'),
      },
    })
    const target = {
      siteId: 'e77a6cb3-0814-431c-83fe-60f8371253e2',
      environment: 'preview',
      requestId: '0f1d3c52-8a4b-4a3e-9d0e-6a8f1f0b7c21',
    }
    const deployed = (await client.runToolWithContext(
      'sites_deploy',
      { ...target, manifestPath: 'deploy/sites-manifest.json' },
      '/workspace',
      'build',
    )) as { error?: string; message?: string }
    expect(deployed.error).toBe('invalid_site_request')
    expect(deployed.message).not.toContain('rejected these arguments')
    expect(deployed.message).toContain('Could not read the site files')
    const secret = (await client.runToolWithContext(
      'sites_set_secret',
      { ...target, name: 'API_KEY', valueFile: '.secret' },
      '/workspace',
      'build',
    )) as { error?: string; message?: string }
    expect(secret.message).toContain('Could not read the secret file')
    expect(secret.message).not.toContain('too long')
    expect(requests).toEqual([])
  })

  test('plan mode and an unknown tool keep their own sentences', async () => {
    const planned = await run(
      'sites_create',
      { siteId: '11111111-1111-4111-8111-111111111111', name: 'My Site' },
      'plan',
    )
    expect(planned.message).toBe(
      'Sites mutations are unavailable in plan mode.',
    )

    const unknown = await run('sites_teleport', {
      siteId: '11111111-1111-4111-8111-111111111111',
      environment: 'preview',
      requestId: 'request-0001',
    })
    expect(unknown.message).toBe('Unknown Sites tool.')
  })
})
