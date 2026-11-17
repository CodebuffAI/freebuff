# The desktop orchestrator's shell contract

The desktop app is a shell around a local HTTP server. The shell is what starts it, keeps it
alive, and talks to it; the server — a Bun process shipped with the desktop build — is the part
that holds projects, threads and sessions. This document is the observable contract *of that
shell boundary*, recovered from a shipped install, so that other clients (a test harness, a
native shell, an automation script) can drive the same server without re-deriving it.

Nothing here is private: it is the shape of a loopback interface, not any user's data.

## The two-process shape

```
shell ──spawn──▶ bun resources/orchestrator/orchestrator.js   (cwd = …/orchestrator)
  │                  │  stdout = boot progress lines
  │                  └─▶ http://127.0.0.1:<PORT>   (Bun.serve, host 127.0.0.1)
  └── owns the lifetime socket; the server stops when it closes
```

The shell picks a free loopback port and passes it as `PORT`. The server binds `127.0.0.1` only
and rejects requests whose `Host` header is not a loopback host.

## Boot progress on stdout

The server prints one whitelisted phase per step; anything else on stdout is ignored by the
shell.

```
[orchestrator-phase] <phase>
```

The phases, in order: `started, bootstrap, profile_lock, auth, recover_setups, terminals,
listen, projects_boot_start, projects_boot_end`. Only these nine names are reported.

When the HTTP server is up it prints:

```
[orchestrator-ready] {"launchId":…,"pid":…,"port":…}
```

The shell's two budgets, from the shipped startup code:

1. spawn → ready line: **30 seconds**
2. ready line → first healthy `GET /healthz`: **60 seconds**

`/healthz` answers plain `ok` when the server has no launch id, or
`{"ok":true,"launchId":…,"pid":…,"port":…}` when it does.

## Secrets: the stdin bootstrap line

Launch secrets are **not** passed in the environment, because any process of the same user can
read a child's starting environment. They ride the first stdin line:

```json
{"shellLifetimeToken":"…","launchId":"…","cdpBridgeToken":null,"mcpConsentToken":null}
```

A bare token string is also accepted as the lifetime token alone.

## Lifetime: how a dead shell takes its server down

The server is told to be shell-managed via `FREEBUFF_SHELL_LIFETIME_PORT`; when set, the server
shuts down once the socket closes — a killed shell cannot orphan a server. To keep a foreign
process from holding the server hostage, the socket is challenged:

1. server writes `challenge\n` (32 random bytes, base64url);
2. client answers `clientChallenge:HMAC-SHA256(token, "client:"+challenge+":"+clientChallenge)`;
3. server replies `HMAC-SHA256(token, "server:"+challenge+":"+clientChallenge)`;
4. then the client pings with `ping\n` every 3 s; the server tolerates 10 s of silence.

## The API gate

Every `/api/*` path is refused with `401 unauthorized` unless the request carries
`x-freebuff-launch-id: <launchId>` (the value from the bootstrap line) or the
`freebuff_launch_<port>` cookie. A server started with no launch id admits everything.

## Environment

| Variable | Meaning |
|---|---|
| `PORT` | loopback port to bind |
| `FREEBUFF_DESKTOP_STATE_PATH` | profile path, default `~/.config/freebuff-desktop/state.json` |
| `FREEBUFF_PROFILE_LOCK_WAIT_MS` | wait on the profile lock before failing (exit 75 + a stderr explanation if another orchestrator holds it) |
| `FREEBUFF_SHELL_LIFETIME_PORT` | lifetime server port (see above) |
| `FREEBUFF_UI_DIR` | where `ui/` lives, served at `/` |
| `CODEBUFF_WASM_DIR`, `CODEBUFF_TREE_SITTER_WASM_PATH` | tree-sitter wasm used by code features |
| `FREEBUFF_BUN_PATH` | override the bundled Bun |

## Why this exists

A shell boundary like this is the kind of thing a port, a test harness or an automation script
re-derives one frustrating session at a time. This page fixes the shape in one place. It came
from observing a shipped install, so if the real shell ever changes the handshake, this page
should be updated with it.

A reference implementation of all of the above is ~500 lines of dependency-light Rust: it spawns
the same server, keeps it alive and reports its state in a sidebar. It is deliberately not part of
this document — whether a native shell belongs in this repository is the question the accompanying
issue asks. Neither the shell code nor the server code is required to use this contract; only the
words above.