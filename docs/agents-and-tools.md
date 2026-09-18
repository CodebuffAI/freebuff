# Agents and Tools

## Agents

- Prompt/programmatic agents live in `.agents/` (programmatic agents use `handleSteps` generators).
- Generator functions are NOT sandboxed: the runtime `eval`s a `handleSteps` source string in the process that runs the agent (`packages/agent-runtime/src/run-programmatic-step.ts`); agent templates define tool access and subagents.

### Registry agents with executable `handleSteps` require publisher trust

A template fetched from the public agent registry (`--agent publisher/agent`, a
registry id in a local agent's `spawnableAgents`, or a bare id falling back to
`codebuff/<id>`) is executable code when it carries `handleSteps`: the row's
`handleSteps` is a source string, validation only checks that it starts with
`function*`, and the runtime evals it with no isolation on the user's machine.
The registry GET is public, any account can create a publisher and publish
without review, and `latest` is unpinned. So the SDK's `fetchAgentFromDatabase`
refuses a registry template with a string `handleSteps` unless its publisher is
trusted (`sdk/src/agent-publisher-trust.ts`), and throws an
`UntrustedAgentPublisherError` whose message names `publisher/agent@version`
and the knob to set. Trusted publishers are `codebuff` (our own, also bundled)
plus the comma-separated `CODEBUFF_TRUSTED_AGENT_PUBLISHERS` env var plus the
`trustedAgentPublishers` option on `CodebuffClient` / `run()`. Data-only
registry templates (no `handleSteps`) load as before, and local `.agents` files
and SDK `agentDefinitions` are never gated — they are code the user already
chose to run. This is a trust floor, not isolation: sandboxing the eval,
signing templates and pinning `latest` are separate work.

### Trust gate for repository `.agents` directories

`loadLocalAgents` dynamically imports every `.ts`/`.tsx`/`.js`/`.mjs`/`.cjs`
file under `{cwd}/.agents` and `{cwd}/../.agents`, and `loadMCPConfigSync`
reads an `mcp.json` there whose stdio servers are spawned on the first prompt
with `$VAR` env values filled from the CLI's own environment. Both execute
repository-supplied code, so cloning a hostile repo and running the CLI inside
it must not run anything without consent. The CLI therefore gates those two
repository-scoped directories (`cli/src/utils/agent-dir-trust.ts`):

- **What needs trust**: a directory containing at least one executable agent
  file (the loader's extension filter, minus `.d.ts` and tests) or an
  `mcp.json`. A directory holding only `skills/` markdown does not, and
  `~/.agents` never does (it is the user's own). Skills still load from an
  untrusted directory; only agents and `mcp.json` are withheld.
- **The prompt**: on an interactive launch (stdin and stdout are TTYs) the CLI
  prints a plain-terminal prompt before the TUI mounts, listing the directory,
  its agent files (capped at 10) and the commands or URLs its `mcp.json` would
  start, and asks `Load and run these? [y/N]`. `y` records the directory;
  anything else skips it for this run and prints how to trust it later.
- **The store**: `<configDir>/trusted-agent-dirs.json` (next to
  `credentials.json`, written with mode `0600`), a map of the normalized
  absolute directory path to `{ "trustedAt": "<ISO>" }`. Delete an entry to
  be asked again.
- **Non-interactive runs** (no TTY, CI) never prompt: the directory is skipped
  with a warning unless `CODEBUFF_TRUST_AGENT_DIRS=1` or `--trust-agents` is
  passed, which trusts every repository directory for that run only and writes
  nothing to the store.
- **SDK semantics are unchanged**: `loadLocalAgents({ agentDirs })` and
  `loadMCPConfig{,Sync}({ configDirs })` are opt-in options; omitting them
  keeps the default search, so Desktop and external SDK consumers behave as
  before. `getDefaultAgentDirs()` and `listLocalAgentFiles()` are exported so a
  host can build its own gate on the loader's own filter.

Trust is per directory, not per file content: a trusted repository that later
pulls a malicious agent file is loaded without a new prompt, the same trade-off
other coding agents make for their project-level config.

### Shell Shims

Direct commands without `codebuff` prefix:

```bash
codebuff shims install codebuff/base-lite@1.0.0
eval "$(codebuff shims env)"
base-lite "fix this bug"
```

## Tools

- Tool definitions live in `common/src/tools` and are executed via the SDK helpers + agent-runtime.

### Console-free terminal command broker

`run_terminal_command` separates process ownership from terminal UI ownership:

- `sdk/src/tools/run-terminal-command.ts` owns output buffering, timeouts,
  cancellation escalation, results, and process diagnostics. Headless SDK
  consumers use its direct process-group runner.
- Interactive hosts provide `terminalCommandBroker` in `CodebuffClientOptions`
  (or directly to `runTerminalCommand`). Each call synchronously starts an
  isolated helper and returns a handle for its complete process tree. A startup
  failure prevents the shell from running; there is no direct-console fallback.
- The CLI's tiny `src/entry.ts` handles private broker mode before importing
  React or OpenTUI. The detached, hidden helper receives one spawn request over
  stdin, starts the shell without a console or interactive stdin, relays only
  stdout/stderr pipes, and reports completion through a constrained one-shot
  file in the OS temp directory. It deliberately uses only the three standard
  stdio channels: Bun's custom child-process pipes can fail their Windows
  `node:net` handshake outside the `ChildProcess` error event and terminate the
  CLI as an unhandled rejection. The broker remains the process-group root and
  self-reaps the tree if its parent disappears, detected by polling the parent
  PID rather than holding another pipe open.
- Mouse and focus protocols stay enabled while commands run. The
  `TerminalProtocolController` only parses focus events; it has no command
  lifecycle state to synchronize or restore.

Thread the broker capability through every interactive command entry point.
Do not bypass it with a direct `spawn`, add command-active terminal state, or
fall back to the TUI process when broker startup fails.
