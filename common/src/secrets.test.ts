import { describe, expect, test } from 'bun:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  SECRET_VALUE_MIN,
  SecretBoundaryError,
  SecretDecryptError,
  SecretExistsError,
  SecretNameError,
  SecretNotFoundError,
  SecretValueError,
  SecretsVault,
  injectSecretEnv,
  isLoopbackUrl,
  redactSecretDeep,
  redactSecretText,
  resolveForOutbound,
  referencedSecretNames,
  resolveSecretRefs,
  secretNamesIn,
  secretPlaceholder,
  secretValueProblem,
} from './secrets'

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), 'freebuff-secrets-'))
}

const VALUE = 'sk-local-test-abcdef123456'

describe('SecretsVault', () => {
  test('stores ciphertext only and reveals the value to the boundary', async () => {
    const directory = await tempDir()
    const vault = await SecretsVault.open({ directory })
    const record = await vault.add({ name: 'ACME_API_KEY', value: VALUE })

    expect(record).toMatchObject({ name: 'ACME_API_KEY', revision: 1 })
    expect(record).not.toHaveProperty('ciphertext')
    expect(record).not.toHaveProperty('value')

    const file = await fs.readFile(path.join(directory, 'secrets.vault.json'), 'utf8')
    expect(file).not.toContain(VALUE)
    expect(file).not.toContain('sk-local')

    expect(await vault.reveal('ACME_API_KEY')).toBe(VALUE)
    expect((await vault.list()).map((entry) => entry.name)).toEqual([
      'ACME_API_KEY',
    ])

    const keyMode = (await fs.stat(path.join(directory, 'secrets.key'))).mode & 0o777
    expect(keyMode).toBe(0o600)
  })

  test('survives a reopen with the same key file', async () => {
    const directory = await tempDir()
    await (await SecretsVault.open({ directory })).add({
      name: 'OPENROUTER_API_KEY',
      value: VALUE,
    })
    const reopened = await SecretsVault.open({ directory })
    expect(await reopened.reveal('OPENROUTER_API_KEY')).toBe(VALUE)
  })

  test('rejects a duplicate name instead of overwriting it', async () => {
    const vault = await SecretsVault.open({ directory: await tempDir() })
    await vault.add({ name: 'ACME_API_KEY', value: VALUE })
    expect(vault.add({ name: 'ACME_API_KEY', value: 'another-value-123' })).rejects.toBeInstanceOf(
      SecretExistsError,
    )
  })

  test('rotate bumps the revision and replaces the value', async () => {
    const vault = await SecretsVault.open({ directory: await tempDir() })
    const first = await vault.add({ name: 'ACME_API_KEY', value: VALUE })
    const second = await vault.rotate({
      name: 'ACME_API_KEY',
      value: 'sk-rotated-999999',
    })
    expect(second.revision).toBe(first.revision + 1)
    expect(second.createdAt).toBe(first.createdAt)
    expect(await vault.reveal('ACME_API_KEY')).toBe('sk-rotated-999999')
  })

  test('remove deletes the record', async () => {
    const vault = await SecretsVault.open({ directory: await tempDir() })
    await vault.add({ name: 'ACME_API_KEY', value: VALUE })
    expect(await vault.remove('ACME_API_KEY')).toBe(true)
    expect(await vault.remove('ACME_API_KEY')).toBe(false)
    expect(vault.reveal('ACME_API_KEY')).rejects.toBeInstanceOf(SecretNotFoundError)
  })

  test('a different key cannot decrypt the vault', async () => {
    const directory = await tempDir()
    const vault = await SecretsVault.open({ directory })
    await vault.add({ name: 'ACME_API_KEY', value: VALUE })
    const other = await SecretsVault.open({
      directory,
      key: Buffer.alloc(32, 9),
    })
    expect(other.reveal('ACME_API_KEY')).rejects.toBeInstanceOf(SecretDecryptError)
  })

  test('tampered ciphertext fails authentication', async () => {
    const directory = await tempDir()
    const vault = await SecretsVault.open({ directory })
    await vault.add({ name: 'ACME_API_KEY', value: VALUE })

    const file = path.join(directory, 'secrets.vault.json')
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
    const ciphertext: string = parsed.records[0].ciphertext
    parsed.records[0].ciphertext =
      (ciphertext[0] === 'A' ? 'B' : 'A') + ciphertext.slice(1)
    await fs.writeFile(file, JSON.stringify(parsed))

    expect(vault.reveal('ACME_API_KEY')).rejects.toBeInstanceOf(SecretDecryptError)
  })

  test('validates names and values', async () => {
    const vault = await SecretsVault.open({ directory: await tempDir() })
    for (const name of ['acme', '1ACME', 'ACME-KEY', '']) {
      expect(vault.add({ name, value: VALUE })).rejects.toBeInstanceOf(SecretNameError)
    }
    expect(
      vault.add({ name: 'ACME_API_KEY', value: 'short' }),
    ).rejects.toBeInstanceOf(SecretValueError)
    expect(secretValueProblem('x'.repeat(SECRET_VALUE_MIN))).toBeNull()
    expect(secretValueProblem('line\nbreak-value')).not.toBeNull()
  })

  test('records use, but nothing expires', async () => {
    const vault = await SecretsVault.open({
      directory: await tempDir(),
      now: () => new Date('2026-11-25T10:00:00Z'),
    })
    await vault.add({ name: 'ACME_API_KEY', value: VALUE })
    await vault.markUsed('ACME_API_KEY')
    const [record] = await vault.list()
    expect(record!.lastUsedAt).toBe('2026-11-25T10:00:00.000Z')
    expect(record).not.toHaveProperty('expiresAt')
  })
})

