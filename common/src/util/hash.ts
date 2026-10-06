/**
 * Lowercase hex SHA-256 of a UTF-8 string, for runtimes without
 * `node:crypto` (Convex V8 functions, the browser) and code shared between
 * them and Node. Both functions give the same digest as
 * `createHash('sha256').update(text, 'utf8').digest('hex')`, lone surrogates
 * included (all three encode them as U+FFFD).
 *
 * `sha256HexAsync` uses native WebCrypto; prefer it wherever the caller can
 * await. `sha256Hex` is synchronous pure JavaScript, 3-10x slower than native
 * (Node 26: 4 us vs 0.6 us for 1 KB, 211 us vs 22 us for 64 KB). Node and Bun
 * code that needs a synchronous hash keeps `createHash`.
 */

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** Lowercase hex SHA-256 of `text` encoded as UTF-8. */
export function sha256Hex(text: string): string {
  return sha256BytesHex(new TextEncoder().encode(text))
}

/**
 * The same digest from WebCrypto (`crypto.subtle`), which is native in every
 * runtime here: Convex V8, browsers, Node and Bun. Prefer it to
 * {@link sha256Hex} wherever the caller can await.
 */
export async function sha256HexAsync(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  )
  let hex = ''
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

/** Lowercase hex SHA-256 of raw bytes. */
function sha256BytesHex(bytes: Uint8Array): string {
  // Words stay int32 (`| 0`) throughout: unsigned (`>>> 0`) intermediates
  // above 2^31 fall out of the engines' small-integer fast path.
  const H = new Int32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ])
  const length = bytes.length
  const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6)
  padded.set(bytes)
  padded[length] = 0x80
  // The message length in bits, as a big-endian 64-bit integer.
  const high = Math.floor(length / 0x20000000)
  const low = (length << 3) >>> 0
  const end = padded.length
  padded[end - 8] = high >>> 24
  padded[end - 7] = high >>> 16
  padded[end - 6] = high >>> 8
  padded[end - 5] = high
  padded[end - 4] = low >>> 24
  padded[end - 3] = low >>> 16
  padded[end - 2] = low >>> 8
  padded[end - 1] = low

  const w = new Int32Array(64)
  for (let offset = 0; offset < end; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4
      w[i] =
        (padded[j]! << 24) |
        (padded[j + 1]! << 16) |
        (padded[j + 2]! << 8) |
        padded[j + 3]!
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!
      const y = w[i - 2]!
      const s0 =
        ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)
      const s1 =
        ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0
    }
    let a = H[0]!
    let b = H[1]!
    let c = H[2]!
    let d = H[3]!
    let e = H[4]!
    let f = H[5]!
    let g = H[6]!
    let h = H[7]!
    for (let i = 0; i < 64; i++) {
      const S1 =
        ((e >>> 6) | (e << 26)) ^
        ((e >>> 11) | (e << 21)) ^
        ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + K[i]! + w[i]!) | 0
      const S0 =
        ((a >>> 2) | (a << 30)) ^
        ((a >>> 13) | (a << 19)) ^
        ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) | 0
      h = g
      g = f
      f = e
      e = (d + temp1) | 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) | 0
    }
    H[0] = (H[0]! + a) | 0
    H[1] = (H[1]! + b) | 0
    H[2] = (H[2]! + c) | 0
    H[3] = (H[3]! + d) | 0
    H[4] = (H[4]! + e) | 0
    H[5] = (H[5]! + f) | 0
    H[6] = (H[6]! + g) | 0
    H[7] = (H[7]! + h) | 0
  }
  let hex = ''
  for (let i = 0; i < 8; i++) {
    hex += (H[i]! >>> 0).toString(16).padStart(8, '0')
  }
  return hex
}
