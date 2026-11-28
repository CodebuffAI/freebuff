# Encrypt data client-side with WebCrypto

Use the Web Cryptography API (`crypto.subtle`) to establish shared secrets over untrusted networks using quantum-resistant Key Encapsulation Mechanisms (KEMs) or classical key agreement, and encrypt sensitive data in the browser with Authenticated Encryption with Associated Data (AEAD). For signing and verifying messages or artifacts without encrypting them, see `digital-signatures` (via `npx -y modern-web-guidance@latest retrieve "digital-signatures"`).

An end-to-end envelope encryption flow splits into two phases:

- **One-time recipient setup (Steps 1–2)**: The recipient generates a key pair, persists the `CryptoKeyPair` in IndexedDB for future sessions, and exports the public key (`'raw-public'`) to share with senders.
- **Per-message encryption (Steps 3–4)**: For each payload, the sender imports the recipient's public key, calls `encapsulateKey()` to generate a fresh one-time shared key and ciphertext capsule, encrypts the payload with a fresh 12-byte IV, and sends `{ capsule, iv, ciphertext }` to the recipient.

## 1. Choose a KEM algorithm and generate a recipient key pair

Unlike Diffie-Hellman key agreement (`deriveKey()`), where both parties combine their keys, a Key Encapsulation Mechanism (KEM) uses the recipient's public key to generate both a random shared secret and a ciphertext capsule in a single `encapsulateKey()` call. The recipient recovers the same shared key from the ciphertext capsule using `decapsulateKey()`.

Use **`'MLKEM768-X25519'`** by default: it combines post-quantum ML-KEM (standardized in NIST FIPS 203) with classical `'X25519'` so the shared secret remains secure as long as either algorithm holds. Choose standalone `'ML-KEM-768'` when a policy requires pure FIPS 203 output without a hybrid component, or `'ML-KEM-1024'` when a policy requires NIST Category 5 (CNSA 2.0) compliance.

| Algorithm name | Security level & use case | Public key (`'raw-public'`) | Private seed (`'raw-seed'`) | Ciphertext size |
|---|---|---|---|---|
| **`'MLKEM768-X25519'`** | **Hybrid post-quantum (`'ML-KEM-768'`) + classical (`'X25519'`); recommended default** | 1216 bytes | 32 bytes | 1120 bytes |
| `'ML-KEM-768'` | NIST Category 3 (~192-bit security); standalone post-quantum KEM | 1184 bytes | 64 bytes | 1088 bytes |
| `'ML-KEM-1024'` | NIST Category 5 (~256-bit security); highest security margin | 1568 bytes | 64 bytes | 1568 bytes |

- Pass `'MLKEM768-X25519'`, `'ML-KEM-768'`, or `'ML-KEM-1024'` as the algorithm name (aliases such as `'X-Wing'` or `'X25519MLKEM768'`, as well as `'ML-KEM-512'`, throw `NotSupportedError`).
- Pass `extractable: false` and `['encapsulateKey', 'decapsulateKey']` (or `['encapsulateBits', 'decapsulateBits']`) when generating a KEM key pair. Non-extractable `CryptoKey` and `CryptoKeyPair` objects can be persisted across sessions directly in IndexedDB via structured cloning (`objectStore.put(recipientKeyPair, 'recipient-kem-key')`) without ever exporting the private key bytes:

```javascript
const recipientKeyPair = await crypto.subtle.generateKey(
  'MLKEM768-X25519',
  false,
  ['encapsulateKey', 'decapsulateKey'],
);
```

## 2. Export and import keys

Modern WebCrypto algorithms (`'MLKEM768-X25519'`, `'ML-KEM-768'`, `'ML-KEM-1024'`, and `'ChaCha20-Poly1305'`) **reject the legacy `'raw'` format** in `importKey()` and `exportKey()` with a `NotSupportedError`. Always specify the explicit key format:

