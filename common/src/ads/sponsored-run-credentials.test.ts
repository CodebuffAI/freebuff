import { describe, expect, test } from 'bun:test'

import { scrubSponsoredLocalEnv } from './sponsored-local-execution'
import {
  SPONSORED_OUTPUT_TRUNCATION_TEXT,
  SPONSORED_RUN_CREDENTIAL_MAX,
  declaredRunCredentials,
  isSponsoredCredentialEnvName,
  normalizeRunCredentials,
  parseRunCredentialDeclaration,
  redactSponsoredCredentialDeep,
  redactSponsoredCredentialText,
  sponsoredCredentialGetUrl,
  sponsoredCredentialValueProblem,
  withSponsoredRunCredentialEnv,
} from './sponsored-run-credentials'

const SIEVE =
  'requires-credential: env=SIEVE_API_KEY label="Sieve API key" get_url=https://sieve.example/keys'

describe('declaredRunCredentials', () => {
  test('reads one declaration out of a procedure, beside other directives', () => {
    const procedure = [
      'Add the Sieve client.',
      'outcomes: api_key_issued',
      SIEVE,
      'Then run one scrape.',
    ].join('\n')
    expect(declaredRunCredentials(procedure)).toEqual([
      {
        env: 'SIEVE_API_KEY',
        label: 'Sieve API key',
        getUrl: 'https://sieve.example/keys',
      },
    ])
  })

  test('get_url is optional; an unquoted single-word label is fine', () => {
    expect(
      declaredRunCredentials('requires-credential: env=LIZARD_TOKEN label=Token'),
    ).toEqual([{ env: 'LIZARD_TOKEN', label: 'Token' }])
  })

  test('the directive is case-insensitive and tolerates surrounding space and CRLF', () => {
    expect(
      declaredRunCredentials(
        `intro\r\n   REQUIRES-CREDENTIAL :  env=LIZARD_TOKEN label="Lizard token"  \r\nend`,
      ),
    ).toEqual([{ env: 'LIZARD_TOKEN', label: 'Lizard token' }])
  })

  test('nothing declared, or not a string, is an empty list', () => {
    expect(declaredRunCredentials('Just edit files.')).toEqual([])
    expect(declaredRunCredentials(null)).toEqual([])
    expect(declaredRunCredentials(undefined)).toEqual([])
  })

  test(`at most ${SPONSORED_RUN_CREDENTIAL_MAX}, in declaration order`, () => {
    const procedure = [
      'requires-credential: env=A_API_KEY label=A',
      'requires-credential: env=B_API_KEY label=B',
      'requires-credential: env=C_API_KEY label=C',
    ].join('\n')
    expect(declaredRunCredentials(procedure).map((c) => c.env)).toEqual([
      'A_API_KEY',
      'B_API_KEY',
    ])
  })

  test('an identical repeat is one declaration; a conflicting repeat declares nothing for that name', () => {
    expect(declaredRunCredentials(`${SIEVE}\n${SIEVE}`)).toHaveLength(1)
    expect(
      declaredRunCredentials(
        `${SIEVE}\nrequires-credential: env=SIEVE_API_KEY label="Other" get_url=https://sieve.example/keys\nrequires-credential: env=OTHER_TOKEN label=Other`,
      ).map((c) => c.env),
    ).toEqual(['OTHER_TOKEN'])
  })

  test('a malformed line declares nothing, and does not affect a good one', () => {
    const procedure = [
      'requires-credential: env=sieve_api_key label=lower',
      'requires-credential: env=GOOD_API_KEY label=Good',
    ].join('\n')
    expect(declaredRunCredentials(procedure).map((c) => c.env)).toEqual([
      'GOOD_API_KEY',
    ])
  })
})

