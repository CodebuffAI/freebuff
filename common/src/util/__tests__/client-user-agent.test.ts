import { describe, expect, it } from 'bun:test'

import {
  UNRECOGNIZED_CLIENT,
  clientUserAgentFields,
  normalizeClientUserAgent,
} from '../client-user-agent'

describe('normalizeClientUserAgent', () => {
  it('parses the official CLI agent', () => {
    // What getCliAdRequestUserAgent() emits.
    expect(normalizeClientUserAgent('Freebuff-CLI/0.0.138')).toEqual({
      product: 'freebuff-cli',
      version: '0.0.138',
    })
    expect(normalizeClientUserAgent('Codebuff-CLI/1.0.685')).toEqual({
      product: 'codebuff-cli',
      version: '1.0.685',
    })
  })

  it('parses runtime and SDK agents a non-official client would send', () => {
    expect(normalizeClientUserAgent('Go-http-client/2.0')).toEqual({
      product: 'go-http-client',
      version: '2.0',
    })
    expect(normalizeClientUserAgent('Bun/1.3.11')).toEqual({
      product: 'bun',
      version: '1.3.11',
    })
    // The second segment is not a version, so it is dropped.
    expect(
      normalizeClientUserAgent('ai-sdk/openai-compatible/1.0.25/codebuff'),
    ).toEqual({ product: 'ai-sdk' })
  })

  it('keeps only the leading product token, dropping platform detail', () => {
    // The PII guard: everything after the first whitespace is never read, so
    // OS/device strings cannot reach an event payload.
    const browser =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    expect(normalizeClientUserAgent(browser)).toEqual({
      product: 'mozilla',
      version: '5.0',
    })
  })

  it('returns undefined for an absent or blank header', () => {
    expect(normalizeClientUserAgent(undefined)).toBeUndefined()
    expect(normalizeClientUserAgent(null)).toBeUndefined()
    expect(normalizeClientUserAgent('   ')).toBeUndefined()
    expect(clientUserAgentFields(null)).toEqual({})
  })

  it('collapses an over-long product instead of truncating it', () => {
    // Truncating would both fabricate a name and leave long random strings as
    // a cheap way to mint new values.
    expect(normalizeClientUserAgent('A'.repeat(200) + '/1.0')).toEqual({
      product: UNRECOGNIZED_CLIENT,
    })
    // Exactly at the cap is still kept.
    const atCap = 'a'.repeat(32)
    expect(normalizeClientUserAgent(`${atCap}/1.0`)).toEqual({
      product: atCap,
      version: '1.0',
    })
    // One past it collapses.
    expect(normalizeClientUserAgent(`${'a'.repeat(33)}/1.0`)).toEqual({
      product: UNRECOGNIZED_CLIENT,
    })
  })

  it('collapses junk to a single constant rather than minting a value', () => {
    // The cardinality guard: a caller varying unparseable bytes cannot create
    // new distinct values.
    expect(normalizeClientUserAgent('!!!@@@###')).toEqual({
      product: UNRECOGNIZED_CLIENT,
    })
    expect(normalizeClientUserAgent('***/1.0')).toEqual({
      product: UNRECOGNIZED_CLIENT,
    })
  })

  it('rejects an address-shaped product rather than mangling it', () => {
    // Stripping `@` would record `userexample.com`, which is still identifying.
    expect(normalizeClientUserAgent('user@example.com/1.0')).toEqual({
      product: UNRECOGNIZED_CLIENT,
    })
    // A contact address in the conventional comment position is already gone:
    // everything after the first whitespace is never read.
    expect(
      normalizeClientUserAgent('MyBot/1.0 (+contact@example.com)'),
    ).toEqual({ product: 'mybot', version: '1.0' })
  })

  it('cannot inject fields into a log line', () => {
    // Newlines and CR terminate the token before any charset stripping.
    expect(normalizeClientUserAgent('evil\nFAKE-FIELD: 1/1.0')).toEqual({
      product: 'evil',
    })
    expect(normalizeClientUserAgent('evil\r\ninjected/1.0')).toEqual({
      product: 'evil',
    })
    expect(normalizeClientUserAgent('{"json":"inject"}/1.0')).toEqual({
      product: 'jsoninject',
      version: '1.0',
    })
  })

  it('drops a version that does not look like a version', () => {
    // Keeps free-form text (a plausible PII carrier) out of the version field.
    expect(normalizeClientUserAgent('curl/not-a-version')).toEqual({
      product: 'curl',
    })
    expect(normalizeClientUserAgent('someclient')).toEqual({
      product: 'someclient',
    })
  })

  it('drops an over-long version rather than fabricating a truncated one', () => {
    expect(normalizeClientUserAgent('x/1' + '2'.repeat(100))).toEqual({
      product: 'x',
    })
    // The case that makes truncation actively wrong: a real, legitimate semver
    // longer than the cap. Reporting `1.0.0-beta+build` would name a version
    // that does not exist and would collide with `...build.2`.
    expect(normalizeClientUserAgent('x/1.0.0-beta+build.1')).toEqual({
      product: 'x',
    })
    // Exactly at the cap is kept.
    expect(normalizeClientUserAgent('x/1234567890123456')).toEqual({
      product: 'x',
      version: '1234567890123456',
    })
  })

  it('omits the version key entirely when absent', () => {
    expect(clientUserAgentFields('someclient')).toEqual({
      client_ua_product: 'someclient',
    })
    expect(clientUserAgentFields('Freebuff-CLI/0.0.138')).toEqual({
      client_ua_product: 'freebuff-cli',
      client_ua_version: '0.0.138',
    })
  })
})
