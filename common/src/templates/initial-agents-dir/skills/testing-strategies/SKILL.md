---
name: testing-strategies
description: A practical guide for writing effective tests across unit, integration, and end-to-end levels, with patterns for TypeScript and React projects
license: MIT
metadata:
  category: development
  audience: developers
---

# Testing Strategies

A practical guide for writing effective tests with the right scope, coverage, and patterns.

## When to use

Use this skill when asked to write tests, review test coverage, determine testing strategy, or improve test quality.

## Testing Pyramid

### 1. Unit Tests (fast, focused)

- Test individual functions, classes, or modules in isolation
- Mock external dependencies (APIs, databases, file system)
- Cover: core logic, edge cases, error paths, boundary conditions
- Goal: ~70% of your test suite

### 2. Integration Tests (medium, connective)

- Test how modules work together (API + database, service + repository)
- Use real dependencies when practical, test doubles for external services
- Cover: data flow, contract between layers, error propagation
- Goal: ~20% of your test suite

### 3. End-to-End Tests (slow, realistic)

- Test complete user flows through the system
- Use real infrastructure (test databases, staging APIs)
- Cover: critical user journeys, deployment verification
- Goal: ~10% of your test suite

## Test Patterns

### Arrange-Act-Assert

Structure every test with clear phases:

```typescript
// Arrange
const { result } = renderHook(() => useCounter())

// Act
act(() => result.current.increment())

// Assert
expect(result.current.count).toBe(1)
```

### Describe-It (Behavior-Driven)

Name tests as specifications:

```typescript
describe('UserService', () => {
  describe('getUser', () => {
    it('returns user when found', async () => { ... })
    it('throws NotFoundError when missing', async () => { ... })
    it('caches result on repeated calls', async () => { ... })
  })
})
```

### Dependency Injection over Mocking

Prefer passing dependencies rather than mocking:

```typescript
// Good: DI makes testing natural
class OrderService {
  constructor(
    private db: Database,
    private email: EmailService,
  ) {}
}

// Test
const service = new OrderService(mockDb, mockEmail)
```

### Test the Interface, Not Implementation

- Test public API behavior, not internal details
- Avoid testing private methods directly
- Refactoring internals shouldn't break tests

## What to Test

### Always Test

- Core business logic and calculations
- Edge cases: empty states, null values, error conditions
- Authentication and authorization
- Data validation and sanitization
- API error handling and status codes

### Sometimes Test

- UI component rendering (use snapshot tests sparingly)
- Integration with third-party services (use contract tests)
- Performance-critical paths

### Don't Test

- Generated code (scaffolds, ORM models)
- Simple getters/setters
- Language/stdlib features you didn't write
- Configuration constants (test the code that uses them instead)

## Quick Reference

> **Note:** The examples below use `describe`/`test`/`expect` which work with Vitest, Jest, and Bun's built-in test runner (`bun:test`).

```typescript
// Unit test example (Bun/Vitest compatible)
test('validateEmail rejects invalid emails', () => {
  expect(validateEmail('not-an-email')).toBe(false)
  expect(validateEmail('user@example.com')).toBe(true)
  expect(validateEmail('')).toBe(false)
  expect(validateEmail(null)).toBe(false)
})

// Async test with error
test('getUser throws on not found', async () => {
  await expect(
    userService.getUser('nonexistent-id'),
  ).rejects.toThrow('User not found')
})
```

## Quick Reference Commands

- `run_terminal_command` — Run tests with `bun test`, `npm test`, or `npx vitest run`
- `read_files` — Read test files and source files
- `code_search` — Find related test patterns or coverage gaps

## Notes

- Write tests in the same language as your production code
- Keep tests simple — no conditional logic, loops, or complex abstractions
- A failing test should tell you what's wrong from the error message alone
- Run the specific test file, not the whole suite, during development
