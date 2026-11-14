import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bundleSite } from '../local-files'
import { withNodeStdinProbe } from './node-transport-fixture'
import {
  NEXT_ADAPTER_VERSION,
  NEXT_WRANGLER_VERSION,
  nextInstallInvocation,
  nextPreparationEnvironment,
  prepareNextSite,
} from '../next-prepare'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

test('Windows package shims use only fixed install words while native builds remain direct', () => {
  for (const manager of ['npm', 'pnpm', 'yarn']) {
    const windows = nextInstallInvocation(manager, 'win32')
    const posix = nextInstallInvocation(manager, 'linux')
    expect(windows.command).toBe('cmd.exe')
    expect(windows.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(windows.args[3]).toBe(`${manager}.cmd ${posix.args.join(' ')}`)
    expect(windows.args[3]).toMatch(/^[A-Za-z0-9@/_. -]+$/)
    expect(windows.windowsVerbatimArguments).toBe(true)
    expect(posix.command).toBe(manager)
    expect(posix.windowsVerbatimArguments).toBe(false)
    expect(posix.args.slice(-2)).toEqual([
      `@opennextjs/cloudflare@${NEXT_ADAPTER_VERSION}`,
      `wrangler@${NEXT_WRANGLER_VERSION}`,
    ])
  }
  expect(nextInstallInvocation('bun', 'win32')).toEqual(
    nextInstallInvocation('bun', 'linux'),
  )
  expect(() => nextInstallInvocation('npm & whoami', 'win32')).toThrow(
    'Unsupported package manager',
  )
  expect(() => nextInstallInvocation('C:\\tools\\npm.cmd', 'win32')).toThrow(
    'Unsupported package manager',
  )
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'next-prepare-'))
  roots.push(root)
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'app',
      dependencies: { next: '16.4.1' },
      scripts: { build: 'next build' },
    }),
  )
  await writeFile(
    join(root, 'next.config.ts'),
    'export default { trailingSlash: true }\n',
  )
  await writeFile(join(root, 'wrangler.toml'), 'name = "existing-deployment"\n')
  for (const [name, version] of [
    ['next', '16.4.1'],
    ['@opennextjs/cloudflare', NEXT_ADAPTER_VERSION],
    ['wrangler', NEXT_WRANGLER_VERSION],
  ]) {
    const directory = join(root, 'node_modules', name)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name,
        version,
        type: 'module',
        exports: { '.': './index.js' },
      }),
    )
    await writeFile(join(directory, 'index.js'), '')
  }
  await writeFile(
    join(root, 'node_modules/wrangler/index.js'),
    'export function unstable_readConfig(){return {vars:{APP_ORIGIN:"http://localhost:8787"},d1_databases:[{binding:"NOTES",database_id:"must-not-copy"}],r2_buckets:[{binding:"UPLOADS",bucket_name:"must-not-copy",remote:true}]}}',
  )
  const adapter = join(root, 'node_modules/@opennextjs/cloudflare/dist/cli')
  await mkdir(adapter, { recursive: true })
  await writeFile(
    join(adapter, 'index.js'),
    `
    import {mkdir,writeFile} from 'node:fs/promises';
    if(process.argv.includes('populateCache')) process.exit(0);
    for(const path of ['.next','.open-next/assets/_next/static','.open-next/cache/build-123','.open-next/cache/__fetch/build-123']) await mkdir(path,{recursive:true});
    await writeFile('.next/BUILD_ID','build-123');
    await writeFile('.next/prerender-manifest.json',JSON.stringify({preview:{previewModeId:'a'.repeat(32)}}));
    await writeFile('.open-next/worker.js','export default {fetch:()=>new Response("Next")}; export class DOQueueHandler{}; export class DOShardedTagCache{};');
    await writeFile('.open-next/assets/_next/static/app.js','console.log("public")');
    await writeFile('.open-next/assets/_next/static/app.js.map','private source map');
    await writeFile('.open-next/cache/build-123/index.cache','{"html":"private prerender"}');
    await writeFile('.open-next/cache/__fetch/build-123/fetch-key','{"data":"private fetch cache"}');
    console.log('build log stays local');
  `,
  )
  const wrangler = join(root, 'node_modules/wrangler/bin')
  await mkdir(wrangler, { recursive: true })
  await writeFile(
    join(wrangler, 'wrangler.js'),
    `
    import {mkdir,copyFile,readFile} from 'node:fs/promises';
    if(!process.argv.includes('--dry-run')) process.exit(9);
    const out=process.argv[process.argv.indexOf('--outdir')+1];
    await mkdir(out,{recursive:true});
    const config=JSON.parse(await readFile(process.argv[process.argv.indexOf('--config')+1],'utf8'));
    await copyFile(config.main,out+'/deploy-entry.js');
  `,
  )
  return root
}

