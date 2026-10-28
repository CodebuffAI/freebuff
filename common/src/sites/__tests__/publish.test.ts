import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { bundleSite } from '../local-files'
import {
  operationFailureMessage,
  packageInvocation,
  parseSitePreparationOutput,
  prepareSiteLocally,
  publishSite,
  type SitePreparationResult,
} from '../publish'
import {
  readSitePublishStream,
  sitePublishResponse,
  type SitePublishEvent,
} from '../publish-events'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
async function project(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'freebuff-publish-'))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

const SITE = '8d0f7c62-4a5e-4b8a-9c1d-2e3f4a5b6c7d'
const prepared = (
  result: Partial<SitePreparationResult> = {},
): SitePreparationResult => ({
  kind: 'static',
  manifestPath: 'freebuff-sites-build/manifest.json',
  usesAuth: false,
  storage: { d1: [], r2: [] },
  ...result,
})
function fakeSites(
  environment: Record<string, unknown> = {},
  deploy: Record<string, unknown> = {
    operation: { id: 'op', state: 'succeeded', result: { url: 'https://new.freebuff.page' } },
  },
) {
  const calls: [string, Record<string, unknown>][] = []
  let ids = 0
  const details = {
    url: 'https://env.freebuff.page',
    bindings: [],
    auth: null,
    deployed_at: null as string | null,
    ...environment,
  }
  return {
    calls,
    id: () => `id-${++ids}`,
    tool: async (name: string, args: Record<string, unknown>) => {
      calls.push([name, args])
      if (name === 'sites_inspect')
        return {
          environment: { ...details },
          activity: { operations: [] },
        }
      if (name === 'sites_deploy') {
        details.deployed_at = '2026-10-21T00:00:00Z'
        return deploy
      }
      if (name === 'sites_set_published') {
        Object.assign(details, { published: true, unpublished_at: null })
        return { operation: { id: 'publication', state: 'succeeded' } }
      }
      if (name === 'sites_add_storage') return { operation: { id: 's', state: 'succeeded' } }
      if (name === 'sites_prepare_next')
        return { manifestPath: 'freebuff-sites-build/manifest.json' }
      return { ok: true }
    },
  }
}

test('publishing a new project creates its site, then deploys it with no agent', async () => {
  const sites = fakeSites()
  const events: SitePublishEvent[] = []
  const result = await publishSite({
    environment: 'preview',
    siteName: '  My project  ',
    tool: sites.tool,
    prepare: async () => prepared(),
    onEvent: (event) => events.push(event),
    id: sites.id,
  })
  expect(result).toEqual({
    type: 'done',
    siteId: 'id-1',
    environment: 'preview',
    url: 'https://new.freebuff.page',
  })
  expect(sites.calls.map(([name]) => name)).toEqual([
    'sites_create',
    'sites_inspect',
    'sites_deploy',
    'sites_inspect',
  ])
  expect(sites.calls[0]![1]).toEqual({ siteId: 'id-1', name: 'My project' })
  expect(sites.calls[2]![1]).toEqual({
    siteId: 'id-1',
    environment: 'preview',
    requestId: 'id-2',
    manifestPath: 'freebuff-sites-build/manifest.json',
  })
  expect(events.map((event) => (event.type === 'stage' ? event.stage : event.type))).toEqual([
    'building',
    'deploying',
    'done',
  ])
})

test('an existing site gets auth, declared storage and republishing, never a duplicate', async () => {
  const sites = fakeSites({
    unpublished_at: '2026-10-19T00:00:00Z',
    bindings: [{ name: 'DB', kind: 'd1' }],
  })
  const result = await publishSite({
    environment: 'production',
    siteId: SITE,
    tool: sites.tool,
    prepare: async () =>
      prepared({ kind: 'next', manifestPath: undefined, usesAuth: true, storage: { d1: ['DB'], r2: ['FILES'] } }),
    onEvent: () => {},
    id: sites.id,
  })
  expect(result.type).toBe('done')
  expect(sites.calls.map(([name]) => name)).toEqual([
    'sites_prepare_next',
    'sites_inspect',
    'sites_enable_auth',
    'sites_add_storage',
    'sites_deploy',
    'sites_inspect',
    'sites_set_published',
    'sites_inspect',
  ])
  expect(sites.calls[3]![1]).toMatchObject({ kind: 'r2', name: 'FILES', siteId: SITE })
  expect(sites.calls[6]![1]).toMatchObject({ published: true, environment: 'production' })
})