describe('parseRunCredentialDeclaration: strict', () => {
  const refused = [
    ['no env', 'label="Sieve API key"'],
    ['no label', 'env=SIEVE_API_KEY'],
    ['lower-case env', 'env=sieve_api_key label=x'],
    ['env starting with a digit', 'env=1SIEVE_KEY label=x'],
    ['env with a dash', 'env=SIEVE-API-KEY label=x'],
    ['env too long', `env=${'A'.repeat(61)}_KEY label=x`],
    ['env not credential-shaped', 'env=PATH label=x'],
    ['NODE_OPTIONS', 'env=NODE_OPTIONS label=x'],
    ['LD_PRELOAD', 'env=LD_PRELOAD label=x'],
    ['bare suffix', 'env=_KEY label=x'],
    ['one-letter prefix', 'env=A_KEY label=x'],
    ['GitHub token', 'env=GITHUB_TOKEN label=x'],
    ['AWS key', 'env=AWS_SECRET_ACCESS_KEY label=x'],
    ['npm token', 'env=NPM_TOKEN label=x'],
    ['OpenAI key', 'env=OPENAI_API_KEY label=x'],
    ['git config', 'env=GIT_ASKPASS_TOKEN label=x'],
    ['our own', 'env=FREEBUFF_API_KEY label=x'],
    ['http url', 'env=SIEVE_API_KEY label=x get_url=http://sieve.example'],
    ['javascript url', 'env=SIEVE_API_KEY label=x get_url=javascript:alert(1)'],
    ['userinfo in url', 'env=SIEVE_API_KEY label=x get_url=https://u:p@sieve.example'],
    ['not a url', 'env=SIEVE_API_KEY label=x get_url=sieve.example'],
    ['unknown key', 'env=SIEVE_API_KEY label=x value=abc'],
    ['duplicate key', 'env=SIEVE_API_KEY env=OTHER_KEY label=x'],
    ['stray word', 'env=SIEVE_API_KEY label=x please'],
    ['unterminated quote', 'env=SIEVE_API_KEY label="Sieve API key'],
    ['glued pairs', 'env=SIEVE_API_KEY label="x"get_url=https://sieve.example'],
    ['empty label', 'env=SIEVE_API_KEY label=""'],
    ['label with angle brackets', 'env=SIEVE_API_KEY label="<b>x</b>"'],
    ['label too long', `env=SIEVE_API_KEY label="${'x'.repeat(61)}"`],
    ['empty', ''],
  ] as const
  for (const [name, value] of refused) {
    test(`refuses: ${name}`, () => {
      expect(parseRunCredentialDeclaration(value)).toBeNull()
    })
  }

  test('accepts the documented suffixes', () => {
    for (const env of [
      'SIEVE_API_KEY',
      'LIZARD_TOKEN',
      'ACME_CLIENT_SECRET',
      'ACME_PASSWORD',
      'ACME_ACCESS_TOKEN',
    ]) {
      expect(parseRunCredentialDeclaration(`env=${env} label=x`)?.env).toBe(env)
    }
  })

  test('every declarable name is one the scrub would otherwise refuse or ignore, never a system variable', () => {
    expect(isSponsoredCredentialEnvName('SIEVE_API_KEY')).toBe(true)
    for (const name of ['PATH', 'HOME', 'TMPDIR', 'BASH_ENV', 'GIT_CONFIG_COUNT', 'npm_config_prefix']) {
      expect(isSponsoredCredentialEnvName(name)).toBe(false)
    }
  })
})

describe('normalizeRunCredentials', () => {
  test('round-trips a parsed list and drops anything invalid', () => {
    const declared = declaredRunCredentials(SIEVE)
    expect(normalizeRunCredentials(JSON.parse(JSON.stringify(declared)))).toEqual(
      declared,
    )
    expect(
      normalizeRunCredentials([
        { env: 'PATH', label: 'x' },
        { env: 'SIEVE_API_KEY', label: 'x', getUrl: 'http://insecure.example' },
        { env: 'GOOD_TOKEN', label: 'Good' },
        'junk',
        null,
      ]),
    ).toEqual([{ env: 'GOOD_TOKEN', label: 'Good' }])
    expect(normalizeRunCredentials('nope')).toEqual([])
  })

  test('the get_url check canonicalises and refuses non-https', () => {
    expect(sponsoredCredentialGetUrl('https://Sieve.example/keys')).toBe(
      'https://sieve.example/keys',
    )
    expect(sponsoredCredentialGetUrl('file:///etc/passwd')).toBeNull()
  })
})

describe('values', () => {
  test('a key-shaped value is usable', () => {
    expect(sponsoredCredentialValueProblem('sv_live_abcdefgh1234')).toBeNull()
  })
  test('empty, short, long, whitespace and control characters are not', () => {
    expect(sponsoredCredentialValueProblem('')).toBe('empty')
    expect(sponsoredCredentialValueProblem('abc')).toBe('too_short')
    expect(sponsoredCredentialValueProblem('a'.repeat(5000))).toBe('too_long')
    expect(sponsoredCredentialValueProblem('abc defgh ij')).toBe('invalid_characters')
    expect(sponsoredCredentialValueProblem('abcdefgh\n')).toBe('invalid_characters')
    expect(sponsoredCredentialValueProblem(42)).toBe('empty')
  })
})

