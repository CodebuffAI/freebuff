---
name: code-review-checklist
description: Freebuff-specific code review checklist. Covers session lifecycle, auth flow, monorepo conventions, and known pitfalls.
license: MIT
metadata:
  category: development
  audience: developers
---

# Code Review Checklist

Freebuff-specific review guidance. Every claim here is verified against the current source tree.

## 1. Session Lifecycle

The freebuff session has **12+ statuses**, not a simple cycle. Key transitions:

- `none` → user picks a model → POST → `active` or `takeover_prompt`
- `active` → poll GET keeps it alive; expires → `ended`
- `ended` → grace window (instanceId present) → rejoin or timeout → `none`
- `superseded` → another CLI on the same account took over

**Terminal states** (no recovery without user action):
`country_blocked`, `banned`, `model_locked`, `rate_limited`, `spend_limited`, `ip_capped`, `model_unavailable`, `premium_slot_taken`

**Key invariant:** One free session per account, enforced server-side. When a second CLI starts, the first receives `superseded` or `takeover_prompt`.

Relevant files:
- `cli/src/hooks/use-freebuff-session.ts` — poll loop, state transitions
- `cli/src/state/freebuff-session-store.ts` — zustand store for session state
- `cli/src/components/freebuff-landing-screen.tsx` — model picker UI
- `common/src/types/freebuff-session.ts` — `FreebuffSessionServerResponse` type

## 2. Auth Flow

1. Browser OAuth → polling via `apiClient.loginStatus()`
2. On success: `saveUserCredentials(user)` writes to `~/.config/manicode/credentials.json`
3. `useAuthQuery` validates the stored API key by calling `getUserInfoFromApiKey()`
4. Token resolution: `getAuthTokenDetails()` checks credentials file → `CODEBUFF_API_KEY` env var

**Never commit or log:** `authToken`, `fingerprintHash`, `CODEBUFF_API_KEY`

Relevant files:
- `cli/src/utils/auth.ts` — credential storage (`saveUserCredentials`, `clearUserCredentials`)
- `cli/src/hooks/use-auth-query.ts` — login mutation, logout mutation, API key validation
- `cli/src/hooks/use-auth-state.ts` — `handleLoginSuccess`, auth state management
- `cli/src/components/login-modal.tsx` — TUI login modal

## 3. Known Pitfalls

### Bun mocks are process-wide
`mock.module()` leaks into other test files. The codebase uses `mockModule` from `@codebuff/common/testing/mock-modules` with `clearMockedModules` for cleanup. Prefer DI (pass mocked functions as arguments) over module mocking.

### `IS_FREEBUFF` guards
Defined at `cli/src/utils/constants.ts:9`. Gates all free-specific behavior. Always check whether new features should be behind this guard.

### Config directory
`cli/src/utils/config-dir.ts` returns `~/.config/manicode` (or `~/.config/manicode-<env>` for non-prod). Never hardcode the path — import `getConfigDir` from `./utils/config-dir`.

### Monorepo boundaries
Respect workspace boundaries: `cli/`, `sdk/`, `common/`, `agents/`, `packages/`. Cross-boundary imports must go through the published package, not relative paths.

## 4. Testing Conventions

- **Runtime:** Bun (`bun:test`, not jest/vitest)
- **Interactive CLI tests:** Run in tmux via `scripts/tmux/` helpers
- **DI preference:** Pass mocked functions as arguments rather than mocking modules
- **Test file location:** Co-located in `__tests__/` directories

## 5. Files That Break Things

| File | Risk |
|------|------|
| `cli/src/utils/auth.ts` | Credential storage — login/logout/profile changes |
| `cli/src/hooks/use-freebuff-session.ts` | Poll loop — complex async state machine with 12+ statuses |
| `cli/src/state/freebuff-session-store.ts` | Session state — read by React and non-React code |
| `cli/src/commands/command-registry.ts` | Slash commands — user-facing behavior |
| `sdk/src/index.ts` | Public API — breaking changes affect external users |
| `common/src/types/freebuff-session.ts` | Session response type — server contract |
