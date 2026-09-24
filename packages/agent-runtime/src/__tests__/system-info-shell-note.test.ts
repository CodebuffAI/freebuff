import { getStubProjectFileContext } from '@codebuff/common/util/file'
import { describe, expect, test } from 'bun:test'

import { getSystemInfoPrompt } from '../system-prompt/prompts'

const promptFor = (systemInfo: { platform: string; shell: string }) =>
  getSystemInfoPrompt({
    ...getStubProjectFileContext(),
    systemInfo: {
      ...getStubProjectFileContext().systemInfo,
      ...systemInfo,
    },
  })

/**
 * The shell note the model reads must describe the shell that will run its
 * commands. The sponsored Windows floor (COD-642) runs Windows PowerShell 5.1,
 * where `&&`, `rm -rf` and `2>/dev/null` are errors; every other Windows run
 * goes through Git Bash and keeps the bash note.
 */
describe('the system info shell note', () => {
  test('a PowerShell host is told PowerShell, and never that it is bash', () => {
    const prompt = promptFor({ platform: 'win32', shell: 'powershell' })
    expect(prompt).toContain('Windows PowerShell 5.1')
    expect(prompt).toContain('$LASTEXITCODE')
    expect(prompt).toContain('$env:')
    expect(prompt).toContain('Remove-Item -Recurse -Force')
    expect(prompt).toContain('$null')
    expect(prompt).toContain('Shell: powershell')
    expect(prompt).not.toContain('terminal commands run in bash')
  })

  test('an ordinary Windows run keeps the Git Bash note', () => {
    const prompt = promptFor({ platform: 'win32', shell: 'bash' })
    expect(prompt).toContain('terminal commands run in bash on Windows')
    expect(prompt).not.toContain('PowerShell 5.1')
  })

  test('macOS and Linux get neither note', () => {
    for (const platform of ['darwin', 'linux']) {
      const prompt = promptFor({ platform, shell: 'bash' })
      expect(prompt).not.toContain('terminal commands run in bash on Windows')
      expect(prompt).not.toContain('PowerShell 5.1')
    }
  })
})
