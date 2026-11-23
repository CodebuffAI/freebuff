import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'

import { SitesClient } from '../client'

const siteId = '11111111-1111-4111-8111-111111111111'

test('Sites tools return current publication independently of saved deployment metadata', async () => {
  let published = true
  const client = new SitesClient({
    getToken: randomUUID,
    host: 'https://example.invalid',
    originApp: 'desktop',
    fetcher: async (url) => {
      const environment = {
        name: 'production',
        url: 'https://example.freebuff.page',
        deployed_at: '2026-10-20T00:00:00Z',
        unpublished_at: published ? null : '2026-10-21T00:00:00Z',
        published,
      }
      return Response.json(
        url.endsWith('/operations')
          ? { operations: [] }
          : url.endsWith('/production')
            ? environment
            : { sites: [{ id: siteId, environments: [environment] }] },
      )
    },
  })
  const run = (tool: string, args: unknown) =>
    client.runToolWithContext(tool, args, '/workspace', 'plan')
  expect(await run('sites_list', {})).toMatchObject({
    sites: [{ environments: [{ published: true }] }],
  })
  published = false
  expect(await run('sites_list', {})).toMatchObject({
    sites: [
      {
        environments: [
          { published: false, deployed_at: '2026-10-20T00:00:00Z' },
        ],
      },
    ],
  })
  expect(
    await run('sites_inspect', { siteId, environment: 'production' }),
  ).toMatchObject({
    environment: { published: false, url: 'https://example.freebuff.page' },
  })
})

test('publication and saved-project limits have distinct recovery instructions', async () => {
  for (const [error, message] of [
    [
      'published_site_limit',
      'Unpublish every published environment of one site to publish another.',
    ],
    [
      'project_limit',
      'Your saved Sites limit has been reached. Delete an unused site to create another.',
    ],
  ]) {
    const client = new SitesClient({
      getToken: randomUUID,
      host: 'https://example.invalid',
      originApp: 'desktop',
      fetcher: async () => Response.json({ error }, { status: 429 }),
    })
    const result = (await client.runToolWithContext(
      'sites_set_published',
      {
        siteId,
        environment: 'production',
        published: true,
        requestId: 'request-0001',
      },
      '/workspace',
      'build',
    )) as { error: string; message: string }
    expect(result.error).toBe('sites_request_failed')
    expect(result.message).toContain(message!)
  }
})

// MamieNana (2026-11-12): the deploy tool said only that "an earlier one never
// reported its result", which nothing the owner could do would change. The
// server's refusal now says which operation holds the environment and when to
// try again, so the tool passes it through.
test('a busy environment relays the server’s refusal, which says what to do', async () => {
  const refusal = (body: Record<string, unknown>) =>
    new SitesClient({
      getToken: randomUUID,
      host: 'https://example.invalid',
      originApp: 'desktop',
      fetcher: async () => Response.json(body, { status: 409 }),
    }).runToolWithContext(
      'sites_set_published',
      {
        siteId,
        environment: 'production',
        published: true,
        requestId: 'request-0001',
      },
      '/workspace',
      'build',
    ) as Promise<{ error: string; message: string }>
  const message =
    'An earlier deployment ended without Cloudflare confirming it. Freebuff checks it with Cloudflare 10 minutes after it ended, so try again in 4 minutes.'
  expect(
    await refusal({ error: 'environment_busy', message }),
  ).toMatchObject({ error: 'sites_request_failed', message })
  // An older backend without a message still gets advice.
  expect(
    (await refusal({ error: 'environment_busy' })).message,
  ).toContain('Try again in 10 minutes')
})
