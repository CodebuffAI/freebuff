/** Entitlement token minting.
 *
 * Token format (must stay byte-compatible with `src-tauri/src/entitlement.rs`):
 *   `base64url(claims-json) "." base64url(ed25519-signature)`
 * where the signature covers the raw claims-json bytes and the claims are
 * `{ v, sub, dev, ent, iat, exp }`.
 */

export const TOKEN_VERSION = 1
/** One year — Pro is a lifetime license; this only bounds stale tokens. */
export const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365

export interface Claims {
  v: number
  sub: string
  dev: string
  ent: string[]
  iat: number
  exp: number
}

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Stable, non-reversible license identity — mirrors `license_subject` in Rust. */
export async function licenseSubject(licenseKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(licenseKey),
  )
  return toHex(digest).slice(0, 32)
}

export class TokenError extends Error {}

/** Import the PKCS#8 Ed25519 private key held in the `SIGNING_KEY` secret. */
async function importPrivateKey(pkcs8Base64: string): Promise<CryptoKey> {
  const pkcs8 = base64ToBytes(pkcs8Base64)
  return crypto.subtle.importKey(
    'pkcs8',
    pkcs8 as BufferSource,
    'Ed25519',
    false,
    ['sign'],
  )
}

function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

export function buildClaims(args: {
  licenseKey: string
  deviceId: string
  nowSeconds: number
}): Promise<Claims> {
  return licenseSubject(args.licenseKey).then((sub) => ({
    v: TOKEN_VERSION,
    sub,
    dev: args.deviceId,
    ent: ['pro'],
    iat: args.nowSeconds,
    exp: args.nowSeconds + TOKEN_TTL_SECONDS,
  }))
}

/** Mint a signed entitlement token. */
export async function mintToken(
  claims: Claims,
  privateKeyPkcs8: string,
): Promise<string> {
  const payload = new TextEncoder().encode(JSON.stringify(claims))
  const key = await importPrivateKey(privateKeyPkcs8)
  const signature = await crypto.subtle.sign(
    'Ed25519',
    key,
    payload as BufferSource,
  )
  return `${base64url(payload)}.${base64url(signature)}`
}

/**
 * Verify a token with the raw 32-byte public key. Used by the tests and by any
 * future self-check endpoint; the client performs the same verification offline.
 */
export async function verifyToken(
  token: string,
  publicKeyRaw: string,
  nowSeconds: number,
  deviceId?: string,
): Promise<Claims> {
  const [payloadB64, signatureB64] = token.split('.')
  if (!payloadB64 || !signatureB64) throw new TokenError('malformed token')
  const payload = base64ToBytes(payloadB64)
  const key = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(publicKeyRaw) as BufferSource,
    'Ed25519',
    false,
    ['verify'],
  )
  const ok = await crypto.subtle.verify(
    'Ed25519',
    key,
    base64ToBytes(signatureB64) as BufferSource,
    payload as BufferSource,
  )
  if (!ok) throw new TokenError('invalid signature')
  const claims = JSON.parse(new TextDecoder().decode(payload)) as Claims
  if (claims.v !== TOKEN_VERSION) throw new TokenError('unsupported version')
  if (claims.exp <= nowSeconds) throw new TokenError('expired')
  if (deviceId !== undefined && claims.dev !== deviceId) {
    throw new TokenError('wrong device')
  }
  return claims
}
