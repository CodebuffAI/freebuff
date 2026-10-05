# License worker

Cloudflare Worker + KV that turns Paddle license keys into signed entitlement
tokens. See [`../docs/entitlement.md`](../docs/entitlement.md) for the token
format and key rotation.

## Routes

| Route              | Purpose                                                    |
| ------------------ | ---------------------------------------------------------- |
| `POST /activate`   | `{licenseKey, deviceId}` → `{token}`; claims a device slot |
| `POST /deactivate` | `{licenseKey, deviceId}` → `{ok}`; releases the slot       |
| `POST /webhook`    | Paddle events (HMAC verified); activates or revokes        |
| `GET /health`      | liveness                                                   |

Status codes the app understands: `403/404` unknown key, `409` device cap,
`410` revoked, `429` rate limited.

## Deploy

```bash
cd worker
bunx wrangler kv namespace create LICENSES     # paste the id into wrangler.toml
bunx wrangler secret put SIGNING_KEY          # PKCS#8 Ed255Y19 private key, base64
bunx wrangler secret put PADDLE_WEBHOOK_SECRET
bunx wrangler deploy
```

Then point the app at the deployment:

```bash
AGENT_VOICE_WORKER_URL=https://agent-voice-license.<subdomain>.workers.dev \
  cargo tauri build
```

The URL can also be changed at runtime in Settings, which is what makes a
custom worker (or a local `wrangler dev`) usable without rebuilding.

## Paddle setup

1. Create a product with a **one-time** license, and attach a license key to
   each sale (Paddle → Product → Licenses → "Generate license keys").
2. In **Paddle → Developer tools → Webhooks**, add an endpoint pointing at
   `https://<worker>/webhook` and copy its secret into the worker secret above.
3. Subscribe the worker to these events:

   - `license_key_created`, `license_key_activated` — grant Pro
   - `license_key_revoked`, `license_key_refunded` — revoke
   - `transaction.refunded`, `transaction.chargeback`,
     `transaction.dispute.created` — revoke

Anything else is acknowledged with `handled: false` and ignored.

4. For the checkout overlay, set the Paddle client token and price id in the
   app build (see [`../.env.example`](../.env.example)) and point the
   Paddle dashboard's return URL at `agentvoice://activate`. The app also
   listens for the `checkout.completed` event, so activation works even when a
   platform swallows the deep link.

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
verification, device caps, refunds revoking a license, webhook signature
verification (including a body edited after signing) and rate limiting.
