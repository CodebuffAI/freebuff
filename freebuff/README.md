# Freebuff

**The free coding agent.** No subscription. No configuration. Start in seconds.

An AI coding agent that runs in your terminal — describe what you want, and Freebuff edits your code.

## Install

```bash
npm install -g freebuff
```

## Usage

```bash
cd ~/my-project
freebuff
```

## Project Structure

```
freebuff/
├── cli/       # CLI build & npm release files
├── e2e/       # End-to-end tests
├── plunk/     # Plunk email tooling
└── web/       # Freebuff website
```

## Building from Source

```bash
# From the repo root
bun freebuff/cli/build.ts 1.0.0
```

---

For everything else — what Freebuff does, how it works, FAQ, and how it relates to Codebuff — see the [repo root README](../README.md). We keep that one up to date as the single source of truth.

## License

MIT
