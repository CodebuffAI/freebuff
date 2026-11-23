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

See [tmux.knowledge.md](tmux.knowledge.md) for comprehensive tmux documentation and [src/__tests__/README.md](src/__tests__/README.md) for testing documentation.

## Build

Compile the standalone binary (output in `bin/`):

```bash
bun run build:binary
```
