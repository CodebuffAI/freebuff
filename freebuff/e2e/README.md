# Freebuff E2E Tests

End-to-end tests for the Freebuff CLI binary. Tests verify that the compiled binary works correctly by interacting with it via tmux.

## Architecture

Two testing approaches are supported:

### 1. Direct tmux tests (fast, deterministic)

Use the `FreebuffSession` class to start the binary in tmux, send commands, capture output, and assert directly.

```typescript
import { describe, test, expect, afterEach } from 'bun:test'
import { FreebuffSession, requireFreebuffBinary } from '../utils'

describe('My Feature', () => {
  let session: FreebuffSession | null = null

  afterEach(async () => {
    if (session) await session.stop()
    session = null
  })

  test('works correctly', async () => {
    const binary = requireFreebuffBinary()
    session = await FreebuffSession.start(binary)

    await session.send('/help')
    const output = await session.capture(2)

    expect(output).toContain('Shortcuts')
  }, 60_000)
})
```

### 2. SDK agent-driven tests (AI-powered verification)

Use the Codebuff SDK to run a testing agent that interacts with Freebuff via custom tmux tools. The agent reasons about the CLI output and verifies complex behaviors.

```typescript
import { describe, test, expect, afterEach } from 'bun:test'
import { CodebuffClient } from '@codebuff/sdk'
import { freebuffTesterAgent } from '../agent/freebuff-tester'
import { createFreebuffTmuxTools, requireFreebuffBinary } from '../utils'

describe('Agent Test', () => {
  let cleanup: (() => Promise<void>) | null = null

  afterEach(async () => {
    if (cleanup) await cleanup()
    cleanup = null
  })

  test('verifies startup', async () => {
    const apiKey = process.env.CODEBUFF_API_KEY
    if (!apiKey) return // Skip if no API key

    const binary = requireFreebuffBinary()
    const tmuxTools = createFreebuffTmuxTools(binary)
    cleanup = tmuxTools.cleanup

    const client = new CodebuffClient({ apiKey })
    const result = await client.run({
      agent: freebuffTesterAgent.id,
      prompt: 'Start Freebuff and verify the branding is correct.',
      agentDefinitions: [freebuffTesterAgent],
      customToolDefinitions: tmuxTools.tools,
      handleEvent: () => {},
    })

    expect(result.output.type).not.toBe('error')
  }, 180_000)
})
```

### 3. Live smoke against production

`tests/live-turn.e2e.test.ts` is the one file here that talks to the real backend:
it navigates the landing picker to DeepSeek V4.1 Flash, starts a session, sends a
prompt, waits for the answer, then runs `/end-session` and checks the backend shows
no open session. It skips unless `FREEBUFF_SMOKE_API_KEY` (or
`CODEBUFF_API_KEY`) is set, and needs a binary built with the production public
env. It is not in the `freebuff-e2e.yml` matrix — `.github/workflows/prod-smoke.yml`
runs it on a schedule and before each release.

```bash
NEXT_PUBLIC_CB_ENVIRONMENT=prod NEXT_PUBLIC_CODEBUFF_APP_URL=https://www.codebuff.com \
NEXT_PUBLIC_FREEBUFF_APP_URL=https://freebuff.com NEXT_PUBLIC_SUPPORT_EMAIL=support@codebuff.com \
NEXT_PUBLIC_POSTHOG_API_KEY=test NEXT_PUBLIC_POSTHOG_HOST_URL=http://127.0.0.1:9 \
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=test NEXT_PUBLIC_STRIPE_CUSTOMER_PORTAL=http://127.0.0.1:9 \
NEXT_PUBLIC_WEB_PORT=3000 bun freebuff/cli/build.ts 0.0.0-smoke
CODEBUFF_API_KEY=<your token> bun test freebuff/e2e/tests/live-turn.e2e.test.ts --timeout=300000
```

The CLI runs with its own `FREEBUFF_CONFIG_DIR`, so your real profile is untouched.

## Prerequisites

- **tmux** must be installed: `brew install tmux` (macOS) or `sudo apt-get install tmux` (Ubuntu)
- **Freebuff binary** must be built: `bun freebuff/cli/build.ts 0.0.0-dev`
- **SDK built** (for agent tests): `cd sdk && bun run build`
- **CODEBUFF_API_KEY** (for agent tests only): Set this environment variable

## Running Tests

### Build the binary first

```bash
bun freebuff/cli/build.ts 0.0.0-dev
```

### Run all tests

```bash
bun test freebuff/e2e/tests/
```

### Run a specific test

```bash
bun test freebuff/e2e/tests/version.e2e.test.ts
bun test freebuff/e2e/tests/startup.e2e.test.ts
bun test freebuff/e2e/tests/help-command.e2e.test.ts
bun test freebuff/e2e/tests/agent-startup.e2e.test.ts
```

### Use a custom binary path

```bash
FREEBUFF_BINARY=/path/to/freebuff bun test freebuff/e2e/tests/
```

## Adding New Tests

1. Create a new file in `freebuff/e2e/tests/` with the naming convention `<feature>.e2e.test.ts`
2. Add the test name to `.github/workflows/freebuff-e2e.yml` matrix:

```yaml
matrix:
  test:
    - version
    - startup
    - help-command
    - agent-startup
    - your-new-test    # <-- add here
```

3. The test will automatically run in parallel with other tests in CI.

## CI Workflow

The `.github/workflows/freebuff-e2e.yml` workflow:

1. **Builds** the Freebuff binary once (linux-x64)
2. **Runs each test file in parallel** via GitHub Actions matrix strategy
3. **Uploads tmux session logs** on failure for debugging

Triggers:
- **Nightly** at 6:00 AM PT
- **Manual** via workflow_dispatch

## Utilities Reference

### `FreebuffSession`

| Method | Description |
|--------|-------------|
| `FreebuffSession.start(binaryPath)` | Start binary in tmux, returns session |
| `session.send(text)` | Send text input (presses Enter) |
| `session.sendKey(key)` | Send special key (e.g. `'C-c'`, `'Escape'`) |
| `session.capture(waitSec?)` | Capture terminal output |
| `session.captureLabeled(label, waitSec?)` | Capture and save to session logs |
| `session.waitForText(pattern, timeoutMs?)` | Poll until text appears |
| `session.stop()` | Stop session and clean up |

### `createFreebuffTmuxTools(binaryPath)`

Creates SDK custom tools for agent-driven testing:
- `start_freebuff` - Launch the CLI
- `send_to_freebuff` - Send text input
- `capture_freebuff_output` - Capture terminal output
- `stop_freebuff` - Stop and clean up

### Helper functions

| Function | Description |
|----------|-------------|
| `requireFreebuffBinary()` | Get binary path, throws if not found |
| `getFreebuffBinaryPath()` | Get binary path (may not exist) |
