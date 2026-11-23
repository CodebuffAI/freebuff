# CLI Testing

Comprehensive testing suite for the Codebuff CLI using tmux for interactive terminal emulation.

## Test Naming Convention

Follow these naming patterns:

- **Unit tests:** `*.test.ts` (e.g., `cli-args.test.ts`)
- **E2E tests:** `e2e-*.test.ts` (e.g., `e2e-cli.test.ts`)
- **Integration tests:** `integration-*.test.ts` (e.g., `integration-tmux.test.ts`)

## Quick Start

```bash
cd cli
bun test
```

## Prerequisites

### For Integration Tests

Install tmux for interactive CLI testing:

```bash
# macOS
brew install tmux

# Ubuntu/Debian
sudo apt-get install tmux

# Windows (via WSL)
wsl --install
sudo apt-get install tmux
```

### For E2E Tests

Build the SDK first:

```bash
cd sdk
bun run build
cd ../cli
```

## Running Tests

### All Tests

```bash
bun test
```

### Specific Test Suites

```bash
# Unit tests
bun test cli-args.test.ts

# E2E tests (requires SDK)
bun test e2e-cli.test.ts

# Integration tests (requires tmux)
bun test integration-tmux.test.ts
```

### Manual tmux POC

```bash
bun run test:tmux-poc
```

## Skipping When Dependencies Are Missing

Integration and E2E tests skip themselves with `describe.skipIf(...)` using `isTmuxAvailable()` / `isSDKBuilt()` from `test-utils.ts` (examples below).

## Test Structure

### Unit Tests

Test individual functions in isolation:

```typescript
import { describe, test, expect } from 'bun:test'

describe('CLI Arguments', () => {
  test('parses --agent flag', () => {
    // Test implementation
  })
})
```

### Integration Tests (tmux)

Test interactive CLI with full terminal emulation:

```typescript
import { describe, test, expect } from 'bun:test'
import { isTmuxAvailable } from './test-utils'

const tmuxAvailable = isTmuxAvailable()

describe.skipIf(!tmuxAvailable)('CLI Integration Tests', () => {
  test('handles user input', async () => {
    // Create tmux session
    // Send commands
    // Verify output
  })
})
```

### E2E Tests

Test complete CLI workflows:

```typescript
import { describe, test, expect } from 'bun:test'
import { isSDKBuilt } from './test-utils'

const sdkBuilt = isSDKBuilt()

describe.skipIf(!sdkBuilt)('CLI E2E Tests', () => {
  test('runs --help command', async () => {
    // Test CLI behavior
  })
})
```

## Test Utilities

Shared utilities in `test-utils.ts`:

```typescript
import { isTmuxAvailable, isSDKBuilt, sleep } from './test-utils'

// Check for tmux
if (isTmuxAvailable()) {
  // Run tmux tests
}

// Check for SDK
if (isSDKBuilt()) {
  // Run E2E tests
}

// Async delay
await sleep(1000)
```

## tmux Testing

**See [`../../tmux.knowledge.md`](../../tmux.knowledge.md) for comprehensive tmux documentation**, including:

- Why standard `send-keys` doesn't work (must use bracketed paste mode)
- Helper functions for Bash and TypeScript
- Complete example scripts
- Debugging and troubleshooting tips

**Quick reference:**

```typescript
// ❌ Broken:
await tmux(['send-keys', '-t', session, 'hello'])

// ✅ Works:
await tmux(['send-keys', '-t', session, '-l', '\x1b[200~hello\x1b[201~'])
```

## Debugging Tests

### View Test Output

```bash
# Verbose test output
bun test --verbose

# Watch mode
bun test --watch
```

## Contributing

When adding new tests:

1. **Follow naming convention** (`*integration*.test.ts` or `*e2e*.test.ts`)
2. **Use test-utils.ts** for shared functionality
3. **Add graceful skipping** for missing dependencies
4. **Clean up resources** (tmux sessions, temp files)
5. **Document test purpose** clearly in test descriptions

## Troubleshooting

### tmux Not Found

```
⚠️  tmux not found but required for integration/E2E tests
```

**Solution:** Install tmux (see Prerequisites above)

### SDK Not Built

```
✓ Build SDK for E2E tests: cd sdk && bun run build [skip]
```

**Solution:** Build the SDK first (see Prerequisites above)

### Tests Hanging

- Check tmux session isn't waiting for input
- Ensure proper cleanup in `finally` blocks
- Use timeouts for tmux operations

### Session Already Exists

- Use unique session names (e.g., timestamp suffix)
- Clean up sessions in `beforeEach`/`afterEach`

## Performance

- **Unit tests:** ~100ms total
- **Integration tests:** ~2-5s per test (tmux overhead)
- **E2E tests:** ~3-10s per test (full CLI startup)

## CI/CD

For CI environments:

```yaml
# Install tmux in CI
- name: Install tmux
  run: |
    sudo apt-get update
    sudo apt-get install -y tmux

# Run tests
- name: Run tests
  run: bun test
```
