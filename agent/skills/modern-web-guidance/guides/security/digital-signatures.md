# Sign and verify data with WebCrypto

Use the Web Cryptography API (`crypto.subtle`) to sign and verify messages, tokens, or artifacts in the browser using quantum-resistant (ML-DSA) or classical (`'Ed25519'`, `'ECDSA'`) asymmetric keys. Digital signatures guarantee data integrity and signer authenticity without requiring shared secret keys. For establishing shared secrets and encrypting confidential payloads, see `client-side-encryption` (via `npx -y modern-web-guidance@latest retrieve "client-side-encryption"`).

## 1. Choose an algorithm and generate a key pair

ML-DSA (Module-Lattice-Based Digital Signature Algorithm, standardized in NIST FIPS 204) provides post-quantum lattice-based digital signatures resistant to attacks by both classical and quantum computers.

Use **`'ML-DSA-65'`** by default for general-purpose signing. Choose `'ML-DSA-44'` when you need smaller public keys and signatures over bandwidth-constrained channels and 128-bit security is sufficient, or `'ML-DSA-87'` when a security policy requires NIST Category 5 (CNSA 2.0) compliance.

| Algorithm name | Security level & use case | Public key (`'raw-public'`) | Signature size |
|---|---|---|---|
| `'ML-DSA-44'` | NIST Category 2 (~128-bit security); smallest keys and signatures | 1312 bytes | 2420 bytes |
| **`'ML-DSA-65'`** | **NIST Category 3 (~192-bit security); recommended default** | 1952 bytes | 3309 bytes |
| `'ML-DSA-87'` | NIST Category 5 (~256-bit security); highest security margin | 2592 bytes | 4627 bytes |

- Pass `'ML-DSA-44'`, `'ML-DSA-65'`, or `'ML-DSA-87'` as the algorithm name (pre-standardization names such as `'Dilithium'` or `'CRYSTALS-Dilithium'` throw `NotSupportedError`).
- Neither ML-DSA nor `'Ed25519'` takes a `hash` parameter.
- Pass `['sign', 'verify']` when generating a key pair with `generateKey()`:

```javascript
const signerKeyPair = await crypto.subtle.generateKey(
  'ML-DSA-65',
  false,
  ['sign', 'verify'],
);
```

## 2. Export and import keys

`'ML-DSA-44'`, `'ML-DSA-65'`, and `'ML-DSA-87'` **reject the legacy `'raw'` format** in `importKey()` and `exportKey()` with a `NotSupportedError`. Always export or import keys using an explicit format:

- **`'raw-public'`**: Public key bytes (`1312`, `1952`, or `2592` bytes). Pass `['verify']` as the key usage when importing a public key.
- **`'raw-seed'`**: 32-byte private key seed for all three ML-DSA algorithms. Both `'raw'` and `'raw-private'` throw `NotSupportedError` on ML-DSA—store or transmit private keys using `'raw-seed'`, `'pkcs8'` (54 bytes), or `'jwk'` (`kty: 'AKP'`). Pass `['sign']` as the key usage when importing a private key (passing `['sign', 'verify']` to `importKey()` throws `SyntaxError`).
- **`'spki'`, `'pkcs8'`, and `'jwk'`**: Supported for all three ML-DSA algorithms.

Always export the verification public key with `'raw-public'` so the public key bytes can be serialized or shared with verifiers:

```javascript
// Export the public key bytes on the signer
const publicKeyBytes = await crypto.subtle.exportKey(
  'raw-public',
  signerKeyPair.publicKey,
);

// Import the public key bytes on the verifier (usage must be ['verify'] only)
const verifierPublicKey = await crypto.subtle.importKey(
  'raw-public',
  publicKeyBytes,
  'ML-DSA-65',
  true,
  ['verify'],
);
```

If you only hold a private signing `CryptoKey` (even with `extractable: false`) and need its corresponding public `CryptoKey`, call `crypto.subtle.getPublicKey()` with `['verify']`:

```javascript
const publicKey = await crypto.subtle.getPublicKey(
  signerKeyPair.privateKey,
  ['verify'],
);
```

## 3. Sign and verify payloads

Call `crypto.subtle.sign()` with the private key to produce a signature, and `crypto.subtle.verify()` with the public key to check it:

```javascript
const payloadBytes = new TextEncoder().encode(
  '{"artifact":"release-v2.4.0.tar.gz","sha256":"9f86d08..."}',
);

const signatureBuffer = await crypto.subtle.sign(
  'ML-DSA-65',
  signerKeyPair.privateKey,
  payloadBytes,
);

const isValid = await crypto.subtle.verify(
  'ML-DSA-65',
  verifierPublicKey,
  signatureBuffer,
  payloadBytes,
);
```

### Domain separation with `ContextParams`

To prevent a signature created for one purpose from being replayed in another part of your application or protocol that shares the same key pair, bind the signature to a domain-separation `context`.

Instead of a bare algorithm name string, pass a `ContextParams` dictionary (`{ name, context }`) to `sign()` and `verify()`, where `context` is a `BufferSource` (`Uint8Array` or `ArrayBuffer`):

```javascript
const contextBytes = new TextEncoder().encode('release-manifest-v1');

const signatureBuffer = await crypto.subtle.sign(
  {
    name: 'ML-DSA-65',
    context: contextBytes,
  },
  signerKeyPair.privateKey,
  payloadBytes,
);

const isValid = await crypto.subtle.verify(
  {
    name: 'ML-DSA-65',
    context: contextBytes,
  },
  verifierPublicKey,
  signatureBuffer,
  payloadBytes,
);
```

