import fs from 'fs'
import os from 'os'
import path from 'path'

import { describe, expect, it } from 'bun:test'

import {
  benchToolOverrides,
  isUpstreamCommand,
  isUpstreamUrl,
} from './tool-overrides'

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
      cwd: os.tmpdir(),
    })
    const out = await tools.read_url!({
      url: 'https://raw.githubusercontent.com/syntax-syndicate/codebuff-v0/main/README.md',
    })
    expect(JSON.stringify(out)).toContain(
      'does not allow reading the evaluated repository',
    )
  })
})

describe('buffbench terminal guard', () => {
  it.each([
    // base3's own commands in the leaking 2026-10-08 run
    'git ls-remote https://github.com/CodebuffAI/codebuff.git HEAD',
    'cd /tmp && git clone --filter=blob:none https://github.com/CodebuffAI/codebuff.git up',
    'timeout 20 npm view @codebuff/sdk versions --json',
    'wget -qO- "https://raw.githubusercontent.com/CodebuffAI/codebuff/main/sdk/src/client.ts"',
    'npm pack @codebuff/sdk@0.1.9',
  ])('refuses %s', (command) => {
    expect(isUpstreamCommand(command, tokens)).toBe(true)
  })

  it.each([
    'git log --oneline -20',
    'cat codebuff.json',
    'cd /tmp/codebuff-eval-hQJEJJ/repo/sdk && bun run typecheck',
    'bun install && bun --filter @codebuff/sdk run test',
    'git clone https://github.com/vercel/ai /tmp/ai',
    'npm view zod versions',
  ])('allows %s', (command) => {
    expect(isUpstreamCommand(command, tokens)).toBe(false)
  })

  it('refuses without running, and runs the rest in the checkout', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-guard-'))
    const tools = benchToolOverrides({
      repoUrl: 'https://github.com/CodebuffAI/codebuff',
      cwd,
      env: { BENCH_GUARD_TEST: 'from-env' },
    })
    const run = (command: string) =>
      tools.run_terminal_command!({
        command,
        process_type: 'SYNC',
        timeout_seconds: 30,
      }).then((out) => JSON.stringify(out))

    expect(
      await run(
        'git clone https://github.com/CodebuffAI/codebuff x; touch ran',
      ),
    ).toContain('does not allow reading')
    expect(fs.existsSync(path.join(cwd, 'ran'))).toBe(false)
    const ran = await run('basename "$(pwd)" && echo $BENCH_GUARD_TEST')
    expect(ran).toContain(path.basename(cwd))
    expect(ran).toContain('from-env')
    fs.rmSync(cwd, { recursive: true, force: true })
  })
})