describe('secret references', () => {
  test('finds and resolves placeholders', async () => {
    const vault = await SecretsVault.open({ directory: await tempDir() })
    await vault.add({ name: 'ACME_API_KEY', value: VALUE })
    expect(secretPlaceholder('ACME_API_KEY')).toBe('${secret:ACME_API_KEY}')
    expect(secretNamesIn('a ${secret:ACME_API_KEY} b ${secret:ACME_API_KEY}')).toEqual([
      'ACME_API_KEY',
    ])
    const resolved = await resolveSecretRefs({
      text: 'Authorization: Bearer ${secret:ACME_API_KEY}',
      vault,
    })
    expect(resolved.text).toBe(`Authorization: Bearer ${VALUE}`)
    expect(resolved.revealed).toEqual([{ name: 'ACME_API_KEY', value: VALUE }])
  })

  test('matches only stored names, in all three command spellings', () => {
    const available = ['ACME_API_KEY', 'OTHER_TOKEN']
    expect(referencedSecretNames('curl -H "x: $ACME_API_KEY"', available)).toEqual([
      'ACME_API_KEY',
    ])
    expect(referencedSecretNames('curl -H "x: ${OTHER_TOKEN}"', available)).toEqual([
      'OTHER_TOKEN',
    ])
    expect(
      referencedSecretNames('curl -H "x: ${secret:ACME_API_KEY}"', available),
    ).toEqual(['ACME_API_KEY'])
    expect(referencedSecretNames('echo $HOME', available)).toEqual([])
  })

  test('redacts the value in plain, URL-encoded and base64 spellings', async () => {
    const value = 'sk-abc+/def123456789'
    const secrets = [{ name: 'ACME_API_KEY', value }]
    const encoded = Buffer.from(value, 'utf8').toString('base64')
    const text = `plain=${value} url=${encodeURIComponent(value)} b64=${encoded}`
    const redacted = redactSecretText(text, secrets)
    expect(redacted).not.toContain(value)
    expect(redacted).not.toContain(encoded)
    expect(redacted).toContain('[secret:ACME_API_KEY]')
  })

  test('redacts nested tool results including keys', () => {
    const secrets = [{ name: 'ACME_API_KEY', value: VALUE }]
    const result = redactSecretDeep(
      { stdout: `token ${VALUE}`, nested: [{ [VALUE]: 'x' }] },
      secrets,
    )
    expect(JSON.stringify(result)).not.toContain(VALUE)
  })

  test('injects env only for named secrets and refuses overwrites', async () => {
    const vault = await SecretsVault.open({ directory: await tempDir() })
    await vault.add({ name: 'ACME_API_KEY', value: VALUE })
    const injected = await injectSecretEnv({
      vault,
      names: ['ACME_API_KEY'],
      baseEnv: { PATH: '/usr/bin' },
    })
    expect(injected.env.ACME_API_KEY).toBe(VALUE)
    expect(injected.env.PATH).toBe('/usr/bin')

    expect(
      injectSecretEnv({
        vault,
        names: ['ACME_API_KEY'],
        baseEnv: { ACME_API_KEY: 'already-set' },
      }),
    ).rejects.toBeInstanceOf(SecretBoundaryError)
  })

  test('refuses to send a secret to a remote host', async () => {
    const vault = await SecretsVault.open({ directory: await tempDir() })
    await vault.add({ name: 'ACME_API_KEY', value: VALUE })
    const error = await resolveForOutbound({
      url: 'https://api.example.com/v1/run',
      headers: { authorization: 'Bearer ${secret:ACME_API_KEY}' },
      vault,
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SecretBoundaryError)
    expect(String((error as Error).message)).not.toContain(VALUE)
    expect(String((error as Error).message)).toContain('ACME_API_KEY')
  })

  test('substitutes for a loopback endpoint only', async () => {
    const vault = await SecretsVault.open({ directory: await tempDir() })
    await vault.add({ name: 'ACME_API_KEY', value: VALUE })
    expect(isLoopbackUrl('http://127.0.0.1:8080/v1')).toBe(true)
    expect(isLoopbackUrl('https://example.com')).toBe(false)

    const request = await resolveForOutbound({
      url: 'http://127.0.0.1:8080/v1/run',
      headers: { authorization: 'Bearer ${secret:ACME_API_KEY}' },
      body: '{"key":"${secret:ACME_API_KEY}"}',
      vault,
    })
    expect(request.headers.authorization).toBe(`Bearer ${VALUE}`)
    expect(request.body).toContain(VALUE)
  })
})
