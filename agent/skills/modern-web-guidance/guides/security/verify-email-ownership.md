# Verify email address ownership

When collecting an email address during sign-up, sign-in, checkout, or account recovery, verifying ownership traditionally requires sending an out-of-band one-time passcode (OTP) or magic link. This forces users to leave your page, wait for email delivery, and copy codes—introducing friction, drop-off, and phishing risk, while also revealing to the email provider which relying party (RP) the user is visiting.

The **Email Verification API** (client-side HTML extension) and **Email Verification Protocol (EVP)** (backend cryptographic protocol) enable a relying party to verify that a user controls an email address without sending a verification email. The browser intermediates between the relying party and the user's email provider (the issuer):

1. The relying party includes a hidden `<input>` with `autocomplete="email-verification-token"` and a single-use cryptographic `nonce` in the same `<form>` as the email input.
2. When the user selects or enters an email address, the browser looks up the domain's `_email-verification.<domain>` DNS `TXT` record, verifies the user has an active session with the authoritative issuer, and requests an **Email Verification Token (EVT)** without disclosing the relying party's identity to the issuer.
3. The browser binds the EVT to the relying party's origin and session `nonce` in a **Key Binding JWT (KB-JWT)** signed with an ephemeral browser key pair (`EVT + KB-JWT`), populates the hidden input, and submits the form.
4. The relying party's backend verifies the cryptographic chain and, if valid, skips the email OTP or magic link step.

## 1. Enable the Origin Trial and Render the Verification Form

To participate as a verifying site (relying party):

1. **Provide the Origin Trial token** on the page hosting the form using either the `Origin-Trial` HTTP response header or a `<meta http-equiv="origin-trial">` element.
   - **Third-party origin trials:** Embedded identity SDKs can inject a third-party trial token, provided the Origin Trial registrant origin matches the issuer domain (same-site with the issuer, such as `https://issuer.example`).
2. **Generate a cryptographically random nonce per form render** with at least 128 bits of entropy (for example, `randomBytes(32).toString('base64url')` from `node:crypto`), store it in **server-side session state** keyed by an `HttpOnly`, `Secure`, `SameSite=Lax` session ID cookie (never store the expected `nonce` value directly inside a client cookie where an attacker could replay both the cookie and token), and render it into the hidden token input's `nonce` attribute. Serve the page with `Cache-Control: no-store` so back/forward navigation does not reuse an already-consumed nonce.
3. **Add the hidden token input** (`autocomplete="email-verification-token"`) inside the same `<form>` as the email input (`autocomplete="email"`).

```html
<!-- Serve with:
     Origin-Trial: <YOUR_ORIGIN_TRIAL_TOKEN>
     Cache-Control: no-store -->
<form method="POST" action="/api/verify-email">
  <label for="email">Email address:</label>
  <input
    type="email"
    id="email"
    name="email"
    autocomplete="email"
    required
  />

  <!-- MANDATORY: Must be in the same <form> as the email input.
       The nonce value must be freshly generated on the server per form render. -->
  <input
    type="hidden"
    name="token"
    nonce="SERVER_GENERATED_PER_FORM_NONCE"
    autocomplete="email-verification-token"
  />

  <button type="submit">Continue</button>
</form>
```

## 2. Verify the Submitted Token on the Server

When the form is submitted, treat the `token` field as untrusted input. Atomically read and delete the expected `nonce` from your server-side session store on receipt. If the `token` field is empty (for example, in browsers that do not support EVP or when the user is signed out of their email provider) or if verification fails, fall back immediately to your standard email OTP or magic link flow:

```javascript
// Replace with your public relying-party origin
const RP_ORIGIN = 'https://rp.example.com';

export async function handleSignupSubmission(request) {
  const formData = await request.formData();
  const submittedEmail = String(formData.get('email') || '').trim();
  const rawToken = String(formData.get('token') || '').trim();
  // Atomically read and delete the single-use nonce from server-side session state
  const expectedNonce = await consumeSessionNonce(request);

  if (rawToken && expectedNonce) {
    try {
      await verifyEmailVerificationToken({
        rawToken,
        submittedEmail,
        expectedNonce,
        expectedAudience: RP_ORIGIN,
      });
      // Fast path: email ownership is cryptographically verified; skip OTP email.
      return completeAccountCreation(submittedEmail);
    } catch (err) {
      // Log token verification failures before falling back to standard email verification.
      console.error('Email verification token check failed:', err);
    }
  }

  // Fallback path: send standard OTP code or magic link email to submittedEmail.
  return sendTraditionalVerificationEmail(submittedEmail);
}
```

Always use established SD-JWT and JOSE/JWT libraries for your backend platform (such as `@sd-jwt/core` and `jose` in Node.js, `sd-jwt-python` / `jwcrypto` in Python, or `sd-jwt-java` / Nimbus JOSE+JWT on the JVM) to implement `verifyEmailVerificationToken` rather than hand-rolling custom JWT or SD-JWT parsing code.

### Step 1: Parse the SD-JWT claims and validate the email address

