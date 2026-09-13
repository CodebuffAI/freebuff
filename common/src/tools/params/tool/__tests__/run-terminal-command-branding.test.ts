import { describe, expect, it } from 'bun:test'

import { getGitCommitGuidePrompt } from '../run-terminal-command'

describe('getGitCommitGuidePrompt', () => {
  it('keeps Codebuff attribution for the standard build', () => {
    const prompt = getGitCommitGuidePrompt(false)

    expect(prompt).toContain('Generated with Codebuff 🤖')
    expect(prompt).toContain('Co-Authored-By: Codebuff <noreply@codebuff.com>')
    expect(prompt).not.toContain('Generated with Freebuff')
  })

  it('uses Freebuff attribution for Freebuff builds', () => {
    const prompt = getGitCommitGuidePrompt(true)

    expect(prompt).toContain('Generated with Freebuff 🤖')
    expect(prompt).toContain('Co-Authored-By: Freebuff <noreply@freebuff.com>')
    expect(prompt).not.toContain('Generated with Codebuff')
  })
})
