import { describe, expect, it } from 'bun:test'

import { summarizeGitChangesForCommit } from '../git-commit-summary'

describe('summarizeGitChangesForCommit', () => {
  it('summarizes the reported AI instructions and changelog changes from actual files', () => {
    expect(
      summarizeGitChangesForCommit({
        status: ' M AGENTS.md\n?? CHANGELOG.md',
      }),
    ).toBe('Update AI agent instructions and add changelog')
  })

  it('does not need the user prompt to produce a meaningful title', () => {
    expect(
      summarizeGitChangesForCommit({
        status: ' M src/components/LoginButton.tsx\n M src/auth/session.ts',
      }),
    ).toBe('Update LoginButton and Session')
  })

  it('uses diff metadata when status is unavailable', () => {
    expect(
      summarizeGitChangesForCommit({
        diffCached: `diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 91%
rename from src/old-name.ts
rename to src/new-name.ts
diff --git a/docs/setup.md b/docs/setup.md
index 1111111..2222222 100644
--- a/docs/setup.md
+++ b/docs/setup.md`,
      }),
    ).toBe('Update New Name and Setup')
  })

  it('falls back to a generic change summary when no git changes are present', () => {
    expect(summarizeGitChangesForCommit({})).toBe('Update project files')
  })
})