test.skipIf(process.platform === 'win32')(
  'large Next preparation programs execute through stdin instead of the Windows-limited command line',
  async () => {
    const root = await fixture()
    const { result, records } = await withNodeStdinProbe(root, () =>
      prepareNextSite(root, '.', undefined, { realtime: true }),
    )
    expect(records).toHaveLength(1)
    expect(records[0].bytes).toBeGreaterThan(32767)
    expect(records[0].args).toEqual(['--input-type=module', '-'])
    expect((await bundleSite(root, result.manifestPath)).realtime).toBe(true)
  },
)

test('prepares the same private cache and public artifact contract without replacing user configs', async () => {
  const root = await fixture()
  const result = await prepareNextSite(root)
  expect(result.runtime).toBe('opennext')
  expect(await readFile(join(root, 'next.config.ts'), 'utf8')).toBe(
    'export default { trailingSlash: true }\n',
  )
  expect(await readFile(join(root, 'wrangler.toml'), 'utf8')).toBe(
    'name = "existing-deployment"\n',
  )
  expect(await readFile(join(root, result.logPath), 'utf8')).toContain(
    'build log stays local',
  )
  const bundle = await bundleSite(root, result.manifestPath)
  expect(bundle.runtime).toBe('opennext')
  expect(bundle.compatibilityFlags).toContain('disable_ctx_exports')
  expect(bundle.compatibilityFlags).not.toContain('enable_ctx_exports')
  expect(bundle.assets?.map((asset) => asset.path)).toEqual([
    '/_headers',
    '/_next/static/app.js',
  ])
  const hashed = (route: string) =>
    createHash('sha256').update(route).digest('hex')
  expect(bundle.cache?.map((entry) => entry.key).sort()).toEqual(
    [
      `incremental-cache/build-123/${hashed('/fetch-key')}.fetch`,
      `incremental-cache/build-123/${hashed('/index')}.cache`,
    ].sort(),
  )
  expect(
    bundle.assets?.some((asset) =>
      Buffer.from(asset.contentBase64, 'base64').toString().includes('private'),
    ),
  ).toBe(false)
  const local = await readFile(
    join(root, result.localWranglerConfigPath),
    'utf8',
  )
  expect(local).toContain('NEXT_CACHE_DO_QUEUE')
  expect(local).toContain('NEXT_TAG_CACHE_DO_SHARDED')
  expect(local).toContain('enable_ctx_exports')
  expect(local).toContain('NOTES')
  expect(local).toContain('UPLOADS')
  expect(local).toContain('http://localhost:8787')
  expect(local).not.toContain('must-not-copy')
  expect(local).not.toContain('"remote"')
  await prepareNextSite(root)
  expect(
    (await readFile(join(root, '.gitignore'), 'utf8')).split(
      '/freebuff-sites-build/',
    ),
  ).toHaveLength(2)
})

test('refuses to overwrite an existing deployment config or unrelated output directory', async () => {
  const root = await fixture()
  await writeFile(
    join(root, 'freebuff.open-next.config.ts'),
    'export default {custom: true}',
  )
  await expect(prepareNextSite(root)).rejects.toThrow(
    'already exists and is not generated',
  )
  expect(
    await readFile(join(root, 'freebuff.open-next.config.ts'), 'utf8'),
  ).toBe('export default {custom: true}')
  const second = await fixture()
  await mkdir(join(second, 'freebuff-sites-build'))
  await writeFile(join(second, 'freebuff-sites-build/notes.txt'), 'user notes')
  await expect(prepareNextSite(second)).rejects.toThrow(
    'not created by Freebuff',
  )
  expect(
    await readFile(join(second, 'freebuff-sites-build/notes.txt'), 'utf8'),
  ).toBe('user notes')
})

test('Next realtime generates a local helper and retains the capability on rebuild without shipping helper code', async () => {
  const root = await fixture()
  // This fixture reads the generated local config on rebuild, like Wrangler.
  await writeFile(
    join(root, 'node_modules/wrangler/index.js'),
    `
    import {readFile} from 'node:fs/promises';
    export async function unstable_readConfig({config}) {
      if (!config.endsWith('.jsonc')) return {};
      return JSON.parse((await readFile(config,'utf8')).split('\\n').slice(1).join('\\n'));
    }
  `,
  )
  const first = await prepareNextSite(root, '.', undefined, { realtime: true })
  expect(first.realtimeWranglerConfigPath).toBe(
    'freebuff-realtime/wrangler.jsonc',
  )
  const local = JSON.parse(
    (await readFile(join(root, first.localWranglerConfigPath), 'utf8'))
      .split('\n')
      .slice(1)
      .join('\n'),
  )
  expect(local.durable_objects.bindings).toContainEqual({
    name: 'REALTIME',
    class_name: 'FreebuffRealtime',
    script_name: 'freebuff-sites-realtime-local',
  })
  expect((await bundleSite(root, first.manifestPath)).realtime).toBe(true)
  await writeFile(join(root, 'freebuff-realtime/browser.js'), '// customized\n')
  const next = await prepareNextSite(root)
  const bundle = await bundleSite(root, next.manifestPath)
  expect(bundle.realtime).toBe(true)
  expect(
    bundle.modules.every((module) => !module.name.includes('realtime')),
  ).toBe(true)
  expect(
    await readFile(join(root, 'freebuff-realtime/browser.js'), 'utf8'),
  ).toBe('// customized\n')
})

