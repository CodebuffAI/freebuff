# SDK Tests & Examples

This folder contains end-to-end tests, integration tests, unit tests, and runnable examples for the Codebuff SDK.

## Directory Structure

```
sdk/e2e/
├── streaming/          # E2E tests for streaming behavior
├── workflows/          # E2E tests for multi-step workflows  
├── custom-agents/      # E2E tests for custom agent & tool integration
├── features/           # E2E tests for SDK feature coverage
├── integration/        # Integration tests (SDK + API mechanics)
├── examples/           # Runnable example scripts (not tests)
└── utils/              # Shared utilities
    ├── __tests__/      # Unit tests for utilities
    ├── event-collector.ts
    ├── get-api-key.ts
    └── test-fixtures.ts
```

## Test Categories

### E2E Tests (`test:e2e`)
Full end-to-end tests that exercise complete user workflows with real API calls.

```bash
bun run test:e2e
```

| Category | Description |
|----------|-------------|
| `streaming/` | Subagent streaming, concurrent streams |
| `workflows/` | Multi-turn conversations, error recovery |
| `custom-agents/` | Custom agents with custom tools |
| `features/` | projectFiles, knowledgeFiles, maxAgentSteps |

### Integration Tests (`test:integration`)
Tests that verify SDK + API integration mechanics.

```bash
bun run test:integration
```

| Test | Description |
|------|-------------|
| `event-types` | Validates all PrintModeEvent types are emitted |
| `event-ordering` | Validates event sequence (start → content → finish) |
| `stream-chunks` | Tests handleStreamChunk callback |
| `connection-check` | Tests checkConnection() method |

### Unit Tests (`test`)
Pure unit tests with no external dependencies. `bun run test` runs them with the
rest of the SDK unit tests (`e2e/utils/**/*.test.ts` is included).

```bash
bun run test
```

| Test | Description |
|------|-------------|
| `event-collector.test.ts` | Tests EventCollector utility class |

### Examples
Runnable scripts demonstrating SDK usage patterns. Not tests - just examples!

```bash
# Run an example
bun run sdk/e2e/examples/code-reviewer.example.ts
```

| Example | Description |
|---------|-------------|
| `code-reviewer.example.ts` | AI code review |
| `code-explainer.example.ts` | Explain code in plain English |
| `commit-message-generator.example.ts` | Generate commit messages from diffs |
| `sdk-lint.example.ts` | AI-powered linter |
| `sdk-refactor.example.ts` | Code refactoring |
| `sdk-test-gen.example.ts` | Unit test generation |

## Running All Tests

```bash
# All E2E tests
bun run test:e2e

# All integration tests
bun run test:integration

# All unit tests
bun run test

# Everything
bun run test:e2e && bun run test:integration && bun run test
```

## Prerequisites

- **API Key**: Set `CODEBUFF_API_KEY` for E2E and integration tests
- **Opt-in**: Set `RUN_CODEBUFF_E2E=true` for local live API runs (CI runs automatically)
- Tests skip gracefully if API key is not set

## Writing Tests

### E2E Test Pattern
```typescript
import { describe, test, expect, beforeAll } from 'bun:test'
import { CodebuffClient } from '../../src/client'
import { EventCollector, getApiKey, skipIfNoApiKey, isAuthError, DEFAULT_AGENT, DEFAULT_TIMEOUT } from '../utils'

describe('E2E: My Test', () => {
  let client: CodebuffClient

  beforeAll(() => {
    if (skipIfNoApiKey()) return
    client = new CodebuffClient({ apiKey: getApiKey() })
  })

  test('does something', async () => {
    if (skipIfNoApiKey()) return
    const collector = new EventCollector()
    
    const result = await client.run({
      agent: DEFAULT_AGENT,
      prompt: 'Test prompt',
      handleEvent: collector.handleEvent,
    })

    if (isAuthError(result.output)) return
    
    expect(result.output.type).not.toBe('error')
  }, DEFAULT_TIMEOUT)
})
```

### Unit Test Pattern
```typescript
import { describe, test, expect, beforeEach } from 'bun:test'
import { EventCollector } from '../event-collector'

describe('Unit: EventCollector', () => {
  let collector: EventCollector

  beforeEach(() => {
    collector = new EventCollector()
  })

  test('collects events', () => {
    collector.handleEvent({ type: 'start', messageHistoryLength: 0 })
    expect(collector.events).toHaveLength(1)
  })
})
```