After consuming the single-use `expectedNonce` from server-side session storage, decode the SD-JWT presentation (`EVT + KB-JWT`) and verify that:
- Both the issuer JWT (`jwt`) and Key Binding JWT (`kbJwt`) are present, along with the issuer claim (`iss`).
- `evtPayload.email_verified === true`.
- `evtPayload.email` matches the submitted form email using a **case-insensitive comparison** (`toLowerCase()`).

```javascript
import { createHash } from 'node:crypto';
import { decodeSdJwtSync } from '@sd-jwt/core';

const hasher = (data, alg) =>
  createHash(alg === 'sha-256' ? 'sha256' : alg).update(data).digest();

const decoded = decodeSdJwtSync(rawToken, hasher);
const evtPayload = decoded.jwt.payload;
const iss = evtPayload.iss;

if (!expectedNonce || !decoded.kbJwt || !iss || evtPayload.email_verified !== true) {
  throw new Error('Missing nonce, KB-JWT, issuer, or email_verified !== true.');
}
// MANDATORY: Compare email addresses case-insensitively
if (evtPayload.email?.toLowerCase() !== submittedEmail.toLowerCase()) {
  throw new Error('Submitted email does not match the EVT email claim.');
}
```

### Step 2: Validate DNS TXT delegation and load the issuer JWKS

Before making any network request to `iss`, verify that the submitted email's domain delegates authority to that exact issuer via a `_email-verification.<domain>` DNS `TXT` record (`iss=<issuer-host>` -> `https://<issuer-host>` with no port, path, or trailing slash). Once DNS delegation matches `iss` byte-for-byte, fetch `${iss}/.well-known/email-verification` over HTTPS, confirm that `metadata.issuer === iss`, and load the issuer's JSON Web Key Set (JWKS).

> **Note on `kid` handling:** Some major email providers (such as Gmail) omit `kid` from the EVT header. When `kid` is absent and the JWKS contains multiple keys, `jose` throws `ERR_JWKS_MULTIPLE_MATCHING_KEYS` (an `AsyncIterable` of matching `CryptoKey`s)—iterate `for await (const publicKey of err)` to trial-verify each key, as shown in Step 3.

```javascript
import dns from 'node:dns/promises';
import { createRemoteJWKSet } from 'jose';

const domain = submittedEmail.split('@')[1];
const txtRecords = (await dns.resolveTxt(`_email-verification.${domain}`)).map((r) => r.join(''));
if (!txtRecords.some((txt) => txt.startsWith('iss=') && `https://${txt.slice(4).trim()}` === iss)) {
  throw new Error(`Issuer "${iss}" is not delegated via DNS for "${domain}".`);
}

const discoveryUrl = new URL('/.well-known/email-verification', iss);
if (discoveryUrl.protocol !== 'https:') throw new Error('Issuer must use HTTPS.');
const metadata = await (await fetch(discoveryUrl)).json();
if (metadata.issuer !== iss || !metadata.jwks_uri?.startsWith('https://')) {
  throw new Error('Invalid issuer metadata or non-HTTPS jwks_uri.');
}
const issuerJwks = createRemoteJWKSet(new URL(metadata.jwks_uri));
```

### Step 3: Verify the EVT signature and Key Binding JWT (`KB-JWT`)

Finally, verify both signatures and the cryptographic binding between the two tokens using the explicit asymmetric algorithm allowlist (`['Ed25519', 'EdDSA', 'ES256']`):
1. **EVT signature (`verifier`):** Verify against `issuerJwks` (catching `ERR_JWKS_MULTIPLE_MATCHING_KEYS` to iterate candidate keys when `kid` is omitted), enforcing `iss` and a tight freshness window (`maxTokenAge: '5m'`, `clockTolerance: '1m'`).
2. **Holder binding (`kbVerifier` and `sdJwt.verify` options):** Extract the browser's ephemeral public key from `evtPayload.cnf.jwk`, confirm both `cnf.jwk.alg` and `decoded.kbJwt.header.alg` are in `ALLOWED_ALGS` and match (treating `'Ed25519'` and `'EdDSA'` as equivalent while Origin Trial implementations transition to RFC 9864 `'Ed25519'`), and verify the `KB-JWT` signature with `typ: 'kb+jwt'`. Pass `keyBindingNonce: expectedNonce`, `expectedKeyBindingAudience: expectedAudience`, and `keyBindingMaxAgeSeconds: 300` to `sdJwt.verify()`—`@sd-jwt/core` only invokes `kbVerifier` and validates `nonce`, `aud`, `iat`, and `sd_hash` when `keyBindingNonce` is supplied.

```javascript
import { SDJwtInstance } from '@sd-jwt/core';
import { importJWK, jwtVerify } from 'jose';

