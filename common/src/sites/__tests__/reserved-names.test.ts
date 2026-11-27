import { describe, expect, test } from 'bun:test'

import {
  RESERVED_HOSTING_SLUGS,
  impersonatesFreebuff,
  isReservedHostingSlug,
  withoutFreebuffBrand,
} from '../reserved-names'

describe('isReservedHostingSlug', () => {
  test('reserves auth — the sign-in email relay host', () => {
    expect(RESERVED_HOSTING_SLUGS.has('auth')).toBe(true)
    expect(isReservedHostingSlug('auth')).toBe(true)
  })

  test('reserves the email hosts: sending domains and the email platform', () => {
    for (const slug of ['mail', 'email', 'news', 'newsletter', 'noreply']) {
      expect(isReservedHostingSlug(slug)).toBe(true)
    }
  })

  test('reserves the hosts that have their own DNS record in the freebuff.app zone', () => {
    for (const slug of ['auth', 'integrations', 'buffcraft']) {
      expect(isReservedHostingSlug(slug)).toBe(true)
    }
  })

  test('normalizes case and whitespace before checking', () => {
    expect(isReservedHostingSlug('AUTH')).toBe(true)
    expect(isReservedHostingSlug(' auth ')).toBe(true)
    expect(isReservedHostingSlug('Www')).toBe(true)
  })

  test('allows ordinary project slugs', () => {
    expect(isReservedHostingSlug('myapp')).toBe(false)
    expect(isReservedHostingSlug('authors')).toBe(false)
    expect(isReservedHostingSlug('author')).toBe(false)
  })

  test('stays exact: freebuff.app does not get the brand rule', () => {
    expect(isReservedHostingSlug('freebuff')).toBe(true)
    expect(isReservedHostingSlug('freebuffairdrop')).toBe(false)
  })
})

describe('impersonatesFreebuff', () => {
  test('catches either name anywhere in a label', () => {
    for (const label of [
      'freebuff',
      'codebuff',
      'freebuff-airdrop',
      'claim-freebuff',
      'freebuffairdrop',
      'my-codebuff-wallet',
      'FreeBuff',
    ])
      expect(impersonatesFreebuff(label)).toBe(true)
  })

  test('catches look-alike spellings', () => {
    for (const label of [
      // Hyphens between letters.
      'free-buff',
      'f-r-e-e-b-u-f-f',
      'code-buff-app',
      // A doubled letter written once, a letter repeated.
      'frebuff',
      'freebuf',
      'frebuf',
      'freeebuff',
      'freebufff',
      'codebuf',
      // Characters that read as a letter.
      'fr33buff',
      'free8uff',
      'freebvff',
      'c0debuff',
      'coclebuff',
      'c0d3-8uff',
    ])
      expect(impersonatesFreebuff(label)).toBe(true)
  })

  test('leaves ordinary names alone', () => {
    for (const label of [
      'buff',
      'buffcraft',
      'free',
      'free-stuff',
      'freedom-buffalo',
      'code',
      'code-camp',
      'coffee-buff',
      'freebie',
      'my-cool-app',
    ])
      expect(impersonatesFreebuff(label)).toBe(false)
  })

  test('is strict where a word only embeds a name', () => {
    // Accepted false positives: one rename for the owner.
    expect(impersonatesFreebuff('free-buffet')).toBe(true)
    expect(impersonatesFreebuff('codebuffer')).toBe(true)
  })
})

describe('withoutFreebuffBrand', () => {
  test('drops the words that read as the name', () => {
    expect(withoutFreebuffBrand('freebuff-airdrop')).toBe('airdrop')
    expect(withoutFreebuffBrand('claim-your-fr33-buff-tokens')).toBe(
      'claim-your-tokens',
    )
    expect(withoutFreebuffBrand('codebuff-x-freebuff-wallet')).toBe('x-wallet')
    expect(withoutFreebuffBrand('my-cool-app')).toBe('my-cool-app')
  })

  test('drops a word that embeds the name whole, leaving no fragment', () => {
    expect(withoutFreebuffBrand('freebuffairdrop-now')).toBe('now')
    // A partial cut would leave `reebuff`.
    expect(withoutFreebuffBrand('codebufffreebuff-drop')).toBe('drop')
  })

  test('repeats until no run of words reads as the name', () => {
    // Dropping `codebuff` joins `free` and `buff`.
    expect(withoutFreebuffBrand('free-codebuff-buff-airdrop')).toBe('airdrop')
    for (const label of ['f-r-e-e-b-u-f-f-x', 'free-free-buff-buff-drop'])
      expect(impersonatesFreebuff(withoutFreebuffBrand(label))).toBe(false)
  })

  test('can leave nothing', () => {
    expect(withoutFreebuffBrand('freebuff')).toBe('')
    expect(withoutFreebuffBrand('free-buff-codebuff')).toBe('')
  })
})
