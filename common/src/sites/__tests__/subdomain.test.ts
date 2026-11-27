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

const RESERVED = 'This subdomain is reserved. Choose another name.'

test('a chosen address may not be reserved or read as Freebuff', () => {
  for (const label of [
    'customers',
    `site-${'a'.repeat(32)}`,
    // The hosting reserved words freebuff.app refuses.
    'login',
    'Admin',
    'auth',
    'wallet',
    // Brand look-alikes, anywhere in the label.
    'freebuff',
    'freebuff-airdrop',
    'free-buff',
    'fr33buff-claim',
    'codebuff',
    'c0debuf',
    // Punycode, which can render as Unicode look-alikes (Cyrillic `аррӏе`).
    'xn--80ak6aa92e',
  ])
    expect(siteSubdomainError(label)).toBe(RESERVED)
  for (const label of ['fieldnotes', 'my-cool-app', 'authors', 'buffalo-wings'])
    expect(siteSubdomainError(label)).toBeNull()
})

test('a generated address drops the brand instead of refusing the site', () => {
  expect(siteNameSlug('Freebuff Airdrop')).toBe('airdrop')
  // A word that embeds the name goes whole.
  expect(siteNameSlug('FreebuffAirdrop')).toBe('site')
  expect(siteNameSlug('FreebuffAirdrop Live')).toBe('live')
  expect(siteNameSlug('Claim your FR33 BUFF tokens!')).toBe('claim-your-tokens')
  expect(siteNameSlug('Codebuff × Freebuff Wallet')).toBe('wallet')
  // Fullwidth letters fold to ASCII before the check.
  expect(siteNameSlug('Ｆｒｅｅｂｕｆｆ Drop')).toBe('drop')
  expect(siteNameSlug('FREEBUFF')).toBe('site')
  // The cut happens before the length cap, so a long name keeps its words.
  expect(siteNameSlug('freebuff ' + 'a'.repeat(60))).toBe('a'.repeat(48))
  for (const name of [
    'Freebuff Airdrop',
    'free buff',
    'fr33-8uff',
    'Official Codebuff',
    'freefreebuffbuff',
  ]) {
    const { production, preview } = generatedSiteSubdomains(
      siteNameSlug(name),
      'k3x9q2',
    )
    for (const label of [production, preview])
      expect(siteSubdomainError(label)).toBeNull()
  }
})