// IETF draft-hardt-email-verification-02 (§3.3, §5.1.1) specifies RFC 9864 'Ed25519' and 'ES256'.
// TODO: Remove 'EdDSA' once live issuers (e.g. Gmail) and Chrome Origin Trial builds finish
// transitioning from 'EdDSA' (with crv: 'Ed25519') to 'Ed25519'.
const ALLOWED_ALGS = ['Ed25519', 'EdDSA', 'ES256'];
const normalizeAlg = (alg) => (alg === 'Ed25519' ? 'EdDSA' : alg);
const evtOptions = {
  typ: 'ev+sd-jwt',
  issuer: iss,
  algorithms: ALLOWED_ALGS,
  maxTokenAge: '5m',
  clockTolerance: '1m',
};

const sdJwt = new SDJwtInstance({
  hasher,
  verifier: async (data, sig) => {
    const compactEvt = `${data}.${sig}`;
    try {
      await jwtVerify(compactEvt, issuerJwks, evtOptions);
    } catch (err) {
      // When `kid` is omitted (e.g. Gmail) and multiple keys match in the JWKS,
      // jose throws JWKSMultipleMatchingKeys, which yields each matching CryptoKey.
      if (err?.code !== 'ERR_JWKS_MULTIPLE_MATCHING_KEYS') throw err;
      let matched = false;
      for await (const publicKey of err) {
        try {
          await jwtVerify(compactEvt, publicKey, evtOptions);
          matched = true;
          break;
        } catch {}
      }
      if (!matched) throw err;
    }
    return true;
  },
  kbVerifier: async (data, sig) => {
    const holderJwk = evtPayload.cnf?.jwk;
    const holderAlg = holderJwk?.alg;
    const kbAlg = decoded.kbJwt.header.alg;
    if (
      !holderAlg ||
      !kbAlg ||
      !ALLOWED_ALGS.includes(holderAlg) ||
      !ALLOWED_ALGS.includes(kbAlg) ||
      normalizeAlg(kbAlg) !== normalizeAlg(holderAlg)
    ) {
      throw new Error('Missing, disallowed, or mismatched KB-JWT algorithm.');
    }
    const holderKey = await importJWK(holderJwk, kbAlg);
    await jwtVerify(`${data}.${sig}`, holderKey, {
      typ: 'kb+jwt',
      audience: expectedAudience,
      algorithms: [kbAlg],
      maxTokenAge: '5m',
      clockTolerance: '1m',
    });
    return true;
  },
});

const verified = await sdJwt.verify(rawToken, {
  requiredClaimKeys: ['email', 'email_verified'],
  keyBindingNonce: expectedNonce,
  expectedKeyBindingAudience: expectedAudience,
  keyBindingMaxAgeSeconds: 300,
  skewSeconds: 60,
});
```

## Best practices

- **DO** perform all token verification strictly on the server. **DO NOT** validate tokens in client-side JavaScript or trust any client-side verification state—client-side checks can be trivially bypassed or forged and provide zero trust guarantee to the relying party.
- **DO** use established SD-JWT and JOSE/JWT libraries for your backend platform (for example, `@sd-jwt/core` and `jose` in Node.js) to parse and validate the `EVT~KB-JWT` presentation, and pass `keyBindingNonce` to `sdJwt.verify()` so Key Binding verification cannot be bypassed. **DO NOT** hand-roll custom JWT, SD-JWT, or `sd_hash` parsing and signature verification routines.
- **DO** generate a fresh cryptographic `nonce` (at least 128 bits, such as `randomBytes(32).toString('base64url')`) on the server for each form render, store it in **server-side session state** (not directly in a client cookie), and serve the form page with `Cache-Control: no-store`.
- **DO** atomically read and delete the expected `nonce` from server-side session storage immediately when the `POST` request arrives so an intercepted token cannot be replayed.
- **DO** perform a **case-insensitive comparison** between `evtPayload.email` and the submitted form email address (`email.toLowerCase()`), while preserving the submitted email string.
- **DO** trial-verify all keys in the issuer's JWKS when `kid` is absent from the EVT header (providers such as Gmail omit `kid`).
- **DO** verify DNS delegation (`_email-verification.<domain>`) before trusting any `iss` claim in an EVT, and confirm `metadata.issuer === iss` in the `.well-known/email-verification` response.
- **DO NOT** treat email ownership verification as proof of inbox deliverability. EVP proves that the user controls the email account with the authoritative provider; still send transactional welcome emails and handle bounces normally.
- **DO NOT** block account creation or sign-in when `token` is empty or when verification fails—always degrade gracefully to your standard email OTP or magic link flow.

## Fallback strategy

Email Verification (`autocomplete="email-verification-token"`) is designed as a **progressive enhancement** over traditional out-of-band email verification (OTP codes or magic links):

- **Unsupported browsers:** Browsers that do not support `autocomplete="email-verification-token"` ignore the hidden input and submit the form with an empty `token` value.
- **Unauthenticated or non-participating email domains:** When a user enters an email address whose domain does not publish an `_email-verification` DNS `TXT` record, or when the user does not have an active session with their email provider in the browser, the browser submits the form with an empty `token`.
- **Expired or invalid tokens:** If the `nonce` has expired, was already consumed, or fails any step of `verifyEmailVerificationToken` in `handleSignupSubmission`, the server catches the error and sends a traditional OTP or magic link email without interrupting the user's sign-up or sign-in flow.
