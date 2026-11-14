import { describe, expect, test } from 'bun:test'
import {
  detectSiteCompatibility,
  SITE_DETECTION_MAX_BYTES,
  sitesForProject,
} from '../project-context'

const files = (...paths: string[]) =>
  paths.map((path) => ({ path, kind: 'file' }))
const packageJson = (
  dependencies: Record<string, string>,
  build = 'vite build',
) => JSON.stringify({ dependencies, scripts: { build } })

describe('Sites compatibility hints', () => {
  test('recognizes existing Workers and static projects regardless of their author', () => {
    expect(
      detectSiteCompatibility({ files: files('wrangler.toml') }).compatible,
    ).toBe(true)
    expect(
      detectSiteCompatibility({ files: files('index.html') }).compatible,
    ).toBe(true)
    expect(
      detectSiteCompatibility({
        files: files('index.html', 'package.json'),
        packageJson: packageJson({ vite: '^7' }),
      }).compatible,
    ).toBe(true)
    expect(
      detectSiteCompatibility({
        files: files('package.json'),
        packageJson: packageJson(
          { next: '^15', '@opennextjs/cloudflare': '^1' },
          'opennextjs-cloudflare build',
        ),
      }).compatible,
    ).toBe(true)
  })

  test('a web dependency or nested example does not declare this workspace compatible', () => {
    for (const input of [
      {
        files: files('package.json'),
        packageJson: packageJson({ react: '^19' }),
      },
      {
        files: files('index.html'),
        packageJson: packageJson({ next: '^15' }, 'next build'),
      },
      {
        files: files('index.html'),
        packageJson: packageJson({ express: '^5' }),
      },
      { files: files('examples/wrangler.jsonc', 'public/index.html') },
      { files: [{ path: 'wrangler.json', kind: 'directory' }] },
      { files: files('package.json'), packageJson: '{invalid' },
    ])
      expect(detectSiteCompatibility(input).compatible).toBe(false)
  })

  test('offers automatic OpenNext setup only for a root Next application', () => {
    expect(
      detectSiteCompatibility({
        files: files('package.json'),
        packageJson: packageJson({ next: '^16.4.1' }, 'next build'),
      }),
    ).toEqual({
      compatible: true,
      reason: 'Next.js with automatic OpenNext setup',
    })
    expect(
      detectSiteCompatibility({
        files: files('package.json'),
        packageJson: JSON.stringify({
          dependencies: { next: '^16.4.1' },
          scripts: { dev: 'next dev --turbopack' },
        }),
      }).compatible,
    ).toBe(true)
    expect(
      detectSiteCompatibility({
        files: files('package.json'),
        packageJson: packageJson({ next: '^16.4.1' }, 'tsc'),
      }).compatible,
    ).toBe(false)
  })

  test('recognizes a structured deployment manifest and rejects incomplete/oversized metadata', () => {
    const manifest = {
      entrypoint: 'index.js',
      compatibilityDate: '2026-10-01',
      modules: [{ name: 'index.js', type: 'esm', path: './worker.js' }],
    }
    expect(
      detectSiteCompatibility({
        files: [],
        manifestJson: JSON.stringify(manifest),
      }).compatible,
    ).toBe(true)
    for (const manifestJson of [
      JSON.stringify({ ...manifest, entrypoint: 'missing.js' }),
      JSON.stringify({ ...manifest, modules: [] }),
      JSON.stringify({ ...manifest, compatibilityDate: 'invalid' }),
      ' '.repeat(SITE_DETECTION_MAX_BYTES + 1) + JSON.stringify(manifest),
    ])
      expect(
        detectSiteCompatibility({ files: [], manifestJson }).compatible,
      ).toBe(false)
  })
})

test('site association uses exact persisted project attribution and never names or missing ids', () => {
  const sites = [
    { id: 'a', name: 'Same name', analytics: { originProjectId: 'project-a' } },
    { id: 'b', name: 'Same name', analytics: { originProjectId: 'project-b' } },
    { id: 'c', name: 'project-a', analytics: null },
    { id: 'd', name: 'Same name' },
  ]
  expect(sitesForProject(sites, 'project-a').map((site) => site.id)).toEqual([
    'a',
  ])
  expect(sitesForProject(sites, null)).toEqual([])
  expect(sitesForProject(sites, '')).toEqual([])
})