test('a refused tool call or a rejected deployment ends with an explanation', async () => {
  const refused = await publishSite({
    environment: 'preview',
    tool: async () => ({ error: 'sites_request_failed', message: 'Your free hosting allowance includes 6 published sites.' }),
    prepare: async () => prepared(),
    onEvent: () => {},
  })
  expect(refused).toEqual({ type: 'error', message: 'Your free hosting allowance includes 6 published sites.' })

  const rejected = fakeSites({}, {
    operation: {
      id: 'op',
      state: 'failed',
      result: { error: 'cloudflare_rejected', provider: { codes: [10021], stage: 'worker_upload', status: 400 } },
    },
  })
  const result = await publishSite({
    environment: 'preview',
    siteId: SITE,
    tool: rejected.tool,
    prepare: async () => prepared(),
    onEvent: () => {},
  })
  expect(result.type === 'error' && result.message).toContain('failed startup validation')

  const broken = await publishSite({
    environment: 'preview',
    tool: rejected.tool,
    prepare: async () => {
      throw new Error('/home/user/secret-path exploded')
    },
    onEvent: () => {},
    errorMessage: () => undefined,
  })
  expect(broken).toEqual({ type: 'error', message: 'Publishing failed. Try again, or ask the agent to publish.' })
})

test('a deployment still running is polled by its operation id', async () => {
  let polls = 0
  const result = await publishSite({
    environment: 'preview',
    siteId: SITE,
    tool: async (name) => {
      if (name === 'sites_deploy') return { operation: { id: 'op', state: 'running' } }
      if (name === 'sites_inspect')
        return {
          environment: { url: 'https://env.freebuff.page', bindings: [], published: true },
          activity: {
            operations: [
              { id: 'op', state: ++polls > 2 ? 'succeeded' : 'running', result: polls > 2 ? { url: 'https://done.page' } : null },
            ],
          },
        }
      return {}
    },
    prepare: async () => prepared(),
    onEvent: () => {},
    sleep: async () => {},
  })
  expect(result).toMatchObject({ type: 'done', url: 'https://done.page' })
})

test('publishing preserves a newer Unpublish made during the upload', async () => {
  const sites = fakeSites()
  let inspections = 0
  let publications = 0
  const result = await publishSite({
    environment: 'production',
    siteId: SITE,
    tool: async (name, args) => {
      if (name === 'sites_inspect')
        return {
          environment: {
            url: 'https://env.freebuff.page',
            deployed_at: '2026-10-21T00:00:00Z',
            // It was published initially, then unpublished during upload.
            published: ++inspections === 1,
          },
        }
      if (name === 'sites_set_published') {
        publications++
        return { error: 'sites_request_failed', message: 'Your free hosting allowance includes 6 published sites.' }
      }
      return sites.tool(name, args)
    },
    prepare: async () => prepared(),
    onEvent: () => {},
  })
  expect(inspections).toBe(2)
  expect(publications).toBe(0)
  expect(result).toEqual({ type: 'error', message: 'The deployment succeeded, but this environment is unpublished. Check Publication in Manage site.' })
})

test('publishing an unpublished environment reports the publication limit', async () => {
  const sites = fakeSites({ unpublished_at: '2026-10-20T00:00:00Z' })
  const result = await publishSite({
    environment: 'production',
    siteId: SITE,
    tool: async (name, args) => name === 'sites_set_published'
      ? { error: 'sites_request_failed', message: 'Your free hosting allowance includes 6 published sites.' }
      : sites.tool(name, args),
    prepare: async () => prepared(),
    onEvent: () => {},
  })
  expect(result).toEqual({ type: 'error', message: 'Your free hosting allowance includes 6 published sites.' })
})

test('a successful publication receipt cannot announce done if the environment is now unpublished', async () => {
  const sites = fakeSites({ published: false, unpublished_at: '2026-10-20T00:00:00Z' })
  const events: SitePublishEvent[] = []
  const result = await publishSite({
    environment: 'preview',
    siteId: SITE,
    tool: async (name, args) => {
      if (name === 'sites_set_published')
        return { operation: { id: 'publication', state: 'succeeded' } }
      return sites.tool(name, args)
    },
    prepare: async () => prepared(),
    onEvent: (event) => events.push(event),
  })
  expect(result).toEqual({
    type: 'error',
    message: 'The deployment succeeded, but this environment is unpublished. Check Publication in Manage site.',
  })
  expect(events.some((event) => event.type === 'done')).toBe(false)
})

