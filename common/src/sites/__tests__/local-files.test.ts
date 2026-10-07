import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bundleSite } from '../local-files'

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
