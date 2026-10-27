import { describe, expect, test } from 'bun:test'

import {
  guardSponsoredCredentials,
  guardSponsoredLink,
  isUnfilledClickIdUrl,
  parseSponsoredRunLinks,
  resolveSponsoredRunLinks,
  sponsoredRunLinks,
  sponsoredRunLinksSignupStep,
} from './sponsored-run-links'

const TOKEN = 'bfc_1.p.s'
const LINK = `https://acme.example/?bfcid=${TOKEN}`
const SIGNUP = 'https://acme.example/signup?bfcid={bfcid}&utm_source=freebuff'
const KEY_LINE =
  'requires-credential: env=ACME_API_KEY label="Acme API key" get_url=https://acme.example/keys?bfcid={bfcid}&e={email}'
const PROCEDURE = `Sign up at ${SIGNUP}.\n${KEY_LINE}`

describe('isUnfilledClickIdUrl', () => {
  test.each([
    'https://a.example/?bfcid={bfcid}',
    'https://a.example/?bfcid={BFCID}',
    'https://a.example/?bfcid=%7Bbfcid%7D',
    'https://a.example/?bfcid=%7bBfCiD%7d',
    'https://a.example/?bfcid=%257Bbfcid%257D',
    'https://a.example/?next=%257bbfcid%257d',
  ])('matches %s', (url) => {
    expect(isUnfilledClickIdUrl(url)).toBe(true)
  })

  test.each([LINK, 'https://a.example/?bfcid=', null, undefined, ''])(
    'does not match %s',
    (url) => {
      expect(isUnfilledClickIdUrl(url)).toBe(false)
    },
  )
})

describe('resolveSponsoredRunLinks', () => {
  test('fills the click id into the sign-up link and the key page', () => {
    const links = resolveSponsoredRunLinks(PROCEDURE, { advertiserLink: LINK })
    expect(links.signupSource).toBe('procedure')
    expect(links.signupUrl).toBe(
      `https://acme.example/signup?bfcid=${TOKEN}&utm_source=freebuff`,
    )
    // The key page loses its `{email}` slot; nobody agreed to share it.
    expect(links.credentials).toEqual([
      {
        env: 'ACME_API_KEY',
        label: 'Acme API key',
        getUrl: `https://acme.example/keys?bfcid=${TOKEN}`,
      },
    ])
  })

  test('keeps an `{email}` slot on the sign-up link for a surface that asks', () => {
    const links = resolveSponsoredRunLinks(
      'Go to https://acme.example/s?bfcid={bfcid}&email={email}',
      { advertiserLink: LINK },
    )
    expect(links.signupUrl).toBe(
      `https://acme.example/s?bfcid=${TOKEN}&email={email}`,
    )
  })

  test('without a signed click id: no URL with a placeholder, ever', () => {
    const links = resolveSponsoredRunLinks(PROCEDURE, { advertiserLink: null })
    expect(links.signupUrl).toBeNull()
    expect(links.signupSource).toBe('unresolved')
    expect(links.credentials).toEqual([
      { env: 'ACME_API_KEY', label: 'Acme API key' },
    ])
  })

  test('falls back to the signed landing link when the procedure has none', () => {
    const links = resolveSponsoredRunLinks(
      'Do the work.\nrequires-credential: env=ACME_API_KEY label="Acme API key"',
      { advertiserLink: LINK },
    )
    expect(links.signupSource).toBe('landing')
    expect(links.signupUrl).toBe(LINK)
  })

  test('no account needed: no sign-up step', () => {
    const links = resolveSponsoredRunLinks('Do the work.', {
      advertiserLink: LINK,
    })
    expect(links).toEqual({
      signupUrl: null,
      signupSource: null,
      credentials: [],
    })
    expect(sponsoredRunLinksSignupStep(links)).toBeUndefined()
  })

  test('a double-encoded slot the template does not fill is dropped', () => {
    const links = resolveSponsoredRunLinks(
      'requires-credential: env=ACME_API_KEY label="Acme API key" get_url=https://acme.example/keys?bfcid=%257Bbfcid%257D',
      { advertiserLink: LINK },
    )
    expect(links.credentials[0]!.getUrl).toBeUndefined()
  })

  test('the signup step shape matches what clients used before', () => {
    expect(
      sponsoredRunLinksSignupStep(
        resolveSponsoredRunLinks(PROCEDURE, { advertiserLink: null }),
      ),
    ).toEqual({ url: null })
  })
})