test('failure messages come from receipt codes, never vendor prose', () => {
  expect(operationFailureMessage({ id: 'a', state: 'unknown' })).toContain('did not confirm')
  expect(
    operationFailureMessage({ id: 'a', state: 'failed', result: { provider: { status: 429 } } }),
  ).toContain('rate limiting')
  expect(operationFailureMessage({ id: 'a', state: 'failed', result: {} })).toBe(
    'Cloudflare rejected the deployment.',
  )
})

test('Windows package shims use only fixed words', () => {
  for (const action of ['install', 'build', 'wrangler'] as const) {
    const windows = packageInvocation('pnpm', action, 'win32')
    expect(windows.command).toBe('cmd.exe')
    expect(windows.args[3]).toMatch(/^[A-Za-z0-9@/_. -]+$/)
    expect(packageInvocation('bun', action, 'win32').command).toBe('bun')
  }
  expect(packageInvocation('yarn', 'build', 'linux').args).toEqual(['run', 'build'])
})

test('a static site is prepared from public files only and passes the upload checks', async () => {
  const root = await project({
    'index.html': '<h1>hi</h1>',
    'css/site.css': 'body{}',
    '.env': 'SECRET=1',
    'app.js.map': '{}',
    'freebuff-realtime/worker.js': 'private local-only helper',
  })
  const result = await prepareSiteLocally(root)
  expect(result).toMatchObject({ kind: 'static', manifestPath: 'freebuff-sites-build/manifest.json', usesAuth: false })
  const bundle = await bundleSite(root, result.manifestPath!)
  expect(bundle.entrypoint).toBe('worker.js')
  expect(bundle.assets?.map((asset) => asset.path)).toEqual(['/css/site.css', '/index.html'])
  expect(bundle.spa).toBe(false)
  expect(await readFile(join(root, '.gitignore'), 'utf8')).toContain('/freebuff-sites-build/')
})

test('a Vite app runs its build script and publishes dist as a single-page app', async () => {
  const root = await project({
    'index.html': '<div id="app"></div>',
    'node_modules/.keep': '',
    'package.json': JSON.stringify({
      name: '@me/cool-app',
      devDependencies: { vite: '^6.0.0', '@freebuff/auth': '1.0.0' },
      scripts: {
        build:
          "node -e \"const f=require('fs');f.mkdirSync('dist/.vite',{recursive:true});f.writeFileSync('dist/index.html','built');f.writeFileSync('dist/.vite/manifest.json','{}')\" # vite build",
      },
    }),
  })
  const result = await prepareSiteLocally(root)
  expect(result).toMatchObject({ kind: 'static', usesAuth: true, name: 'cool-app' })
  const bundle = await bundleSite(root, result.manifestPath!)
  expect(bundle.assets?.map((asset) => asset.path)).toEqual(['/index.html'])
  expect(bundle.spa).toBe(true)
})

test('a Wrangler Worker is bundled with its assets and declared storage', async () => {
  const root = await project({
    'package.json': JSON.stringify({ name: 'edge', devDependencies: { wrangler: '4' } }),
    'src/index.ts':
      "import { answer } from './answer'\nexport default { fetch: (_req: Request, env: { ASSETS: { fetch(r: Request): Promise<Response> } }) => Response.json({ answer }) }\n",
    'src/answer.ts': 'export const answer: number = 42\n',
    'public/index.html': '<h1>assets</h1>',
    'wrangler.jsonc': `{
      // A comment the parser must tolerate.
      "name": "edge", "main": "src/index.ts", "compatibility_date": "2026-09-01",
      "compatibility_flags": ["nodejs_compat"],
      "assets": { "directory": "./public", "binding": "ASSETS" },
      "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "00000000-0000-0000-0000-000000000000" }],
    }`,
  })
  // The monorepo's own Wrangler stands in for the project's installed one.
  await symlink(resolve(import.meta.dir, '../../../../node_modules'), join(root, 'node_modules'))
  const result = await prepareSiteLocally(root)
  expect(result).toMatchObject({ kind: 'worker', storage: { d1: ['DB'], r2: [] } })
  const bundle = await bundleSite(root, result.manifestPath!)
  expect(bundle.entrypoint).toBe('index.js')
  expect(bundle.compatibilityFlags).toEqual(['nodejs_compat'])
  expect(bundle.assets?.map((asset) => asset.path)).toEqual(['/index.html'])
}, 60_000)

