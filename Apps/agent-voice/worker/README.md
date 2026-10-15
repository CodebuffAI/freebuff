# License worker

Cloudflare Worker + KV that turns a paid Paddle transaction into a signed
entitlement token. See [`../docs/entitlement.md`](../docs/entitlement.md) for
the token format and key rotation.

**The license code is a Paddle transaction id.** Paddle _Billing_ issues no
license keys — that is a Paddle Classic (PaddlePay) feature, and Billing's
`checkout.completed` event carries `transaction_id`, not a key. So the `txn_…`
id from the receipt is both what the customer holds and what every record is
filed under. The app activates straight from `checkout.completed`; on a new
machine the customer pastes the same `txn_…` id.

## Routes

| Route              | Purpose                                                     |
| ------------------ | ----------------------------------------------------------- |
| `POST /activate`   | `{licenseCode, deviceId}` → `{token}`; claims a device slot |
| `POST /deactivate` | `{licenseCode, deviceId}` → `{ok}`; releases the slot       |
| `POST /webhook`    | Paddle events (HMAC verified); activates or revokes         |
| `GET /health`      | liveness                                                    |

Status codes the app understands: `400` malformed code, `403/404` unknown
purchase, `409` device cap, `410` revoked, `429` rate limited.

## Signature verification

Paddle sends only two relevant headers, and the contract is easy to get wrong:

```
Paddle-Signature: ts=<unix seconds>;h1=<hex digest>

h1 = HMAC-SHA256(secret, `<ts>:` + <raw request body>)
```

Consequences the worker honours:

- The **timestamp** is part of the signed bytes, not just the body — signing
  the body alone, or the event type plus the body, produces a digest Paddle
  never sends.
- There is **no event-type header**. `event_type` is a field in the payload, so
  it can only be read _after_ the signature verifies.
- The body must be read as raw bytes and verified before any parsing or
  re-serialising; whitespace changes the digest.
- `h1` is compared in constant time, and `ts` must be within
  `SIGNATURE_TOLERANCE_SECONDS` (5 minutes) of now to blunt replay. Paddle's
  own SDKs use 5 seconds; the wider window buys delivery headroom because every
  action here is idempotent.

Reference: <https://developer.paddle.com/webhooks/signature-verification>.
Verified against Paddle's own webhook simulator, which is how the original
`eventType:body` implementation was caught.

## Deploy

```bash
cd worker
bunx wrangler kv namespace create LICENSES     # paste the id into wrangler.toml
bunx wrangler secret put SIGNING_KEY          # PKCS#8 Ed255Y19 private key, base64
bunx wrangler secret put PADDLE_WEBHOOK_SECRET
bunx wrangler deploy
```

The zone id in `wrangler.toml` is a placeholder on purpose — every deployer
pastes their own. Nothing else in the repo is tied to one account.

### Custom domains

The upstream deployment is served at `https://agentvoice.mellowpilot.com`, a
Cloudflare **custom domain** rather than a `workers.dev` address, so
`workers.dev` is disabled and the only origin is the custom one. To serve your
own hostname, add the route **before** deploying — the zone must already be in
the same Cloudflare account:

```toml
routes = [{ pattern = "agent-voice.example.com", custom_domain = true }]
```

Then point the app at the deployment:

```bash
AGENT_VOICE_WORKER_URL=https://agentvoice.mellowpilot.com cargo tauri build
```

`worker_url` in `state.rs` is compiled in as the default above; forks **must**
override it, either at build time with the variable above or at runtime in
Settings. That runtime setting is what makes a custom worker — or a local
`wrangler dev` — usable without rebuilding.

## Paddle setup

1. Create a product with a **one-time** price (Catalog → Products → New price →
   Pricing model: One-time). Nothing else is needed — there is no license-key
   setting in Paddle Billing.
2. In **Paddle → Developer tools → Notifications**, add a destination pointing
   at `https://<worker>/webhook` and copy its secret into the worker secret
   above. For the upstream deployment that is
   `https://agentvoice.mellowpilot.com/webhook`.
3. Subscribe the worker to exactly three events — each one is selected
   individually, so adding `adjustment.created` does **not** bring
   `adjustment.updated` along with it (the destination's event list is
   authoritative; an unsubscribed event is simply never delivered):

   - `transaction.completed` — grant Pro for that `txn_…` id
   - `adjustment.created` — start of a refund/chargeback decision
   - `adjustment.updated` — the decision became final; without it a rejected
     refund could never restore a license the pending state had left alone

Anything else is acknowledged with `handled: false` and ignored.

These two adjustments are Paddle Billing's only refund/chargeback signal —
there are no `transaction.refunded` or `transaction.chargeback` events. Three
rules decide what happens:

| Condition                                                     | Result      |
| ------------------------------------------------------------- | ----------- |
| `action` ∈ {refund, chargeback} and `status=approved`         | **revoke**  |
| `action` ∈ {refund, chargeback} and `status=pending_approval` | nothing     |
| `status=rejected`                                             | **restore** |
| anything else (credit, chargeback_warning, reversals)         | nothing     |

Both the action and the status are allowlists. A refund starts at
`pending_approval`, so revoking on `created` alone would strip Pro from a
paying customer while Paddle still has the refund under review — and if Paddle
then rejects it, nothing would put the license back. `restore` flips an
existing revoked record back to active but never creates one, so a rejected
adjustment cannot mint a license.

Known gap: a `chargeback_reverse` (a dispute Paddle won) carries status
`approved` with an action outside the allowlist, so it does not re-activate.
Reconciling that needs a nightly job reading the Paddle API, which needs an
API key this worker does not have.

4. For the checkout overlay, set the Paddle client token and price id in the
   app build (see [`../.env.example`](../.env.example)). The app activates from
   the `checkout.completed` event and also listens for an
   `agentvoice://activate?code=…` deep link, so activation works even when a
   platform swallows the other one.

Use Paddle's **sandbox** environment until a full purchase→activate→refund
cycle has been tested end to end.

## Rate limiting

`/activate` runs a fixed-window counter per client IP (20 attempts per 10
minutes) in KV. KV is eventually consistent, so this throttles casual abuse
rather than counting exactly. If the endpoint ever becomes a target, move the
counter to a Durable Object; the call site
(`isRateLimited` in `src/store.ts`) is the only thing that changes.

Set `RATE_LIMIT_DISABLED = "true"` in `wrangler.toml` for local development.

## Tests

```bash
bun test worker
```

The suite runs against an in-memory KV double and covers token minting and
verification, device caps, refunds and chargebacks revoking a license (while
credits and dispute warnings do not), webhook signature verification (including
a body edited after signing) and rate limiting.