- **`'raw-public'`**: Public key bytes (`1216`, `1184`, or `1568` bytes). Pass `['encapsulateKey']` (or `['encapsulateBits']`) when importing a KEM public key.
- **`'raw-seed'`**: Private key seed bytes (`32` bytes for `'MLKEM768-X25519'`; `64` bytes for `'ML-KEM-768'` and `'ML-KEM-1024'`). Pass `['decapsulateKey']` (or `['decapsulateBits']`) when importing a KEM private key (passing `['encapsulateKey', 'decapsulateKey']` to `importKey()` or `getPublicKey()` throws `SyntaxError`). Both `'raw'` and `'raw-private'` throw `NotSupportedError` on KEM private keys. Note that `'MLKEM768-X25519'` only supports `'raw-public'`, `'raw-seed'`, and `'jwk'`—it does **not** support `'spki'` or `'pkcs8'`.
- **`'raw-secret'`**: Symmetric secret key bytes (`'ChaCha20-Poly1305'`, and accepted on `'AES-GCM'` and `'HKDF'`).

Export the recipient's public key with `'raw-public'` so the public key bytes can be serialized (for example, as Base64 via `new Uint8Array(recipientPublicKeyBytes).toBase64()` or hex) and shared with senders:

```javascript
// Export the recipient's public key bytes
const recipientPublicKeyBytes = await crypto.subtle.exportKey(
  'raw-public',
  recipientKeyPair.publicKey,
);

// Import the recipient's public key on the sender (usage must be ['encapsulateKey'])
const importedPublicKey = await crypto.subtle.importKey(
  'raw-public',
  recipientPublicKeyBytes,
  'MLKEM768-X25519',
  true,
  ['encapsulateKey'],
);
```

If you only hold a private `CryptoKey` (even with `extractable: false`) and need its corresponding public `CryptoKey`, call `crypto.subtle.getPublicKey()`:

```javascript
const publicKey = await crypto.subtle.getPublicKey(
  recipientKeyPair.privateKey,
  ['encapsulateKey'],
);
```

## 3. Encapsulate and decapsulate a shared key

`encapsulateKey()` and `decapsulateKey()` import the 32-byte (256-bit) KEM shared secret into a `CryptoKey` using the algorithm specified in `sharedKeyAlgorithm` (with `'raw-secret'` format). Pass `'ChaCha20-Poly1305'` or `'AES-GCM'` directly to produce an AEAD encryption key:

```javascript
// Sender encapsulates a 256-bit AEAD key and produces a ciphertext capsule
const { sharedKey: senderKey, ciphertext: encapsulatedCiphertext } =
  await crypto.subtle.encapsulateKey(
    'MLKEM768-X25519',
    importedPublicKey,
    'ChaCha20-Poly1305', // Or 'AES-GCM'
    false,
    ['encrypt', 'decrypt'],
  );

// Recipient decapsulates the ciphertext capsule to recover the identical AEAD key
const recipientKey = await crypto.subtle.decapsulateKey(
  'MLKEM768-X25519',
  recipientKeyPair.privateKey,
  encapsulatedCiphertext,
  'ChaCha20-Poly1305',
  false,
  ['encrypt', 'decrypt'],
);
```

### Domain separation with `'HKDF'`

To bind the shared key to a specific protocol context (`info` and `salt`) or derive multiple subkeys from a single encapsulation, pass `'HKDF'` as `sharedKeyAlgorithm` with `['deriveKey']` usage, then call `crypto.subtle.deriveKey()`:

```javascript
const { sharedKey: hkdfBaseKey, ciphertext } = await crypto.subtle.encapsulateKey(
  'MLKEM768-X25519',
  importedPublicKey,
  'HKDF',
  false,
  ['deriveKey'],
);

const aeadKey = await crypto.subtle.deriveKey(
  {
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new Uint8Array(32),
    info: new TextEncoder().encode('envelope-v1'),
  },
  hkdfBaseKey,
  { name: 'AES-GCM', length: 256 },
  false,
  ['encrypt', 'decrypt'],
);
```

## 4. Encrypt and decrypt payloads (`'ChaCha20-Poly1305'` and `'AES-GCM'`)

Encrypt payload data with an AEAD algorithm (`'ChaCha20-Poly1305'` or `'AES-GCM'`) using a fresh, cryptographically random **12-byte (96-bit) initialization vector (`iv`)** for every encryption operation. Never reuse an `(iv, key)` pair. Choose `'ChaCha20-Poly1305'` for consistent constant-time performance across devices without dedicated AES hardware acceleration, or `'AES-GCM'` when interoperating with existing WebCrypto or FIPS 140 deployments.

