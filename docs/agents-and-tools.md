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
