import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SitesClient } from '../client'
import { bundleSite, readSiteSecret } from '../local-files'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

// Cloud bundles the same manifest with `sorted(os.listdir())`, and the two
// bundles must match byte for byte. readdir returns the filesystem's order
// (hash order on ext4), so with enough names an unsorted walk shows up here.
test('assets are bundled in name order at every level, whatever readdir returns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-files-'))
  roots.push(root)
  await writeFile(
    join(root, 'worker.js'),
    'export default {fetch:()=>new Response("ok")}',
  )
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      entrypoint: 'index.js',
      compatibilityDate: '2026-10-01',
      modules: [{ name: 'index.js', type: 'esm', path: 'worker.js' }],
      assetsDirectory: 'public',
    }),
  )
  const names = [
    'zeta.txt',
    'index.html',
    'B.css',
    'large.txt',
    'a.js',
    '_x.svg',
  ]
  await mkdir(join(root, 'public/nested'), { recursive: true })
  for (const name of names) {
    await writeFile(join(root, 'public', name), name)
    await writeFile(join(root, 'public/nested', name), name)
  }

  const bundle = await bundleSite(root, 'manifest.json')

  const sorted = [...names].sort()
  const expected = [
    ...sorted.filter((name) => name < 'nested').map((name) => `/${name}`),
    ...sorted.map((name) => `/nested/${name}`),
    ...sorted.filter((name) => name > 'nested').map((name) => `/${name}`),
  ]
  expect(bundle.assets?.map((asset) => asset.path)).toEqual(expected)
})

test('realtime is an explicit true-only managed capability in the deployment manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-realtime-files-'))
  roots.push(root)
  await writeFile(
    join(root, 'worker.js'),
    'export default {fetch:()=>new Response("ok")}',
  )
  const manifest = {
    entrypoint: 'worker.js',
    compatibilityDate: '2026-10-01',
    modules: [{ name: 'worker.js', type: 'esm', path: 'worker.js' }],
  }
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({ ...manifest, realtime: true }),
  )
  expect((await bundleSite(root, 'manifest.json')).realtime).toBe(true)
  for (const realtime of [false, 'true', 1, { class_name: 'Custom' }]) {
    await writeFile(
      join(root, 'manifest.json'),
      JSON.stringify({ ...manifest, realtime }),
    )
    await expect(bundleSite(root, 'manifest.json')).rejects.toThrow(
      'Invalid deploy manifest',
    )
  }
})

test('a relative manifest inside the checkout bundles its modules relative to the manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-files-checkout-'))
  roots.push(root)
  await mkdir(join(root, 'dist'), { recursive: true })
  await writeFile(join(root, 'dist/worker.js'), 'export default {}')
  await writeFile(
    join(root, 'dist/deploy.json'),
    JSON.stringify({
      entrypoint: 'worker.js',
      compatibilityDate: '2026-10-01',
      modules: [{ name: 'worker.js', type: 'esm', path: 'worker.js' }],
    }),
  )
  const bundle = await bundleSite(root, 'dist/deploy.json')
  expect(bundle.modules.map((module) => module.name)).toEqual(['worker.js'])
})

test('a missing manifest, module or secret file names the relative path tried and nothing else', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-files-missing-'))
  roots.push(root)
  await expect(bundleSite(root, 'deploy.json')).rejects.toThrow(
    'Site file not found in this chat’s workspace: deploy.json',
  )
  await mkdir(join(root, 'dist'))
  await writeFile(
    join(root, 'dist/deploy.json'),
    JSON.stringify({
      entrypoint: 'worker.js',
      compatibilityDate: '2026-10-01',
      modules: [{ name: 'worker.js', type: 'esm', path: 'build/worker.js' }],
    }),
  )
  await expect(bundleSite(root, 'dist/deploy.json')).rejects.toThrow(
    'Site file not found in this chat’s workspace: dist/build/worker.js',
  )
  await expect(readSiteSecret(root, 'secrets/token.txt')).rejects.toThrow(
    'Site file not found in this chat’s workspace: secrets/token.txt',
  )
  // A missing path outside the checkout keeps the containment refusal.
  await expect(bundleSite(root, '../elsewhere/deploy.json')).rejects.toThrow(
    'must be inside this thread’s workspace',
  )
  const client = new SitesClient({
    getToken: () => 'token',
    host: 'https://example.invalid',
    originApp: 'desktop',
    fetcher: async () => {
      throw new Error('A missing manifest must not reach hosting')
    },
  })
  expect(
    await client.runToolWithContext(
      'sites_deploy',
      {
        siteId: '00000000-0000-4000-8000-000000000000',
        environment: 'production',
        requestId: '00000000-0000-4000-8000-000000000001',
        manifestPath: 'deploy.json',
      },
      root,
      'build',
    ),
  ).toEqual({
    error: 'invalid_site_request',
    message: 'Site file not found in this chat’s workspace: deploy.json',
  })
})
