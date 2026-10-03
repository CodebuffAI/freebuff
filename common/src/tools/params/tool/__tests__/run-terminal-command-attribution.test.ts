import { describe, expect, test } from 'bun:test'

import {
  buildGitCommitGuidePrompt,
  gitCommitGuidePrompt,
  runTerminalCommandNoAttributionDescription,
  runTerminalCommandParams,
} from '../run-terminal-command'

/**
 * Every spelling of the trailer that has ever shipped in this description.
 *
 * Asserted as a LIST rather than as one string because the guidance carries it
 * twice, in two different orders (`Generated with Codebuff 🤖` in the footer
 * block, `🤖 Generated with Codebuff` in the HEREDOC), and a suppression that
 * removed only one of them would still put a co-author line in a stranger's
 * repository.
 */
const ATTRIBUTION_MARKERS = [
  'Co-Authored-By',
  'noreply@codebuff.com',
  'Generated with Codebuff',
  '🤖',
]

describe('run_terminal_command commit attribution', () => {
  test('the default still teaches the trailer, in both spellings', () => {
    for (const marker of ATTRIBUTION_MARKERS) {
      expect(gitCommitGuidePrompt).toContain(marker)
      expect(runTerminalCommandParams.description).toContain(marker)
    }
    // The description is what actually reaches the model; the guide alone is
    // not enough, because the description also ships a worked `git commit`
    // example. Both halves must carry it, or the default has changed.
    expect(
      runTerminalCommandParams.description.split('Co-Authored-By').length - 1,
    ).toBeGreaterThanOrEqual(2)
  })

  test('the suppressed variant never MODELS the trailer', () => {
    // `Co-Authored-By` and `Generated with` still appear in the suppressed
    // variant, and that is deliberate: the prohibition names the exact strings
    // it forbids, which is stronger than "no trailer" and is why it is asserted
    // rather than banned. What must be gone is every place the trailer is
    // MODELLED -- the footer step and the worked example -- so the check is
    // "no marker survives once the prohibition sentence is removed", not "the
    // words never occur".
    const prohibition =
      /Do NOT add any trailer[^\n]*\n/g
    for (const text of [
      buildGitCommitGuidePrompt({ attribution: false }),
      runTerminalCommandNoAttributionDescription,
    ]) {
      expect(text).toMatch(prohibition)
      const withoutProhibition = text.replace(prohibition, '')
      for (const marker of ATTRIBUTION_MARKERS) {
        expect(withoutProhibition).not.toContain(marker)
      }
      // The address and the emoji are never needed to state the rule, so they
      // must be absent outright.
      expect(text).not.toContain('noreply@codebuff.com')
      expect(text).not.toContain('🤖')
    }
  })

  test('suppression removes the EXAMPLE too, not only the prose', () => {
    // The failure mode this guards. A "do not add a trailer" sentence sitting
    // beside a worked `git commit -m` example that contains one is a prose
    // instruction losing to a concrete demonstration, which is the ordinary
    // way this goes wrong. The example is rewritten, not merely contradicted.
    // The examples are JSON-encoded into the description, so the quotes are
    // escaped; match the encoded form the model actually reads.
    const withTrailer = String.raw`git commit -m \"Your commit message here.\n\n`
    expect(runTerminalCommandParams.description).toContain(withTrailer)
    expect(runTerminalCommandNoAttributionDescription).toContain(
      String.raw`git commit -m \"Your commit message here.\"`,
    )
    expect(runTerminalCommandNoAttributionDescription).not.toContain(
      withTrailer,
    )
    expect(runTerminalCommandNoAttributionDescription).toContain(
      'Do NOT add any trailer',
    )
  })

  test('suppression changes ONLY the commit guidance', () => {
    // Everything a normal run relies on is still there: the two variants differ
    // in the step-4 block and the second example and nowhere else.
    const commitHeading = '### Using git to commit changes'
    const executionGuidance = runTerminalCommandParams.description.split(
      commitHeading,
    )[0]
    expect(executionGuidance.trim().length).toBeGreaterThan(0)
    expect(
      runTerminalCommandNoAttributionDescription.split(commitHeading)[0],
    ).toBe(executionGuidance)
    for (const shared of [
      'Authorization:',
      'Execution:',
      "The user's request authorizes the ordinary steps reasonably necessary to complete it.",
      'A coding request alone does not authorize publishing, pushing, deploying, modifying production data, deleting unrelated data, or changing system-wide settings.',
      'If a tool refuses an action, respect the refusal; do not bypass it.',
      commitHeading,
      'Change git configuration only when the task requires it; prefer repository-local settings.',
      'Do not create an empty commit if there are no changes.',
      String.raw`echo \"hello world\"`,
    ]) {
      expect(runTerminalCommandParams.description).toContain(shared)
      expect(runTerminalCommandNoAttributionDescription).toContain(shared)
    }
  })

  test('buildGitCommitGuidePrompt(true) is the shipped default', () => {
    expect(buildGitCommitGuidePrompt({ attribution: true })).toBe(
      gitCommitGuidePrompt,
    )
  })
})