test('hosted entry preserves asset routing and reuses a private runtime env without exporting tenant durable objects', async () => {
  const root = await fixture()
  await prepareNextSite(root)
  await writeFile(
    join(root, '.open-next/worker.js'),
    'export default {fetch(request,env){return env.RESULT(env)}}; export class DOQueueHandler{}; export class DOShardedTagCache{};',
  )
  const hosted = await import(
    pathToFileURL(join(root, 'freebuff-sites-build/deploy-entry.js')).href
  )
  const local = await import(
    pathToFileURL(join(root, 'freebuff-sites-build/entry.js')).href
  )
  expect(Object.keys(hosted)).toEqual(['default'])
  expect(local.DOQueueHandler).toBeDefined()
  const observed: Record<string, unknown>[] = []
  const messages: unknown[] = []
  const queue = {
    idFromName: (name: string) => name,
    get: () => ({ revalidate: (message: unknown) => messages.push(message) }),
  }
  const environment = {
    NEXT_CACHE_DO_QUEUE: queue,
    ASSETS: {
      fetch: async (request: Request) =>
        new Response(null, {
          status: new URL(request.url).pathname === '/old' ? 302 : 404,
          headers:
            new URL(request.url).pathname === '/old' ? { Location: '/' } : {},
        }),
    },
    RESULT: (value: Record<string, unknown>) => {
      observed.push(value)
      return new Response('Next')
    },
  }
  const ctx = { exports: { default: { fetch() {} } } }
  expect(
    (
      await hosted.default.fetch(
        new Request('https://site.test/old'),
        environment,
        ctx,
      )
    ).status,
  ).toBe(302)
  expect(observed).toHaveLength(0)
  for (let index = 0; index < 2; index++) {
    expect(
      await (
        await hosted.default.fetch(
          new Request('https://site.test/app'),
          environment,
          ctx,
        )
      ).text(),
    ).toBe('Next')
  }
  expect(observed[0]).toBe(observed[1])
  expect(environment.NEXT_CACHE_DO_QUEUE).toBe(queue)
  expect('WORKER_SELF_REFERENCE' in environment).toBe(false)
  const runtime = observed[0] as typeof environment
  expect('WORKER_SELF_REFERENCE' in runtime).toBe(false)
  runtime.NEXT_CACHE_DO_QUEUE.get().revalidate({
    MessageDeduplicationId: 'test',
  })
  expect(messages).toEqual([
    {
      MessageDeduplicationId: 'test',
      freebuffNext: { buildId: 'build-123', previewModeId: 'a'.repeat(32) },
    },
  ])
  await local.default.fetch(
    new Request('https://site.test/app'),
    environment,
    ctx,
  )
  expect(observed.at(-1)?.WORKER_SELF_REFERENCE).toBe(ctx.exports.default)
})

test('rejects projects outside the workspace and leaves credentials out of build processes', async () => {
  const root = await fixture()
  await expect(prepareNextSite(root, '..')).rejects.toThrow(
    'inside this workspace',
  )
  expect(
    nextPreparationEnvironment({
      PATH: '/bin',
      HOME: '/home/app',
      FREEBUFF_API_KEY: 'secret',
      CLOUDFLARE_API_TOKEN: 'secret',
      DATABASE_URL: 'secret',
      NODE_OPTIONS: '--import=bad',
    }),
  ).toEqual({
    PATH: '/bin',
    HOME: '/home/app',
    CI: '1',
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    WRANGLER_SEND_METRICS: 'false',
  })
})

test('unsupported installed Next versions produce an upgrade error before installing or building', async () => {
  const root = await fixture()
  await writeFile(
    join(root, 'node_modules/next/package.json'),
    JSON.stringify({ name: 'next', version: '14.2.0', main: 'index.js' }),
  )
  await expect(prepareNextSite(root)).rejects.toThrow('Update Next.js')
  expect(
    (
      JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
        dependencies: { next: string }
      }
    ).dependencies.next,
  ).toBe('16.4.1')
})

test('cache files stay private even if a manifest attempts to use the private cache without the adapter runtime', async () => {
  const root = await fixture()
  const result = await prepareNextSite(root)
  const path = join(root, result.manifestPath)
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  delete manifest.runtime
  await writeFile(path, JSON.stringify(manifest))
  await expect(bundleSite(root, result.manifestPath)).rejects.toThrow(
    'Invalid deploy manifest',
  )
})
