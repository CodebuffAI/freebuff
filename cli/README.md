# @codebuff/cli

A Terminal User Interface (TUI) package built with OpenTUI and React.

## Installation

```bash
bun install
```

## Development

Run the TUI in development mode:

```bash
bun run dev
```

## Testing

Run the test suite:

```bash
bun test
```

## Everest terminal output compression

Freebuff can optionally send eligible terminal stdout and stderr to the
installed Everest CLI for compression before the agent sees the result.
Install Everest and run `everest login`, then enter `/everest on` in Freebuff.
Use `/everest status` to check the local setting and `/everest off` to disable
it. The setting is stored in Freebuff's normal `settings.json`; removing
Everest does not alter Freebuff's settings or command execution.

Freebuff executes commands through its regular terminal broker and applies
compression only to completed output. Missing Everest, a logged-out session,
timeout, or compressor failure leaves the original result in place. Short
output, `# coact-focus: raw`, failed commands, and interrupted commands also
keep their original result. The opt-in does not change model selection or tool
permissions.

### Interactive E2E Testing

For testing interactive CLI features, install tmux:

```bash
# macOS
brew install tmux

# Ubuntu/Debian
sudo apt-get install tmux

# Windows (via WSL)
wsl --install
sudo apt-get install tmux
```

Then run the proof-of-concept:

```bash
bun run test:tmux-poc
```

**Note:** When sending input to the CLI via tmux, you must use bracketed paste mode. Standard `send-keys` drops characters.

```bash
# ❌ Broken: tmux send-keys -t session "hello"
# ✅ Works:  tmux send-keys -t session $'\e[200~hello\e[201~'
```

See [tmux.knowledge.md](tmux.knowledge.md) for comprehensive tmux documentation and [src/**tests**/README.md](src/__tests__/README.md) for testing documentation.

## Build

Build the package:

```bash
bun run build
```

## Run

Run the built TUI:

```bash
bun run start
```

Or use the binary directly:

```bash
codebuff-tui
```

## Features

- Built with OpenTUI for modern terminal interfaces
- Uses React for declarative component-based UI
- TypeScript support out of the box
