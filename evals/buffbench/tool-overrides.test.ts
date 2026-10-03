import { describe, expect, it } from 'bun:test'

import { benchToolOverrides, isUpstreamUrl } from './tool-overrides'

const tokens = ['codebuffai', 'codebuff']

describe('buffbench read_url guard', () => {
  it.each([
    'https://github.com/CodebuffAI/codebuff/commit/abc123',
    'https://raw.githubusercontent.com/CodebuffAI/codebuff/main/sdk/src/run-state.ts',
    'https://api.github.com/repos/CodebuffAI/codebuff/commits?path=sdk/src/run-state.ts',
    'https://codeload.github.com/CodebuffAI/codebuff/tar.gz/main',
    // a fork under another owner, and one renamed with a suffix
    'https://raw.githubusercontent.com/someone-else/codebuff/main/README.md',
    'https://raw.githubusercontent.com/syntax-syndicate/codebuff-v0/main/common/src/types/agent-template.ts',
    'https://api.github.com/repos/syntax-syndicate/codebuff-v0/commits?path=backend/src/run-programmatic-step.ts&per_page=100',
    'https://github.com/syntax-syndicate/codebuff_mirror/blob/main/README.md',
    'https://github.com/syntax-syndicate/codebuff.git',
    // the published packages and the docs, which describe the API after the commit
    'https://unpkg.com/@codebuff/sdk@1.0.0/dist/index.js',
    'https://www.npmjs.com/package/@codebuff/sdk',
    'https://www.codebuff.com/docs/advanced/sdk',
    'https://codebuffai-codebuff.mintlify.app/sdk',
  ])('refuses %s', (url) => {
    expect(isUpstreamUrl(url, tokens)).toBe(true)
  })

  it.each([
    'https://github.com/vercel/ai/blob/main/packages/ai/README.md',
    'https://example.com/docs/codebuffer/getting-started',
    'https://developer.mozilla.org/en-US/docs/Web/API/URL',
    'https://www.npmjs.com/package/zod',
    'not a url',
  ])('allows %s', (url) => {
    expect(isUpstreamUrl(url, tokens)).toBe(false)
  })

  it('answers a refused read with an error instead of fetching', async () => {
    const tools = benchToolOverrides({
      repoUrl: 'https://github.com/CodebuffAI/codebuff',
    })
    const out = await tools.read_url!({
      url: 'https://raw.githubusercontent.com/syntax-syndicate/codebuff-v0/main/README.md',
    })
    expect(JSON.stringify(out)).toContain(
      'does not allow reading the evaluated repository',
    )
  })
})
