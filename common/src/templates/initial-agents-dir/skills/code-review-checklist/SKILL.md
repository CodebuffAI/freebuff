---
name: code-review-checklist
description: A comprehensive code review checklist that guides agents through reviewing code changes for correctness, maintainability, performance, and security
license: MIT
metadata:
  category: development
  audience: developers
---

# Code Review Checklist

A structured code review checklist for reviewing code changes systematically.

## When to use

Use this skill when asked to review code changes, perform a code review, or check for common issues in pull requests.

## Review Dimensions

### 1. Correctness

- Do the changes actually solve the described problem?
- Are edge cases handled (empty states, null values, error conditions)?
- Are there any race conditions or timing issues?
- Do the changes break existing functionality?

### 2. Maintainability

- Is the code readable and self-documenting?
- Are functions and variables named clearly?
- Is there unnecessary complexity that could be simplified?
- Are there good comments explaining "why" (not "what")?
- Would a new team member understand this code?

### 3. Performance

- Are there any obvious performance bottlenecks?
- Are there unnecessary re-renders, recomputations, or network calls?
- Are large data structures handled efficiently?
- Is there proper memoization where appropriate?

### 4. Security

- Are user inputs properly validated and sanitized?
- Are there any injection vulnerabilities (SQL, XSS, command injection)?
- Are authentication/authorization checks in place?
- Are secrets/hardcoded credentials exposed?
- Are proper security headers or CSP policies applied?

### 5. Testing

- Are there tests for the new code?
- Do existing tests still pass?
- Are edge cases covered by tests?
- Are test names descriptive?
- Are there integration or e2e tests for critical paths?

### 6. Architecture

- Does the change follow the project's established patterns?
- Are new dependencies justified?
- Is the code placed in the right module/layer?
- Does it introduce unnecessary coupling or circular dependencies?

## Output Format

Summarize findings as:

- 🔴 **Critical**: Must fix before merging
- 🟡 **Warning**: Should address soon
- 🟢 **Suggestion**: Nice to have improvement
- ✅ **Praise**: Something done well

## Manual Testing Checklist (UI Changes)

If review involves UI changes, also check:

- Responsive/mobile layout
- Loading states and skeletons
- Error states and error messages
- Empty states
- Keyboard navigation and accessibility
- Dark/light theme compatibility (if applicable)
- Console errors or warnings

## Quick Reference Commands

When reviewing code, you can use these tools:

- `read_files` — Read the changed files in full
- `code_search` — Search for related patterns or usages
- `run_terminal_command` — Run tests or linters

## Notes

- Be constructive, not critical. Suggest solutions, not just problems.
- Prioritize findings: security > correctness > performance > maintainability > style
- If unsure about a finding, mark it as a question rather than assuming the worst
