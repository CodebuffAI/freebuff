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

Clients released before this gate (`codebuff` and `@codebuff/sdk` on npm) eval
whatever the registry returns, so the registry GET routes refuse (403) a
non-`codebuff` template with `handleSteps` unless the request carries
`AGENT_TRUST_GATE_HEADER` (`common/src/constants/agents.ts`), which only the
gated SDK sends (`untrustedHandleStepsRefusal` in
`web/src/app/api/agents/_registry-guard.ts`). The server cannot see the
caller's trusted set, so the header defers that decision to the client.
`mcpServers` from non-`codebuff` publishers are refused outright, at publish
and at GET, whatever the client.

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

### Async subagents (`spawn_agent_async`)

`spawn_agent_async` starts ONE agent in the background and answers at once
with a spawn id (`t1`, `t2`, ... per parent, continuing across turns). The
child starts exactly as a `spawn_agents` child does (`startSubagent`: same
history boundary, `inheritParentSystemPrompt` / `includeMessageHistory`
prompt-cache inheritance, the shared `MAX_LIVE_SUBAGENTS_PER_ROOT` cap); only
delivery differs. `packages/agent-runtime/src/async-subagents.ts` queues the finished
child's report and the parent's `loopAgentSteps` adds it to the parent's
history between two steps, as one `ASYNC_SUBAGENT_REPORT` user message holding
the task and the child's WHOLE transcript (its text, every tool call with its
input, every result; reasoning left out; huge parts clipped head and tail).

- **Waiting.** A parent's turn never ends with a child still running: a turn
  that would end waits for the next report. `wait_for_subagents` waits the
  same way inside a step (or answers at once when nothing is running). It
  exists because DeepSeek Flash would not send a reply without a tool call to
  wait: base3's turn-ending rule made it start placeholder tasks or poll with
  empty reads instead. Steering is read before a wait, so a message sent
  during one joins a step later.
- **Errors.** A refused spawn (not spawnable, over the live cap, bad input) is
  also a tool error, so the parent gets another step to read it. A child that
  fails reports `status="failed"` with its partial transcript.
- **Cleanup.** Each run of the parent's loop opens its group and ends it
  however it exits: children still running are aborted and their reports
  (and credits) dropped, and a spawn after the loop has ended is refused. The
  group is keyed by the loop's `runId`, never the agentId: every root run's is
  `main-agent`, and one process runs many roots at once.
- **Completion.** An async team carries `task_completed` in its shared tool
  schema for the children to close their reports with, but its members still
  end a turn on a reply with no tool call: `requiresExplicitCompletion` is off
  when `spawn_agent_async` is in the tool schema.
- **Usage.** Children forward `onAgentUsageReceived` (`isRoot: false`), so a
  host's usage totals include background work; credits join the parent's
  `creditsUsed` when the report is delivered.

`agents/base3-async.ts` is built on it: base3 working in batches, which hands
the checks of a change of eight or more files to one CHECKS subagent (a staff
test in the CLI and Desktop: docs/freebuff-model-catalog.md, "Row harnesses";
results: `docs/benchmarks/base3-async/`).

### Shell Shims

Direct commands without `codebuff` prefix:

```bash
codebuff shims install codebuff/base-lite@1.0.0
eval "$(codebuff shims env)"
base-lite "fix this bug"
```

## Tools

- Tool definitions live in `common/src/tools` and are executed via the SDK helpers + agent-runtime.

### Skill resource paths

Both the runtime `skill` tool and CLI `/skill:<name>` prompts use
`common/src/util/skills.ts` → `formatSkillContent` to include the loaded skill's
base directory. Bundled `scripts/`, `references/`, and `assets/` paths resolve
against that directory, not the project cwd. Windows separators are normalized
to forward slashes for file tools and Git Bash. Keep this context on both entry
paths: the loader knows `filePath`, but raw SKILL.md content alone loses it and
leaves the agent searching for resources it already loaded instructions for.

### Explicit file reads versus discovery

The SDK's `read_files` reads explicitly named text and images even when
`.gitignore` or built-in discovery exclusions hide them (for example,
`sandbox/` renders or dependency source). File-tree discovery and background
project-understanding reads still apply those exclusions. Explicit reads honor
`.codebuffignore` / `.manicodeignore` and caller-provided file filters; sensitive
`.env` files remain blocked, and env templates still obey all project ignore
rules. `.freebuffignore` controls workspace transfers, not this read policy.

### Cut-off file edits are refused, never repaired

`packages/agent-runtime/src/util/truncated-write-guard.ts` stops two shapes of
a file edit that was cut off mid-generation:

- **Arguments that never closed.** When a response hits the output limit (or
  loses its connection) inside a tool call, the OpenAI-compatible provider
  still flushes the call with whatever argument text arrived, and OpenRouter
  reports the step as `finish_reason: "tool_calls"` (the real reason is only in
  `native_finish_reason: "max_output_tokens"`). `parseRawToolCall` recognises
  a truncated JSON prefix and answers with an explicit "nothing was written"
  error instead of the generic re-issue hint, and does not echo the partial
  content back. Do not add a JSON-repair step for mutating tools: completing a
  cut-off `content` string is exactly how a file gets truncated on disk.
- **A cut-off copy of an existing file.** `processFileBlock` refuses a
  `write_file` that is under 60% of an existing file of 30+ lines AND leaves
  brackets open where the current file balances them. Both refusals log
  `axiomEvent: file_write_guard` (`metric` says which).

The finish reason is deliberately not the signal: complete arguments in a
length-cut step are a complete call, and the OpenRouter shape above hides the
length cut anyway.

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
