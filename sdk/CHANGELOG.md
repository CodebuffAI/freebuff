# Changelog

All notable changes to the @codebuff/sdk package will be documented in this file.

## [Unreleased]

- Added `sdk/examples/telegram-bot.ts`, a self-hosted Telegram bridge: point a bot token and API key at a project directory and chat with an agent remotely (per-chat sessions, `/new` to reset, retry/backoff on Telegram API failures). See `sdk/README.md`.

- `run()` now returns promptly when its `signal` aborts during the user lookup or agent-run registration that precede the first model request. Those requests had no signal and retried through a backoff, so a socket that never answered held the run for the whole retry budget; they now end on abort and the run resolves with `Run cancelled by user.`

- Dropped `knowledge.md` from the knowledge-file priority list; the SDK now picks up `AGENTS.md` then `CLAUDE.md` (per directory, and `~/.AGENTS.md`/`~/.CLAUDE.md` in the home directory). Existing `knowledge.md` files are no longer read. The `PRIMARY_KNOWLEDGE_FILE_NAME` export was removed with it; use `KNOWLEDGE_FILE_NAMES[0]`.

## [0.10.7]

- New code editing tool `apply_patch` which works well with Codex models (e.g. openai/gpt-5.3-codex)
- `write_file` is now a deterministic tool that creates or replaces the file. Previously, it also accepted edit snippet comments which could expand to keep a portion of the previous file, e.g. "// ... rest of the function ...". That behavior is removed to keep things simple. `str_replace` or `apply_patch` should be used if not overwriting the whole file.

## [0.10.6]

Added `skillsDir` parameter to specify a directory to load skills from.

## [0.10.5]

Fixed a bug with missing tool calls/results.

## [0.10.4]

Updated with various agent runtime improvements.

## [0.10.1]

More reliable tool calls!

## [0.10.0]

Lots of changes in the implementation, including native tool calls under the hood. Minimal changes in the public API.

## [0.4.3]

### Added

- Exported `processToolCallBuffer` and state helpers so SDK consumers can strip `<codebuff_tool_call>` segments mid-stream.
- CLI now consumes the shared helper to avoid leaking XML when responses arrive without token streaming.
- Extra regression tests covering multi-chunk tool-call payloads based on the CLI log case ("I'll help you commit").

## [0.4.2]

### Added

- XML tool call filtering in stream chunks - filters out `<codebuff_tool_call>` tags while preserving response text
- Stateful parser handles tags split across chunk boundaries
- 50-character safety buffer for split tag detection
- Comprehensive unit tests (17 test cases)

## [0.3.1]

- `CodebuffClient.run` now does not return `null`. Instead, the `CodebuffClient.run(...).output.type` will be `'error'`.

## [0.3.0]

- New more intuitive interface for `CodebuffClient` and `CodebuffClient.run`.

## [0.1.30]

Types updates.

## [0.1.20]

- You can now retrieve the output of an agent in `result.output` if result is the output of an awaited `client.run(...)` call.
- cwd is optional in the CodebuffClient constructor.
- You can pass in `extraToolResults` into a run() call to include more info to the agent.

## [0.1.17]

### Added

- You can now get an API key from the [Codebuff website](https://www.codebuff.com/profile?tab=api-keys)!
- You can provide your own custom tools!

### Updated

- Updated types and docs

## [0.1.9] - 2025-08-13

### Added

- `closeConnection` method in `CodebuffClient`

### Changed

- Automatic parsing of `knowledgeFiles` if not provided

### Fixed

- `maxAgentSteps` resets every run
- `CodebuffClient` no longer requires binary to be installed

## [0.1.8] - 2025-08-13

### Added

- `withAdditionalMessage` and `withMessageHistory` functions
  - Add images, files, or other messages to a previous run
  - Modify the history of any run
- `initialSessionState` and `generateInitialRunState` functions
  - Create a SessionState or RunState object from scratch

### Removed

- `getInitialSessionState` function

## [0.1.7] - 2025-08-12

### Updated types! AgentConfig has been renamed to AgentDefinition.

## [0.1.5] - 2025-08-09

### Added

- Complete `CodebuffClient`
- Better docs
- New `run()` api

## [0.0.1] - 2025-08-05

### Added

- Initial release of the Codebuff SDK
- `CodebuffClient` class for interacting with Codebuff agents
- `runNewChat` method for starting new chat sessions
- TypeScript support with full type definitions
- Support for all Codebuff agent types
- Event streaming for real-time responses
