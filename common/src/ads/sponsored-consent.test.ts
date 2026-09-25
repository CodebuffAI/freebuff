import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  SPONSORED_CONSENT_IN_PLACE_SENTENCE,
  SPONSORED_CONSENT_MAX_NAME_CHARS,
  SPONSORED_CONSENT_NO_NAME,
  SPONSORED_CONSENT_SENTENCE,
  SPONSORED_CONSENT_WINDOWS_FLOOR_SENTENCE,
  sponsoredConsentName,
  sponsoredConsentSentence,
} from './sponsored-consent'

describe('the advertiser name', () => {
  test('is passed through when it is ordinary', () => {
    expect(sponsoredConsentName('Greptile')).toBe('Greptile')
    expect(sponsoredConsentSentence('Greptile')).toBe(
      'Greptile wants to integrate itself into this project, on its own branch. Nothing is pushed until you review it.',
    )
  })

  test('is capped, so it can never push the buttons off the dialog', () => {
    const long = sponsoredConsentName('x'.repeat(4_000))
    expect(long.length).toBe(SPONSORED_CONSENT_MAX_NAME_CHARS + 1) // + the ellipsis
    expect(long.endsWith('…')).toBe(true)
  })

  test('escapes what would restyle the line, and never silently drops it', () => {
    // Bidi overrides and zero-width characters make a name render as text it is not, which on a
    // consent screen is the entire game. Stripping them hides the payload just as well, only
    // quietly -- so they are shown as escapes.
    expect(sponsoredConsentName('a\u202eb')).toBe('a\\u202eb')
    expect(sponsoredConsentName('a\u200bb')).toBe('a\\u200bb')
    expect(sponsoredConsentName('one\ntwo')).toBe('one\\ntwo')
    expect(sponsoredConsentName('a\u0007b')).toBe('a\\u0007b')
  })

  test('blank is not a sentence about nobody', () => {
    expect(sponsoredConsentName('   ')).toBe('')
    expect(sponsoredConsentName(null)).toBe('')
    expect(sponsoredConsentSentence('')).toBe(SPONSORED_CONSENT_NO_NAME)
  })
})

// The desktop consent dialog is drawn by the Electron MAIN process from a plain CJS module and a
// static HTML file, neither of which may require a workspace package -- the bridge is deliberately
// free of workspace requires so it unit-tests under Bun and survives packaging untouched. So they
// carry their own copies of these strings, and this is what stops the two surfaces drifting into
// asking two different questions.
describe('every surface asks the same question', () => {
  const root = path.join(__dirname, '..', '..', '..')
  const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8')

  test.each([
    ['freebuff-desktop/electron/mcp-consent-bridge.cjs'],
    ['freebuff-desktop/electron/consent-window.html'],
  ])('%s carries the same sentence, verbatim', (rel) => {
    expect(read(rel)).toContain(SPONSORED_CONSENT_SENTENCE.trim())
  })

  // The IN-PLACE question (#3989) is asked by Desktop's bridge and by the CLI's
  // dock from this constant; the two must be the same words.
  test('the bridge carries the same in-place sentence, verbatim', () => {
    expect(read('freebuff-desktop/electron/mcp-consent-bridge.cjs')).toContain(
      SPONSORED_CONSENT_IN_PLACE_SENTENCE.trim(),
    )
  })

  test.each([
    ['freebuff-desktop/electron/mcp-consent-bridge.cjs'],
    ['freebuff-desktop/electron/consent-window.html'],
  ])(
    '%s carries the same Windows no-sandbox sentence, verbatim (COD-642)',
    (rel) => {
      expect(read(rel)).toContain(SPONSORED_CONSENT_WINDOWS_FLOOR_SENTENCE)
    },
  )

  test('the Windows sentence says the three things, in plain words', () => {
    expect(SPONSORED_CONSENT_WINDOWS_FLOOR_SENTENCE).toContain('no sandbox')
    expect(SPONSORED_CONSENT_WINDOWS_FLOOR_SENTENCE).toContain(
      'your own Windows permissions',
    )
    expect(SPONSORED_CONSENT_WINDOWS_FLOOR_SENTENCE).toContain(
      'hidden from it but not locked away',
    )
  })

  test('the desktop window says the same thing when it cannot name who is asking', () => {
    expect(read('freebuff-desktop/electron/consent-window.html')).toContain(
      SPONSORED_CONSENT_NO_NAME,
    )
  })

  test.each([
    ['freebuff-desktop/electron/mcp-consent-bridge.cjs'],
    ['freebuff-desktop/electron/consent-window.html'],
  ])('%s caps the name at the same length', (rel) => {
    // Both of them, because the bridge clamps before it sends AND the page clamps what it is
    // given: the page is the last thing between an advertiser's name and a human's eyes, and one
    // U+202E there reverses our own sentence.
    expect(read(rel)).toContain(
      `MAX_NAME_CHARS = ${SPONSORED_CONSENT_MAX_NAME_CHARS}`,
    )
  })
})
