## Summary

Superior Freebuff `--acp` free-mode path for T3 Code / Zed Local ACP hosts.

- Credits: **espetro** ([#1611](https://github.com/CodebuffAI/freebuff/pull/1611)) for the ACP stdio surface; **Rodrigo Veiga** (`feature/acp-agent` @ `9eec2f1`) for free-mode admission, process lifetime, constructor/`loadPackageVersion`, mode maps, and refusal-as-notice.
- Base is Rodrigo’s tip (not a from-scratch rewrite, not Nic’s gist alone).

### Kept (Rodrigo)

- Single admission path: `acpFreebuffSession.ensure` → `callFreebuffSession`
- Hour release on shutdown / SIGINT / SIGTERM / stdin close
- Constructor `{ logger }` + `loadPackageVersion()`
- `AGENT_MODE_TO_ID` / `AGENT_MODE_TO_COST_MODE` in `defaultRunTurn`
- Refused admission → one ACP `notice` + `stopReason: "refusal"` (never also throw)
- His ACP tests (still green)

### Ported (Nic gist)

- Lowercase `user-agent` on completions (fixes AI SDK header merge → 403)
- `--acp` implies `trustAgents`
- Early `--acp` branch before OSC/TTY/trust readline (stdout = JSON-RPC only)
- `sessionModes` / `setSessionMode` Freebuff model picker (+ agent modes)
- `formatFreebuffAcpError` for `third_party_client` / `prompt_policy`
- `model_unavailable` fallback + 90s POST→GET transient poll **inside** `ensureNow`

### Dropped (Nic gist)

- Inline `ensureFreebuffSession` + shared Zustand store admission
- Throw-on-refusal
- Hardcoded `LITE` costMode / bypass of mode maps

### Conflict resolution

1. **Admission:** exactly one path (`acpFreebuffSession` in `defaultRunTurn`).
2. **Refusal:** notice + `refusal` once; covered by a dedicated test.

## Test plan / evidence

- [x] `bun test --cwd cli src/acp` → **32 pass / 0 fail**
- [x] Rodrigo’s original suite still covered unmodified in spirit (event mapping, protocol, session refusals, stdio handshake)
- [x] New host-fix tests: UA lowercase, `--acp`⇒trustAgents + early branch, setSessionMode/mode maps, formatFreebuffAcpError, model_unavailable + 90s backoff (fake clock), refusal exactly once, release reasons
- [x] Scripted harness: `scripts/acp-stdio-harness.ts` (initialize → session/new → prompt; `--cancel-ms` → `cancelled`)
- [x] Cancel harness: `stopReason: cancelled`, no orphaned child
- [x] Feat-compiled Windows `freebuff-acp.exe` exposes `--acp` / `--trust-agents`; handshake-only initialize + session/new returns free modes (MiMo / DeepSeek / GLM + agent modes)
- [x] `session/set_mode` emits `current_mode_update` and tracks picker `currentModeId` (model or agent mode)
- [x] Compiled-binary cancel harness: `stopReason: cancelled` (`scripts/acp-harness-cancel-bin.jsonl`)
- [x] T3 Local ACP `providerInstances.freebuff-acp` enabled → compiled exe; UI selects Freebuff provider + `base2-free` (screenshots under sandbox `bin/screenshots/`)
- [ ] **Live free-mode completion** — **BLOCKED** (see below)
- [ ] **T3 Code E2E prompt stream / mode switch / second turn** — **BLOCKED** on the same allowlist gate
- [ ] Full-repo `tsc` / lint — ACP files clean; repo has pre-existing AI SDK type errors unrelated to this branch (~20)

### Live blocker (do not mark ready)

Dev entry `bun run cli/src/entry.ts --acp` admits a session, then chat completions return **403 `third_party_client_warning`** (strike recorded). NOTES also records that a **self-built** Windows binary still hits the same gate. Official npm `freebuff@latest` is still **0.2.36** and has **no `--acp`** (rechecked 2026-11-15; only `latest` dist-tag). See `scripts/acp-live-blocker.md` and `scripts/acp-harness-live.redacted.jsonl`.

**Needs:** an official allowlisted Freebuff build that includes `--acp`. No further live free probes until that ships.

## Notes

Research dump: `NOTES.md`.
