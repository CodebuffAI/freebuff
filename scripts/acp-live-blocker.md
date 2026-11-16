# Live free-mode gate — blocked (2026-11-15)

## What was attempted

```text
bun scripts/acp-stdio-harness.ts --live --prompt "Reply with exactly the word: harness-ok"
```

Spawned `bun run cli/src/entry.ts --acp` against prod (`https://www.codebuff.com`).

## Result

Admission and ACP framing succeeded (DeepSeek selected). Completions returned **HTTP 403**:

```json
{
  "error": "third_party_client_warning",
  "message": "Freebuff free mode only works through the official Freebuff CLI, Freebuff Desktop and freebuff.com. This request came from a third-party client, harness or proxy, so it was refused and recorded as strike 5 on this account. Requests from the official apps are unaffected.",
  "strikes": 5
}
```

`formatFreebuffAcpError` surfaced this as an ACP `notice`. No `agent_message_chunk` was streamed.

## Why

- Dev entry (`bun run cli/src/entry.ts --acp`) is **not** on the free-mode allowlist.
- Installed official CLI `freebuff 0.2.36` has **no `--acp` flag**.

## T3 Code Local ACP

Cannot complete a real free-mode reply until Codebuff ships an allowlisted build that includes `--acp`. Protocol connect / mode picker can still be exercised against this branch’s entry for non-free paths, but free completions will strike the account.

**Stop condition honored:** live free-mode completion is not marked passed.
