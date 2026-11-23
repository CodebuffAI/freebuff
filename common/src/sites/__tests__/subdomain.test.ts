import { expect, test } from 'bun:test'

import {
  generatedSiteSubdomains,
  siteNameSlug,
  siteShortId,
  siteSubdomainError,
} from '../subdomain'

test('project names become DNS-safe slugs', () => {
  expect(siteNameSlug('My Cool App')).toBe('my-cool-app')
  expect(siteNameSlug('  Café  Déjà_Vu!! ')).toBe('cafe-deja-vu')
  expect(siteNameSlug('🚀🚀')).toBe('site')
  expect(siteNameSlug('a'.repeat(80) + ' b')).toBe('a'.repeat(48))
})

test('generated addresses are valid, unreserved labels', () => {
  const id = siteShortId(new Uint8Array([0, 1, 35, 36, 255, 7]))
  expect(id).toMatch(/^[a-z0-9]{6}$/)
  const long = generatedSiteSubdomains(siteNameSlug('x'.repeat(100)), id)
  expect(long.preview).toBe(`${'x'.repeat(48)}-${id}-preview`)
  for (const label of [long.production, long.preview])
    expect(siteSubdomainError(label)).toBeNull()
  expect(generatedSiteSubdomains('my-app', 'k3x9q2')).toEqual({
    production: 'my-app-k3x9q2',
    preview: 'my-app-k3x9q2-preview',
  })
})