describe('parseSponsoredRunLinks / sponsoredRunLinks', () => {
  const server = resolveSponsoredRunLinks(PROCEDURE, { advertiserLink: LINK })

  test('round-trips what the server resolved', () => {
    expect(
      parseSponsoredRunLinks(JSON.parse(JSON.stringify(server)), PROCEDURE),
    ).toEqual(server)
  })

  test('prefers the server links when they match the procedure', () => {
    const links = sponsoredRunLinks({
      procedure: PROCEDURE,
      runtimeInputs: { advertiserLink: null },
      serverLinks: server,
    })
    expect(links.from).toBe('server')
    expect(links.signupUrl).toBe(server.signupUrl)
  })

  test('falls back to local resolution when absent or malformed', () => {
    for (const serverLinks of [
      undefined,
      null,
      'x',
      { ...server, signupUrl: SIGNUP },
      { ...server, signupSource: 'elsewhere' },
      { ...server, signupUrl: 'http://acme.example/' },
      { ...server, credentials: [] },
      {
        ...server,
        credentials: [{ env: 'OTHER_API_KEY', label: 'Acme API key' }],
      },
      {
        ...server,
        credentials: [
          {
            env: 'ACME_API_KEY',
            label: 'Acme API key',
            getUrl: 'https://acme.example/k?bfcid=%7Bbfcid%7D',
          },
        ],
      },
    ]) {
      const links = sponsoredRunLinks({
        procedure: PROCEDURE,
        runtimeInputs: { advertiserLink: LINK },
        serverLinks,
      })
      expect(links.from).toBe('local')
      expect(links.signupUrl).toBe(server.signupUrl)
    }
  })
})

describe('guardSponsoredLink', () => {
  test('passes a filled link through without telling anyone', () => {
    const blocked: string[] = []
    expect(
      guardSponsoredLink(LINK, { onBlocked: (f) => blocked.push(f) }),
    ).toBe(LINK)
    expect(blocked).toEqual([])
  })

  test('falls back to the signed advertiser link', () => {
    const blocked: string[] = []
    expect(
      guardSponsoredLink(SIGNUP, {
        advertiserLink: LINK,
        onBlocked: (f) => blocked.push(f),
      }),
    ).toBe(LINK)
    expect(blocked).toEqual(['advertiser_link'])
  })

  test('shows nothing when the advertiser link carries no signed id', () => {
    const blocked: string[] = []
    for (const advertiserLink of [
      null,
      'https://acme.example/',
      'https://acme.example/?bfcid={bfcid}',
    ])
      expect(
        guardSponsoredLink(SIGNUP, {
          advertiserLink,
          onBlocked: (f) => blocked.push(f),
        }),
      ).toBeNull()
    expect(blocked).toEqual(['none', 'none', 'none'])
  })

  test('a throwing logger never opens the link', () => {
    expect(
      guardSponsoredLink(SIGNUP, {
        onBlocked: () => {
          throw new Error('x')
        },
      }),
    ).toBeNull()
  })

  test('credentials: a placeholder key page is dropped or replaced', () => {
    const credentials = [
      { env: 'A_API_KEY', label: 'A', getUrl: SIGNUP },
      { env: 'B_API_KEY', label: 'B', getUrl: 'https://b.example/keys' },
    ]
    expect(guardSponsoredCredentials(credentials)).toEqual([
      { env: 'A_API_KEY', label: 'A' },
      credentials[1]!,
    ])
    expect(
      guardSponsoredCredentials(credentials, { advertiserLink: LINK })[0],
    ).toEqual({ env: 'A_API_KEY', label: 'A', getUrl: LINK })
  })
})

describe('sponsoredRunLinks: server links must match the local targets', () => {
  const procedure = [
    'skill: acme-search@1.0.0 sha256:abc',
    'requires-credential: env=ACME_API_KEY label="Acme API key" get_url=https://acme.example/keys?utm_source=freebuff&bfcid={bfcid}',
    '',
    'Goal: add Acme.',
  ].join('\n')
  const runtimeInputs = { advertiserLink: LINK }

  test('a server link to the same page is used', () => {
    const server = resolveSponsoredRunLinks(procedure, runtimeInputs)
    const result = sponsoredRunLinks({
      procedure,
      runtimeInputs,
      serverLinks: JSON.parse(JSON.stringify(server)),
    })
    expect(result.from).toBe('server')
  })

  test('a server link to another host is ignored for the local one', () => {
    const local = sponsoredRunLinks({ procedure, runtimeInputs })
    const hostile = {
      signupUrl: local.signupUrl,
      signupSource: local.signupSource,
      credentials: local.credentials.map((credential) => ({
        ...credential,
        getUrl: `https://other-advertiser.example/keys?bfcid=${TOKEN}`,
      })),
    }
    const result = sponsoredRunLinks({
      procedure,
      runtimeInputs,
      serverLinks: hostile,
    })
    expect(result.from).toBe('local')
    expect(result.credentials[0]?.getUrl ?? '').not.toContain(
      'other-advertiser',
    )
  })
})
