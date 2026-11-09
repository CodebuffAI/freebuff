# Entitlement tokens

Pro is granted by a signed token, not by a server call. The worker mints the
token; the app verifies it locally with an Ed25519 public key compiled into the
binary. Consequences worth understanding:

- Pro keeps working offline, forever, on the machine that activated it.
- A compromised or impersonated worker cannot grant Pro — the signature will
  not verify.
- Revocation is a _best effort_: it applies the next time the app reaches the
  worker. An already-issued token stays valid until it expires (one year),
  which is the trade-off for offline verification.

## Format

```
base64url(claims-json) "." base64url(ed25519-signature)
```

The signature covers the **raw claims JSON bytes**, not the base64 form.

```jsonc
{
  "v": 1, // token format version
  "sub": "23bf4aa5949f17c7a84f00c0ffaaf9a1", // first 16 bytes of sha256(licenseCode), hex
  "dev": "9f1c…", // device id this token is bound to
  "ent": ["pro"], // entitlements
  "iat": 1760000000, // issued at (unix seconds)
  "exp": 1791536000, // expires at (unix seconds)
}
```

Base64 is URL-safe without padding (`URL_SAFE_NO_PAD` in Rust,
`base64url` in the worker).

### Verification rules

The app (`src-tauri/src/entitlement.rs`) checks, in order:

1. the token splits into two base64url parts,
2. the signature verifies against the embedded public key (`verify_strict`),
3. `v == 1`,
4. `exp > now`,
5. `dev` matches the local device id.

The tier is read **only** from a verified token. `tier()` in `state.rs` never
reads a serialized `tier` field, so editing `entitlement.json` by hand does
nothing.

The client additionally requires `sub` to equal `license_subject(code)` for the
code the user typed, so a token minted for someone else's purchase cannot be
pasted into a different activation.

## What a license code is

The license code is a Paddle **transaction id** — `txn_` plus 26 lowercase
base32 characters. Paddle Billing issues no license keys; license keys are a
Paddle Classic (PaddlePay) feature, and Billing's `checkout.completed` event
carries `transaction_id` rather than a key. Billing also has no
`transaction.refunded` / `transaction.chargeback` webhooks: refunds and
chargebacks arrive as a single `adjustment.created` event whose `action` is
`refund`, `chargeback`, `chargeback_warning`, or a credit.

So the flow is: `transaction.completed` mints an active record for that `txn_…`
id, and the app presents the same id to `/activate` on this device. The app
also accepts a pasted `txn_…` id from the customer's receipt for reinstalls,
which is why it shows the code in Settings with a copy button.

## Verifying a token by hand

## Keys

| Where                                                 | What                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| Worker secret `SIGNING_KEY`                           | PKCS#8 Ed25519 **private** key, base64                          |
| `tauri.conf.json` → `plugins.updater.pubkey`          | minisign public key, for **release** signatures (different key) |
| `src-tauri/src/entitlement.rs` → `DEV_PUBLIC_KEY_B64` | raw 32-byte public key, standard base64                         |

The entitlement public key can be overridden at build time:

```bash
AGENT_VOICE_ENTITLEMENT_PUBKEY="$(base64 -w0 entitlement.pub)" cargo build --release
AGENT_VOICE_WORKER_URL=https://licenses.example.com cargo build --release
```

The worker URL can also be changed at runtime in Settings.

### Development keypair

The committed pair is **development only**. Anyone with the repository can
mint Pro tokens with it; never ship a release built against it.

```
public (raw, standard base64): ouHWrlcY5+OOry5d0fMknb4il4mIIHb4n+lOhP61+K8=
private (PKCS#8, base64):      MC4CAQAwBQYDK2VwBCIEIOoHCq5N2gp01ShDliYEDZj5BjchLFHfkvI2CD3jpzvu
```

`worker/test/tokens.test.ts` asserts that the Rust constant and this pair stay
in sync, so a careless edit to one side fails the test suite.

Generate a production keypair:

```bash
# private (PKCS#8, base64) — goes into the worker secret store only
openssl genpkey -algorithm ed25519 -out key.pem
openssl pkcs8 -topk8 -nocrypt -in key.pem -outform DER | base64 -w0

# public (raw 32 bytes, base64) — compiled into the app
openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64 -w0
```

## Rotation

Rotating means old builds stop accepting new tokens. Do it deliberately:

1. Mint a new keypair as above.
2. `bunx wrangler secret put SIGNING_KEY` with the new private key.
3. Add the new public key to `public_key_b64` in the worker env and bump
   `AGENT_VOICE_ENTITLEMENT_PUBKEY` in the same release that rotates the worker
   secret. The app embeds exactly one key today, so rotation is a hard
   cutover: new tokens verify, tokens signed by the old key do not.
4. Existing installs keep working until their cached token expires — at most
   one year — because a cached token never needs the server.

If a staged rotation becomes necessary (for example because a key is
suspected of leaking), extend `entitlement.rs` to verify against a list of
keys before rotating: the format already separates "which key signed this"
from "is this signature valid", so only `verify_with_key` and the key list in
`public_key_bytes` need to change.

## Device limits

A license may be active on three devices. Activating from a fourth returns
`409`. Deactivating in the app releases the slot immediately (the worker call
is best effort — the local entitlement is cleared either way).

A device id is a random UUID generated on first launch and stored in
`device_id` in the app-data directory. Deleting that file makes the app look
like a new device, which is only useful if the old slots were released.

## Verifying a token by hand

```bash
# payload and signature
cut -d. -f1 token.txt | tr '_-' '/+' | base64 -d 2>/dev/null | jq .
cut -d. -f2 token.txt | tr '_-' '/+' | base64 -d 2>/dev/null | xxd | tail -2
```
