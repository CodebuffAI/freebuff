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
3. Subscribe the worker to exactly two events:

   - `transaction.completed` — grant Pro for that `txn_…` id
   - `adjustment.created` — revoke when the payload's `action` is `refund` or
     `chargeback`

Anything else is acknowledged with `handled: false` and ignored.

`adjustment.created` is Paddle Billing's only refund/chargeback signal — there
are no `transaction.refunded` or `transaction.chargeback` events. It is
deliberately an allowlist (`refund`, `chargeback`), so a goodwill credit note
or a `chargeback_warning` never costs a paying customer their license. The
known gap: a `chargeback_reverse` (a dispute Paddle won) does not re-activate
the license — reconciling that needs a nightly job reading the Paddle API,
which needs an API key this worker does not have.

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
