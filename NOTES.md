# Freebuff ACP free-mode — research notes

Branch base: `rodriveiga01/freebuff` `feature/acp-agent` @ `9eec2f1` (one commit on `681a041` / espetro `#1611`).

## 1. Upstream PR #1611 (espetro)

Adds `freebuff --acp`: ACP v1 over stdio via `@agentclientprotocol/sdk`. Reuses `getCodebuffClient()` → SDK `run()` so free-mode admission, `freebuff_instance_id`, and device signing match the TUI. In-tree is required — external wrappers get `third_party_client` refusals.

**Review (codebuff-team):** constructor bug — `new FreebuffAcpAgent(log)` vs `{ logger }`; hardcoded `agent: 'base2-free'` + `costMode: LITE`; `as never` casts; picocolors drive-by.

**Nic (nicholaslilly):** T3 Local ACP handshake works; self-built Windows binary still gets `third_party_client_warning` — official allowlisted binary still required for live free mode. Gist patch linked for host fixes.

**Rodrigo (rodriveiga01):** fork commit `9eec2f1` — admission via `callFreebuffSession`, process lifetime release, constructor + `loadPackageVersion()`, mode maps, refusal as notice + `stopReason: "refusal"`. 18 tests pass locally; **no live free-mode completion verified**.

## 2. Rodrigo vs base (`681a041...9eec2f1`)

| Area | Change |
| --- | --- |
| `freebuff-session.ts` | New `AcpFreebuffSession`: serialized `ensure` → POST claim, reuse per model, `release` on shutdown |
| `acp-agent.ts` | `defaultRunTurn` admits via `acpFreebuffSession.ensure`; `AGENT_MODE_TO_ID` / `AGENT_MODE_TO_COST_MODE`; `AcpSessionError` → notice + `refusal` |
| `serve.ts` | `{ logger }` constructor; `loadPackageVersion()`; SIGINT/SIGTERM/`connection.closed` → release + exit; console → stderr |
| Tests | Constructor shape fix; refusal wording tests in `acp-session.test.ts` |

## 3. Nic gist — keep / port / drop

**Port into Rodrigo base:**

- Lowercase `'user-agent': getCliAdRequestUserAgent()` on completions (fixes AI SDK header merge → 403).
- `--acp` ⇒ `trustAgents` in `parseArgs`.
- Early `--acp` branch in `main()` before OSC/TTY/trust readline (stdout must stay JSON-RPC-only).
- `sessionModes` / `setSessionMode` + Freebuff model picker (`FREEBUFF_ACP_MODEL_MODES`).
- `formatFreebuffAcpError` for `third_party_client` / `prompt_policy` (+ rate_limit / waiting_room).
- `model_unavailable` fallback + 90s POST→GET transient poll (408/429/503 backoff) — **into** `AcpFreebuffSession.ensureNow`, not a second admission path.

**Drop:**

- Inline `ensureFreebuffSession` + shared Zustand store admission.
- Throw-on-refusal (`RequestError.invalidParams` for admission failures).
- Hardcoded `AGENT_MODE_TO_COST_MODE.LITE` / `getFreebuffCliAgentIdForSelection` bypass of mode maps.

## 4. Conflict resolution

1. **Admission:** exactly one path — `acpFreebuffSession.ensure` → `ensureNow` inside `defaultRunTurn`. Delete Nic’s `ensureFreebuffSession`.
2. **Refusal:** catch `AcpSessionError` in `prompt()` → one notice + `stopReason: "refusal"`. Never also throw. Transient timeout / hard failures after poll become ACP errors (invalid params / notice), not duplicate refusal reports.

## 5. ACP protocol (v1) — relevant surface

- **initialize:** negotiate `protocolVersion`, capabilities, `agentInfo` / `clientInfo`.
- **session/new:** returns `sessionId` + optional `modes: { currentModeId, availableModes }`.
- **session/set_mode:** unknown mode → JSON-RPC `-32602` invalid params.
- **session/prompt:** streams `session/update` (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `notice`); response `stopReason`: `end_turn` | `max_tokens` | `max_turn_requests` | `refusal` | `cancelled`.
- **session/cancel:** abort in-flight turn → `cancelled` (must not surface as protocol error).
- Transport: newline-delimited JSON-RPC over stdio; stdout is protocol-only.

## 6. Freebuff free-mode internals

- **`callFreebuffSession`:** POST/GET/DELETE `/api/v1/freebuff/session` with instance id, model, multi-session headers, device signing.
- **`AcpFreebuffSession.ensureNow` (Rodrigo):** single POST; throw `AcpSessionError` on non-active; release on model switch.
- **Enhance:** poll GET after POST; backoff on 408/429/503; one `model_unavailable` fallback; give up at 90s with clear error.
- **`defaultRunTurn`:** `AGENT_MODE_TO_ID[mode]` + `AGENT_MODE_TO_COST_MODE[mode]`; attach `freebuffSessionMetadata` + `clientDescriptorMetadata`.
- **Hour release:** `serveAcp` on normal exit, SIGINT, SIGTERM, stdin/`connection.closed`.

## 7. T3 Code Local ACP launch

From T3 docs (`providers-acp.md`) + Nic’s notes:

- Settings → Providers → Local ACP command.
- **Command:** `freebuff` (or path to binary/entry).
- **Args:** `--acp` (one literal arg).
- Env overrides optional; credentials stay in Freebuff keychain (no ACP auth).
- Models/modes come from ACP `session/new` → `modes` (picker).
- Spawn is direct (`shell: false`); Windows `.cmd` shims are problematic — prefer real executable / `bun run cli/src/entry.ts --acp` for dev.
- Expectation: lowercase Freebuff-CLI user-agent on completions; no TTY trust prompt; streamed `session/update` then `end_turn`.

## 8. Live gate risk (hit 2026-11-15)

Self-compiled / `bun run cli/src/entry.ts --acp` still gets:

```text
third_party_client_warning — Freebuff free mode only works through the official
Freebuff CLI, Freebuff Desktop and freebuff.com. … recorded as strike 5
```

Installed official CLI is `freebuff 0.2.36` and **does not include `--acp`**, so T3 Local ACP cannot use an allowlisted binary yet.

**Do not keep retrying live completions from a non-allowlisted build** — each refusal adds strikes.

Protocol/unit gates can still pass. Live free-mode completion + T3 editor E2E remain blocked until Codebuff ships an allowlisted build with `--acp`.

## 9. When an official `--acp` build ships

Strike-safe readiness check (no prompts):

```text
bun scripts/acp-official-ready.ts --npm
bun scripts/acp-official-ready.ts --bin path/to/official/freebuff
```

Then live + T3 E2E (only on allowlisted official builds):

```text
FREEBUFF_ACP_CMD="<official> --acp --trust-agents" bun scripts/acp-stdio-harness.ts --handshake-only --set-mode MAX
FREEBUFF_ACP_CMD="<official> --acp --trust-agents" bun scripts/acp-stdio-harness.ts --live --turns 2 --set-mode MAX
```

Point T3 `providerInstances.freebuff-acp` at that binary, capture screenshots of streamed reply + mode switch + second turn.
