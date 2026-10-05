import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildClaims,
  base64url,
  licenseSubject,
  mintToken,
  TOKEN_VERSION,
  verifyToken,
  type Claims,
} from '../src/tokens'

/** Dev-only test keypair (see docs/entitlement.md). The public half is the one
 *  embedded in the Rust app, so these tests also prove the two implementations
 *  agree on the format. */
const DEV_PRIVATE_PKCS8 =
  'MC4CAQAwBQYDK2VwBCIEIOoHCq5N2gp01ShDliYEDZj5BjchLFHfkvI2CD3jpzvu'
const DEV_PUBLIC = 'ouHWrlcY5+OOry5d0fMknb4il4mIIHb4n+lOhP61+K8='

const NOW = 1_700_000_000

describe('licenseSubject', () => {
  test('is stable, 32 hex chars, and does not leak the key', async () => {
    const a = await licenseSubject('PA-1234-ABCD')
    const b = await licenseSubject('PA-1234-ABCD')
    expect(a).toBe(b)
    expect(a).toHaveLength(32)
    expect(await licenseSubject('PA-9999-ZZZZ')).not.toBe(a)
    expect(a).not.toContain('PA-')
  })
})

describe('token round trip', () => {
  test('mints a token the public key verifies', async () => {
    const claims = await buildClaims({
      licenseKey: 'PA-1',
      deviceId: 'device-1',
      nowSeconds: NOW,
    })
    expect(claims.v).toBe(TOKEN_VERSION)
    expect(claims.ent).toEqual(['pro'])
    expect(claims.exp).toBeGreaterThan(NOW)

    const token = await mintToken(claims, DEV_PRIVATE_PKCS8)
    expect(token.split('.')).toHaveLength(2)
    const verified = await verifyToken(token, DEV_PUBLIC, NOW + 10, 'device-1')
    expect(verified).toEqual(claims)
  })

  test('rejects a tampered payload', async () => {
    const claims = await buildClaims({
      licenseKey: 'PA-1',
      deviceId: 'd1',
      nowSeconds: NOW,
    })
    const token = await mintToken(claims, DEV_PRIVATE_PKCS8)
    const [payload, signature] = token.split('.')
    const forged: Claims = { ...claims, ent: ['enterprise'] }
    const forgedToken = `${base64url(new TextEncoder().encode(JSON.stringify(forged)))}.${signature}`
    expect(verifyToken(forgedToken, DEV_PUBLIC, NOW)).rejects.toThrow(
      'invalid signature',
    )
    expect(payload).not.toBe(forgedToken.split('.')[0])
  })

  test('rejects expiry, wrong device, bad version and garbage', async () => {
    const claims = await buildClaims({
      licenseKey: 'PA-1',
      deviceId: 'd1',
      nowSeconds: NOW,
    })
    const token = await mintToken(claims, DEV_PRIVATE_PKCS8)
    expect(verifyToken(token, DEV_PUBLIC, claims.exp)).rejects.toThrow(
      'expired',
    )
    expect(verifyToken(token, DEV_PUBLIC, NOW, 'other')).rejects.toThrow(
      'wrong device',
    )
    expect(verifyToken('garbage', DEV_PUBLIC, NOW)).rejects.toThrow(
      'malformed token',
    )

    const wrongVersion = await mintToken(
      { ...claims, v: 99 },
      DEV_PRIVATE_PKCS8,
    )
    expect(verifyToken(wrongVersion, DEV_PUBLIC, NOW)).rejects.toThrow(
      'unsupported version',
    )
  })
})

describe('golden vector parity', () => {
  /** The same token, pinned on both sides of the language boundary. See the
   *  Rust test `worker_minted_token_verifies_offline`. */
  const WORKER_VECTOR =
    'eyJ2IjoxLCJzdWIiOiI4MjBhZDk0YjQ5NjBjOGNhMjM5NmI3ZWFhNTVjZWE3NiIsImRldiI6ImRldmljZS0xIiwiZW50IjpbInBybyJdLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6NDEwMjQ0NDgwMH0.pOBV77Bjtc-PPKGDXowLaSxE9L_hbLLbJ5C36xtb9bPiYUnufJVZ99yy7cBuD9XS7iHa5XJsprgk68zQtOh5Ag'

  test('minting the documented claims reproduces the shared token', async () => {
    const claims: Claims = {
      v: TOKEN_VERSION,
      sub: await licenseSubject('PA-VECTOR-0001'),
      dev: 'device-1',
      ent: ['pro'],
      iat: 1_700_000_000,
      exp: 4_102_444_800,
    }
    expect(await mintToken(claims, DEV_PRIVATE_PKCS8)).toBe(WORKER_VECTOR)
    expect(claims.sub).toBe('820ad94b4960c8ca2396b7eaa55cea76')
  })
})

describe('rust/python parity', () => {
  test('the Rust app embeds this exact public key', () => {
    const rust = readFileSync(
      join(import.meta.dir, '../../src-tauri/src/entitlement.rs'),
      'utf8',
    )
    const match = rust.match(/DEV_PUBLIC_KEY_B64: &str = "([^"]+)"/)
    expect(match).not.toBeNull()
    expect(match![1]).toBe(DEV_PUBLIC)
  })
})