- **`'ChaCha20-Poly1305'`**: Uses a fixed 256-bit (32-byte) key (`generateKey('ChaCha20-Poly1305', extractable, ['encrypt', 'decrypt'])` takes a string or `{ name: 'ChaCha20-Poly1305' }` with **no `length` property**). The `iv` must be exactly 12 bytes, and the 128-bit Poly1305 authentication tag is appended to the ciphertext.
- **`'AES-GCM'`**: Pass `{ name: 'AES-GCM', length: 256 }` when calling `generateKey()` or `deriveKey()`, and a 12-byte `iv` when calling `encrypt()` and `decrypt()`.
- **`additionalData` (AAD)**: Bind unencrypted metadata (such as a record ID, recipient ID, or protocol version) to the authentication tag via `additionalData` so tampering with either the ciphertext or the metadata causes `decrypt()` to reject with `OperationError`.

```javascript
/**
 * Encrypts UTF-8 text with an AEAD CryptoKey ('ChaCha20-Poly1305' or 'AES-GCM').
 * @param {CryptoKey} key
 * @param {string} plaintext
 * @param {Uint8Array} [additionalData]
 */
export async function encryptMessage(key, plaintext, additionalData = new Uint8Array(0)) {
  // Always generate a fresh 12-byte (96-bit) IV per message
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertextBuffer = await crypto.subtle.encrypt(
    {
      name: key.algorithm.name,
      iv,
      additionalData,
    },
    key,
    encoded,
  );

  return { iv, ciphertext: new Uint8Array(ciphertextBuffer) };
}

/**
 * Decrypts and authenticates an AEAD payload. Throws OperationError if tampered.
 * @param {CryptoKey} key
 * @param {Uint8Array} iv
 * @param {Uint8Array} ciphertext
 * @param {Uint8Array} [additionalData]
 */
export async function decryptMessage(key, iv, ciphertext, additionalData = new Uint8Array(0)) {
  const plaintextBuffer = await crypto.subtle.decrypt(
    {
      name: key.algorithm.name,
      iv,
      additionalData,
    },
    key,
    ciphertext,
  );

  return new TextDecoder().decode(plaintextBuffer);
}
```

## Fallback strategies

Baseline status for Web Cryptography: Widely available. It's been Baseline since 2017-09-19.
Supported by: Chrome 37 (Aug 2014), Edge 12 (Jul 2015), Firefox 34 (Dec 2014), and Safari 11 (Sep 2017).

Baseline status for the api.SubtleCrypto.deriveBits.x25519 capability: Newly available. It's been Baseline since 2025-02-06.
Supported by: Chrome 133 (Feb 2025), Edge 133 (Feb 2025), Firefox 130 (Sep 2024), and Safari 17 (Sep 2023).

If your Baseline target does not yet support `SubtleCrypto.supports()`, `encapsulateKey()`, or `'ChaCha20-Poly1305'`, detect support using the **static** `SubtleCrypto.supports()` method and fall back to ephemeral-static Diffie-Hellman key agreement (`'X25519'` + `'HKDF'` + `'AES-GCM'`, or `'ECDH'` with `'P-256'` when targeting browsers prior to `'X25519'` support):

- **Call `SubtleCrypto.supports()` on the `SubtleCrypto` constructor, not on `crypto.subtle`**: `globalThis.SubtleCrypto?.supports?.('encapsulateKey', 'MLKEM768-X25519', 'ChaCha20-Poly1305')` is a synchronous static method returning a boolean (`crypto.subtle.supports` is `undefined`). Note that `SubtleCrypto.supports()` validates operation-specific parameters: bare algorithm strings work for `'encapsulateKey'`, `'decapsulateKey'`, `'generateKey'`, `'importKey'`, `'exportKey'`, and `'getPublicKey'`, whereas probing `'encrypt'` or `'decrypt'` directly requires an `iv` (for example, `SubtleCrypto.supports('encrypt', { name: 'ChaCha20-Poly1305', iv: new Uint8Array(12) })`).
- **Key format in the fallback (`'raw'`)**: While browsers that support Modern WebCrypto also accept `'raw-public'` on `'X25519'` and `'ECDH'`, use `'raw'` in fallback paths targeting older browsers.
- **Classical fallback (`'X25519'` + `'HKDF'` + `'AES-GCM'`)**: When `SubtleCrypto.supports()` is unavailable or returns `false`, generate an ephemeral `'X25519'` key pair for the sender, export the ephemeral public key as the capsule bytes, derive 256 bits via `deriveBits({ name: 'X25519', public: peerPublicKey }, privateKey, 256)`, and pass those bits through `'HKDF'` (`'SHA-256'`) to derive a 256-bit `'AES-GCM'` key.