- **255-byte limit**: `context` accepts `0` to `255` bytes (omitting `context` is equivalent to passing an empty `new Uint8Array(0)`). Passing more than `255` bytes rejects with `OperationError`.
- **Exact match required**: `crypto.subtle.verify()` returns `true` only when the verifier passes the exact same `context` bytes used during `crypto.subtle.sign()`.

## Fallback strategies

Baseline status for Web Cryptography: Widely available. It's been Baseline since 2017-09-19.
Supported by: Chrome 37 (Aug 2014), Edge 12 (Jul 2015), Firefox 34 (Dec 2014), and Safari 11 (Sep 2017).

Baseline status for the api.SubtleCrypto.sign.ed25519 capability: Newly available. It's been Baseline since 2025-05-29.
Supported by: Chrome 137 (May 2025), Edge 137 (May 2025), Firefox 129 (Aug 2024), and Safari 17 (Sep 2023).

If your Baseline target does not yet support `SubtleCrypto.supports()` or ML-DSA, detect support using the **static** `SubtleCrypto.supports()` method and fall back to classical `'Ed25519'` (or `'ECDSA'` with `'P-256'` and `'SHA-256'` when targeting browsers prior to `'Ed25519'` support):

- **Call `SubtleCrypto.supports()` on the `SubtleCrypto` constructor, not on `crypto.subtle`**: `globalThis.SubtleCrypto?.supports?.('sign', 'ML-DSA-65')` is a synchronous static method returning a boolean (`crypto.subtle.supports` is `undefined`). Probe `'sign'`, `'verify'`, `'generateKey'`, `'importKey'`, `'exportKey'`, or `'getPublicKey'` (or pass a `ContextParams` dictionary such as `SubtleCrypto.supports('sign', { name: 'ML-DSA-65', context })`).
- **Key format in the fallback (`'raw'`)**: While browsers that support Modern WebCrypto also accept `'raw-public'` on `'Ed25519'` and `'ECDSA'`, use `'raw'` in fallback paths targeting older browsers.
- **Domain separation in the fallback**: Classical WebCrypto algorithms (`'Ed25519'` and `'ECDSA'`) do not read a `context` property from the algorithm dictionary (WebIDL silently ignores unknown dictionary properties on `Algorithm` and `EcdsaParams`). Prepend a length-prefixed `context` header to the payload in your fallback path so domain separation behaves consistently across both suites.

```javascript
const ML_DSA_PUBLIC_KEY_ALGORITHMS = {
  1312: 'ML-DSA-44',
  1952: 'ML-DSA-65',
  2592: 'ML-DSA-87',
};

export function supportsPostQuantumSignatures() {
  return (
    typeof globalThis.SubtleCrypto?.supports === 'function' &&
    SubtleCrypto.supports('sign', 'ML-DSA-65')
  );
}

export async function generateSigningKeyPair() {
  if (supportsPostQuantumSignatures()) {
    const keyPair = await crypto.subtle.generateKey('ML-DSA-65', false, ['sign', 'verify']);
    const publicKeyBytes = new Uint8Array(
      await crypto.subtle.exportKey('raw-public', keyPair.publicKey),
    );
    return {
      suite: 'ML-DSA-65',
      keyFormat: 'raw-public',
      keyPair,
      publicKeyBytes,
    };
  }

  // Classical fallback: Ed25519
  const keyPair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  return {
    suite: 'Ed25519',
    keyFormat: 'raw',
    keyPair,
    publicKeyBytes,
  };
}

function frameFallbackInput(payloadBytes, contextBytes) {
  if (contextBytes.byteLength > 255) {
    throw new DOMException('Context must not exceed 255 bytes', 'OperationError');
  }
  const framed = new Uint8Array(1 + contextBytes.byteLength + payloadBytes.byteLength);
  framed[0] = contextBytes.byteLength;
  framed.set(contextBytes, 1);
  framed.set(payloadBytes, 1 + contextBytes.byteLength);
  return framed;
}

export async function signPayload(
  privateKey,
  payloadBytes,
  contextBytes = new Uint8Array(0),
) {
  if (privateKey.algorithm.name.startsWith('ML-DSA')) {
    const sig = await crypto.subtle.sign(
      { name: privateKey.algorithm.name, context: contextBytes },
      privateKey,
      payloadBytes,
    );
    return new Uint8Array(sig);
  }

  const framed = frameFallbackInput(payloadBytes, contextBytes);
  const sig = await crypto.subtle.sign('Ed25519', privateKey, framed);
  return new Uint8Array(sig);
}

export async function verifyPayload(
  publicKeyOrBytes,
  signatureBytes,
  payloadBytes,
  contextBytes = new Uint8Array(0),
) {
  const publicKey =
    publicKeyOrBytes instanceof CryptoKey
      ? publicKeyOrBytes
      : await (() => {
          const bytes =
            publicKeyOrBytes instanceof Uint8Array
              ? publicKeyOrBytes
              : new Uint8Array(publicKeyOrBytes);
          const mlDsaName = ML_DSA_PUBLIC_KEY_ALGORITHMS[bytes.byteLength];
          return mlDsaName
            ? crypto.subtle.importKey('raw-public', bytes, mlDsaName, true, ['verify'])
            : crypto.subtle.importKey('raw', bytes, 'Ed25519', true, ['verify']);
        })();

  if (publicKey.algorithm.name.startsWith('ML-DSA')) {
    return crypto.subtle.verify(
      { name: publicKey.algorithm.name, context: contextBytes },
      publicKey,
      signatureBytes,
      payloadBytes,
    );
  }

  const framed = frameFallbackInput(payloadBytes, contextBytes);
  return crypto.subtle.verify('Ed25519', publicKey, signatureBytes, framed);
}
```
