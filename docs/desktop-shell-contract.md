# The desktop orchestrator's shell contract

The desktop app is a shell around a local HTTP server. The shell is what starts it, keeps it
alive, and talks to it; the server — a Bun process shipped with the desktop build — is the part
that holds projects, threads and sessions. This document is the observable contract *of that
shell boundary*, recovered from a shipped install, so that other clients (a test harness, a
native shell, an automation script) can drive the same server without re-deriving it.

Nothing here is private: it is the shape of a loopback interface, not any user's data.

## Provenance

Written against the installed **Freebuff Desktop `0.0.203`** build. Every claim below is a literal in
one of these files, recorded with the hash of the copy it was read from:

| Artifact | SHA-256 (first 16) |
|---|---|
| `resources/app.asar` (the Electron shell) | `af684513edb0c024` |
| `app/electron/orchestrator-startup.cjs` | `debeb69d7d935a81` |
| `app/electron/shell-lifetime.cjs` | `9affdeff0595e928` |
| `app/electron/launch-bootstrap.cjs` | `e7b2390dbc95f2ae` |
| `resources/orchestrator/orchestrator.js` (the bundled server) | `6a34e09a2722c87b` |

The bundle keeps its source paths, which are the fastest way to check these against the real tree:
`src/server/boot-phase.ts` (the phase list), `src/server/services/orchestrator-lock.ts` (the profile
lock and the exit code), and the shell modules named above.

| Claim | Where | Literal |
|---|---|---|
| the nine phases, in order | `orchestrator-startup.cjs:22` | `const BOOT_PHASES = new Set([` … `'projects_boot_end',` |
| phase line prefix | `orchestrator-startup.cjs:19` | `const PHASE_PREFIX = '[orchestrator-phase] '` |
| 30 s spawn → ready | `orchestrator-startup.cjs:35` | `const READY_LINE_BUDGET_MS = 30_000` |
| 60 s ready → `/healthz` | `orchestrator-startup.cjs:37` | `const HEALTH_BUDGET_MS = 60_000` |
| ready line shape | `orchestrator.js` | ``console.log(`[orchestrator-ready] ${JSON.stringify({ launchId: LAUNCH_ID, pid: process.pid, port: serverPort })}`)`` |
| stdin bootstrap line | `launch-bootstrap.cjs:20` | `function launchBootstrapLine({ shellLifetimeToken, launchId, cdpBridgeToken, mcpConsentToken })` |
| 3 s ping | `shell-lifetime.cjs:9` | `const DEFAULT_PING_MS = 3000` |
| HMAC labels | `shell-lifetime.cjs:37,46` | `` `client:${challenge}:${clientChallenge}` ``, `` `server:${challenge}:${clientChallenge}` `` |
| `/api/*` gate | `orchestrator.js` | `pathname.startsWith("/api/")` |
| header and cookie names | `orchestrator.js` | `var LAUNCH_TOKEN_HEADER = "x-freebuff-launch-id"`, `` `freebuff_launch_${port}` `` |
| 401 body | `orchestrator.js` | `json4({ error: "invalid launch id" }, 401)` |
| exit code 75 | `orchestrator.js` | `var PROFILE_BUSY_EXIT = 75` … `process.exit(PROFILE_BUSY_EXIT)` |
| profile lock file | `orchestrator.js` | `` `${statePath}.orchestrator-lock.sqlite` ``, opened with `PRAGMA busy_timeout = 0` |
| lock wait default | `main.cjs:932` | `FREEBUFF_PROFILE_LOCK_WAIT_MS: '10000'` |

Re-checking a claim is one grep, no build:

```bash
npx @electron/asar extract "<install>/resources/app.asar" app
grep -n "READY_LINE_BUDGET_MS\|HEALTH_BUDGET_MS" app/electron/orchestrator-startup.cjs
grep -n "PROFILE_BUSY_EXIT\|invalid launch id\|LAUNCH_TOKEN_HEADER" \
  "<install>/resources/orchestrator/orchestrator.js"
```

**Across versions.** None of these constants is negotiated — no handshake carries a protocol
version — so a build that renames a phase or moves a budget breaks a client silently instead of
saying so. This page is a snapshot of one build, and where it disagrees with a newer one, the build
is right. The parts worth relying on are the shape: a phase line on stdout, a ready line carrying a
launch id, a bootstrap line on stdin, an HMAC lifetime socket, and a launch-id header on `/api/*`.
The constants next to them are the part to re-read when a release changes.

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

## Scope

This documents a boundary that exists today, and it is useful whether or not a native shell is ever
built: a test harness, a diagnostics client or an automation script needs the same facts, and none
of them needs the direction question answered first. Nothing here argues for a particular shell.

A reference implementation of all of the above is ~500 lines of dependency-light Rust: it spawns the
same server, keeps it alive and reports its state in a sidebar. It is deliberately not part of this
document. Neither the shell code nor the server code is required to use this contract; only the
words above.