```javascript
const KEM_PUBLIC_KEY_ALGORITHMS = {
  1184: 'ML-KEM-768',
  1216: 'MLKEM768-X25519',
  1568: 'ML-KEM-1024',
};

export function supportsPostQuantumEnvelope() {
  return (
    typeof globalThis.SubtleCrypto?.supports === 'function' &&
    SubtleCrypto.supports('encapsulateKey', 'MLKEM768-X25519', 'ChaCha20-Poly1305')
  );
}

export async function generateRecipientKeys() {
  if (supportsPostQuantumEnvelope()) {
    const keyPair = await crypto.subtle.generateKey(
      'MLKEM768-X25519',
      false,
      ['encapsulateKey', 'decapsulateKey'],
    );
    const publicKeyBytes = new Uint8Array(
      await crypto.subtle.exportKey('raw-public', keyPair.publicKey),
    );
    return { suite: 'MLKEM768-X25519+ChaCha20-Poly1305', keyPair, publicKeyBytes };
  }

  // Classical fallback: X25519 key agreement + HKDF + AES-GCM
  const keyPair = await crypto.subtle.generateKey('X25519', false, ['deriveBits']);
  const publicKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', keyPair.publicKey),
  );
  return { suite: 'X25519+HKDF+AES-GCM', keyPair, publicKeyBytes };
}

async function deriveFallbackAesKey(privateKey, peerPublicKey, infoBytes = new Uint8Array(0)) {
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'X25519', public: peerPublicKey },
    privateKey,
    256,
  );
  const hkdfKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: infoBytes,
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encapsulateEnvelopeKey(
  recipientPublicKeyOrBytes,
  infoBytes = new Uint8Array(0),
) {
  const pubKey =
    recipientPublicKeyOrBytes instanceof CryptoKey
      ? recipientPublicKeyOrBytes
      : await (() => {
          const bytes =
            recipientPublicKeyOrBytes instanceof Uint8Array
              ? recipientPublicKeyOrBytes
              : new Uint8Array(recipientPublicKeyOrBytes);
          const kemName = KEM_PUBLIC_KEY_ALGORITHMS[bytes.byteLength];
          return kemName
            ? crypto.subtle.importKey('raw-public', bytes, kemName, true, ['encapsulateKey'])
            : crypto.subtle.importKey('raw', bytes, 'X25519', true, []);
        })();

  if (pubKey.algorithm.name !== 'X25519') {
    const { sharedKey, ciphertext } = await crypto.subtle.encapsulateKey(
      pubKey.algorithm.name,
      pubKey,
      'ChaCha20-Poly1305',
      false,
      ['encrypt', 'decrypt'],
    );
    return { sharedKey, capsuleBytes: new Uint8Array(ciphertext) };
  }

  // Classical fallback: generate ephemeral X25519 key pair and send ephemeral public key as capsule
  const ephemeral = await crypto.subtle.generateKey('X25519', false, ['deriveBits']);
  const capsuleBytes = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const sharedKey = await deriveFallbackAesKey(ephemeral.privateKey, pubKey, infoBytes);
  return { sharedKey, capsuleBytes };
}

export async function decapsulateEnvelopeKey(
  recipientPrivateKey,
  capsuleBytes,
  infoBytes = new Uint8Array(0),
) {
  if (recipientPrivateKey.algorithm.name !== 'X25519') {
    return crypto.subtle.decapsulateKey(
      recipientPrivateKey.algorithm.name,
      recipientPrivateKey,
      capsuleBytes,
      'ChaCha20-Poly1305',
      false,
      ['encrypt', 'decrypt'],
    );
  }

  const ephemeralPubKey = await crypto.subtle.importKey('raw', capsuleBytes, 'X25519', true, []);
  return deriveFallbackAesKey(recipientPrivateKey, ephemeralPubKey, infoBytes);
}
```
