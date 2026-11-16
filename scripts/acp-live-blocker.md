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

## What still passed without an allowlisted binary

| Gate | Result |
| --- | --- |
| ACP unit/integration (`bun test --cwd cli src/acp`) | **31 pass / 0 fail** (Rodrigo’s suite + host-fix coverage) |
| Scripted cancel harness (`--cancel-ms 200`) | **`stopReason: cancelled`**, child exited, no orphan |
| Live harness framing | initialize → session/new (modes picker) → prompt → ACP `notice` for third_party |
| Official `freebuff 0.2.36` | No `--acp` flag (cannot use allowlisted binary for this path yet) |

## T3 Code Local ACP (updated 2026-11-15)

Local ACP **config + handshake** now verified against a feat-compiled `freebuff-acp.exe`:

- T3 `providerInstances.freebuff-acp.enabled = true` with `--acp --trust-agents`
- Handshake-only (no `session/prompt`): protocol v1, session id, free model modes
- UI: Freebuff provider + `base2-free` selected (sandbox screenshots)

Still **cannot** complete a real free-mode reply until Codebuff ships an **allowlisted** build that includes `--acp`. Self-built binaries are documented in `NOTES.md` as still receiving `third_party_client_warning`.

**Stop condition honored:** live free-mode completion is **not** marked passed. Do not re-run `--live` / T3 free prompts on this account without an allowlisted build (strike counter already advanced).