test('unsupported projects and Worker features are refused with a reason', async () => {
  await expect(
    prepareSiteLocally(await project({ 'package.json': JSON.stringify({ dependencies: { express: '4' } }) })),
  ).rejects.toThrow('could not find a supported website')
  const kv = await project({
    'package.json': JSON.stringify({ devDependencies: { wrangler: '4' } }),
    'src/index.js': 'export default { fetch: () => new Response("x") }\n',
    'wrangler.json': JSON.stringify({
      name: 'kv', main: 'src/index.js', compatibility_date: '2026-09-01',
      kv_namespaces: [{ binding: 'KV', id: 'abc' }],
    }),
  })
  await symlink(resolve(import.meta.dir, '../../../../node_modules'), join(kv, 'node_modules'))
  await expect(prepareSiteLocally(kv)).rejects.toThrow('KV namespaces')
}, 60_000)

test('automatic Worker publishing includes only the managed realtime binding and refuses custom Durable Objects', async () => {
  const binding = {
    name: 'REALTIME',
    class_name: 'FreebuffRealtime',
    script_name: 'freebuff-sites-realtime-local',
  }
  const config = {
    name: 'realtime-app',
    main: 'src/index.js',
    compatibility_date: '2026-10-01',
    durable_objects: { bindings: [binding] },
  }
  const root = await project({
    'package.json': JSON.stringify({
      name: 'realtime-app',
      devDependencies: { wrangler: '4' },
    }),
    'src/index.js': 'export default { fetch: () => new Response("ok") };\n',
    'wrangler.json': JSON.stringify(config),
  })
  await symlink(
    resolve(import.meta.dir, '../../../../node_modules'),
    join(root, 'node_modules'),
  )
  const result = await prepareSiteLocally(root)
  expect((await bundleSite(root, result.manifestPath!)).realtime).toBe(true)
  for (const invalid of [
    { ...binding, script_name: 'someone-elses-worker' },
    { ...binding, class_name: 'Custom' },
    { ...binding, name: 'CUSTOM' },
  ]) {
    await writeFile(
      join(root, 'wrangler.json'),
      JSON.stringify({ ...config, durable_objects: { bindings: [invalid] } }),
    )
    await expect(prepareSiteLocally(root)).rejects.toThrow(
      'custom Durable Objects',
    )
  }
}, 60_000)

test('Next.js is left to sites_prepare_next with its declared storage', async () => {
  const root = await project({
    'package.json': JSON.stringify({ name: 'n', dependencies: { next: '16.4.1' }, scripts: { build: 'next build' } }),
    'wrangler.toml': 'name = "n"\n[[d1_databases]]\nbinding = "DB"\n[[r2_buckets]]\nbinding = "FILES"\n',
  })
  expect(await prepareSiteLocally(root)).toMatchObject({
    kind: 'next',
    storage: { d1: ['DB'], r2: ['FILES'] },
  })
  await expect(readFile(join(root, '.gitignore'))).rejects.toThrow()
})

test('preparation output is validated before it is trusted', () => {
  expect(() =>
    parseSitePreparationOutput(
      'FREEBUFF_SITE_RESULT:' + JSON.stringify({ kind: 'static', usesAuth: false, storage: { d1: ['lower'], r2: [] }, manifestPath: 'm' }),
    ),
  ).toThrow()
})

test('the progress stream round-trips and a stream that ends early is an error', async () => {
  const events: SitePublishEvent[] = []
  const response = sitePublishResponse(async (onEvent) => {
    onEvent({ type: 'stage', stage: 'building' })
    onEvent({ type: 'done', siteId: SITE, environment: 'preview', url: 'https://x.page' })
  }, new AbortController().signal)
  expect(await readSitePublishStream(response, (event) => events.push(event))).toEqual({
    type: 'done', siteId: SITE, environment: 'preview', url: 'https://x.page',
  })
  expect(events[0]).toEqual({ type: 'stage', stage: 'building' })
  const early = sitePublishResponse(async () => {}, new AbortController().signal)
  expect((await readSitePublishStream(early)).type).toBe('error')
  const refused = Response.json({ error: 'This chat is already publishing.' }, { status: 409 })
  expect(await readSitePublishStream(refused)).toEqual({ type: 'error', message: 'This chat is already publishing.' })
})