describe('withSponsoredRunCredentialEnv', () => {
  const scrubbed = scrubSponsoredLocalEnv(
    {
      PATH: '/usr/bin',
      // The user's OWN key in their shell: the scrub drops it, and injection
      // does not bring it back.
      SIEVE_API_KEY: 'from-the-users-shell',
    },
    { home: '/run/home', tmp: '/run/tmp' },
  )

  test('the scrub still drops a host credential of the same name', () => {
    expect(scrubbed.SIEVE_API_KEY).toBeUndefined()
  })

  test('adds exactly the declared variable, with the vault value', () => {
    const env = withSponsoredRunCredentialEnv(
      scrubbed,
      { SIEVE_API_KEY: 'sv_test_1234567890' },
    )
    expect(env.SIEVE_API_KEY).toBe('sv_test_1234567890')
    expect(env.HOME).toBe('/run/home')
    // The scrub's own output is untouched.
    expect(scrubbed.SIEVE_API_KEY).toBeUndefined()
  })

  test('no credentials is the scrub output unchanged', () => {
    expect(withSponsoredRunCredentialEnv(scrubbed, undefined)).toEqual(
      scrubbed,
    )
  })

  test('refuses an undeclarable name', () => {
    expect(() =>
      withSponsoredRunCredentialEnv(scrubbed, { NODE_OPTIONS: '--require=/tmp/x.js' }),
    ).toThrow(/not a declarable credential name/)
    expect(() =>
      withSponsoredRunCredentialEnv(scrubbed, { GITHUB_TOKEN: 'ghp_abcdefghijkl' }),
    ).toThrow(/not a declarable credential name/)
  })

  test('refuses to overwrite a variable the scrub set', () => {
    expect(() =>
      withSponsoredRunCredentialEnv(
        { ...scrubbed, ACME_TOKEN: 'set-by-scrub' },
        { ACME_TOKEN: 'abcdefghijkl' },
      ),
    ).toThrow(/already sets/)
  })

  test('refuses an unusable value, and never echoes it', () => {
    let message = ''
    try {
      withSponsoredRunCredentialEnv(scrubbed, { SIEVE_API_KEY: 'bad value!' })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('SIEVE_API_KEY')
    expect(message).not.toContain('bad value!')
  })

  test('the scrub output is never re-judged: an eval scrub or a fixed npm key passes through untouched', () => {
    const env = withSponsoredRunCredentialEnv(
      { PATH: '/usr/bin', npm_config_prefix: '/run/cli' },
      { SIEVE_API_KEY: 'sv_test_1234567890' },
    )
    expect(env).toEqual({
      PATH: '/usr/bin',
      npm_config_prefix: '/run/cli',
      SIEVE_API_KEY: 'sv_test_1234567890',
    })
  })

  test('a name clashing in another letter case is refused', () => {
    expect(() =>
      withSponsoredRunCredentialEnv(
        { Acme_Token: 'x' },
        { ACME_TOKEN: 'abcdefghijkl' },
      ),
    ).toThrow(/already sets `Acme_Token`/)
  })
})

describe('redaction', () => {
  const secret = { name: 'SIEVE_API_KEY', value: 'sv_live_ABCDEFGH12345678' }

  test('raw, URL-encoded, base64 and base64url spellings are replaced', () => {
    const special = { name: 'ACME_TOKEN', value: 'a+b/c=d?e&f~g_h' }
    const b64 = Buffer.from(special.value).toString('base64')
    const b64url = Buffer.from(special.value).toString('base64url')
    const text = [
      `raw ${special.value}`,
      `url ${encodeURIComponent(special.value)}`,
      `b64 ${b64}`,
      `b64url ${b64url}`,
    ].join('\n')
    const out = redactSponsoredCredentialText(text, [special])
    expect(out).not.toContain(special.value)
    expect(out).not.toContain(encodeURIComponent(special.value))
    expect(out).not.toContain(b64)
    expect(out).not.toContain(b64url)
    expect(out.match(/\[redacted:ACME_TOKEN\]/g)).toHaveLength(4)
  })

  test('curl -v style output is redacted and the rest kept', () => {
    const out = redactSponsoredCredentialText(
      `> Authorization: Bearer ${secret.value}\n< HTTP/2 200`,
      [secret],
    )
    expect(out).toBe('> Authorization: Bearer [redacted:SIEVE_API_KEY]\n< HTTP/2 200')
  })

  test('halves of a value split by the truncation cut are redacted', () => {
    // The shape `runTerminalCommand` produces: head, the marker framed by
    // newlines, tail -- with the cut falling inside the value.
    const text = `start ${secret.value.slice(0, 10)}\n${SPONSORED_OUTPUT_TRUNCATION_TEXT}\n${secret.value.slice(10)} end`
    const out = redactSponsoredCredentialText(text, [secret])
    expect(out).not.toContain(secret.value.slice(0, 10))
    expect(out).not.toContain(secret.value.slice(10))
    expect(out).toBe(
      `start [redacted:SIEVE_API_KEY]\n${SPONSORED_OUTPUT_TRUNCATION_TEXT}\n[redacted:SIEVE_API_KEY] end`,
    )
  })

  test('base64 of the value inside a larger string (Basic auth) is redacted at every alignment', () => {
    for (const user of ['', 'u', 'us', 'api', 'user']) {
      const encoded = Buffer.from(`${user}:${secret.value}`).toString('base64')
      const text = `> Authorization: Basic ${encoded}\n< HTTP/2 200`
      const out = redactSponsoredCredentialText(text, [secret])
      expect(out).toContain('[redacted:SIEVE_API_KEY]')
      // What is left of the encoding cannot be decoded back to the value.
      const left = out.match(/Basic (\S*)/)![1]!
      const decoded = Buffer.from(
        left.replace('[redacted:SIEVE_API_KEY]', ''),
        'base64',
      ).toString('latin1')
      expect(decoded).not.toContain(secret.value.slice(4, 12))
      expect(out).not.toContain(encoded)
    }
    // base64url too (JWT-style tooling).
    const url = Buffer.from(`x${secret.value}`).toString('base64url')
    expect(
      redactSponsoredCredentialText(`token ${url}`, [secret]),
    ).toContain('[redacted:SIEVE_API_KEY]')
  })

  test('an ENCODED value split by the truncation cut leaves neither half', () => {
    const special = { name: 'ACME_TOKEN', value: 'a+b/c=d?e&f~g_hIJKLMNOP' }
    for (const spelling of [
      Buffer.from(special.value).toString('base64'),
      Buffer.from(special.value).toString('base64url'),
      encodeURIComponent(special.value),
    ]) {
      const head = spelling.slice(0, 11)
      const tail = spelling.slice(11)
      const text = `start ${head}\n${SPONSORED_OUTPUT_TRUNCATION_TEXT}\n${tail} end`
      const out = redactSponsoredCredentialText(text, [special])
      expect(out).not.toContain(head)
      expect(out).not.toContain(tail)
      expect(out.match(/\[redacted:ACME_TOKEN\]/g)).toHaveLength(2)
    }
  })

  test("code_search's and read_files' own cuts are cut points too, as is a bare string edge", () => {
    const prefix = secret.value.slice(0, 15)
    for (const marker of [
      '[Output truncated]',
      '[Error output truncated]',
      '[FILE_TOO_LARGE]: This file was truncated after 100 characters.',
    ]) {
      const out = redactSponsoredCredentialText(
        `const key = '${prefix}\n\n${marker}`,
        [secret],
      )
      expect(out).not.toContain(prefix)
      expect(out).toContain('[redacted:SIEVE_API_KEY]')
    }
    // A cap that cuts with no marker at all: the value's head ends the string,
    // or its tail starts it.
    expect(
      redactSponsoredCredentialText(`stderr: ${prefix}`, [secret]),
    ).toBe('stderr: [redacted:SIEVE_API_KEY]')
    expect(
      redactSponsoredCredentialText(`${secret.value.slice(9)} rest`, [secret]),
    ).toBe('[redacted:SIEVE_API_KEY] rest')
    // A short ordinary word at an edge is left alone.
    expect(redactSponsoredCredentialText('see sv_l', [secret])).toBe('see sv_l')
  })

  test('short unrelated text beside the cut is not redacted', () => {
    const text = `ok ${SPONSORED_OUTPUT_TRUNCATION_TEXT} ok`
    expect(redactSponsoredCredentialText(text, [secret])).toBe(text)
  })

  test('an unusable secret value redacts nothing (it could never have been injected)', () => {
    expect(redactSponsoredCredentialText('abc abc', [{ name: 'X_KEY', value: 'abc' }])).toBe(
      'abc abc',
    )
  })

  test('deep redaction walks tool results, keys included, and leaves other types alone', () => {
    const result = [
      {
        type: 'json',
        value: {
          command: 'curl -H "Authorization: Bearer $SIEVE_API_KEY" https://api.sieve.example',
          stdout: `token=${secret.value}`,
          nested: { [secret.value]: [secret.value, 7, true, null] },
          exitCode: 0,
        },
      },
    ]
    const out = redactSponsoredCredentialDeep(result, [secret])
    const serialized = JSON.stringify(out)
    expect(serialized).not.toContain(secret.value)
    expect(serialized).toContain('$SIEVE_API_KEY')
    expect(out[0]!.value.exitCode).toBe(0)
    expect(out[0]!.value.nested['[redacted:SIEVE_API_KEY]']).toEqual([
      '[redacted:SIEVE_API_KEY]',
      7,
      true,
      null,
    ])
    // Not mutated.
    expect(result[0]!.value.stdout).toContain(secret.value)
  })
})
