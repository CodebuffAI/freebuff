import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { getStubProjectFileContext } from '@codebuff/common/util/file'
import { describe, expect, test } from 'bun:test'

import { applyTerminalShell } from '../run'

/**
 * `terminalShell` (COD-642): a host whose broker runs its own shell (the
 * sponsored Windows floor runs Windows PowerShell 5.1) reports it as
 * `systemInfo.shell`, which is what the system prompt tells the model.
 */
describe('RunOptions.terminalShell', () => {
  const state = () =>
    getInitialSessionState({
      ...getStubProjectFileContext(),
      systemInfo: {
        ...getStubProjectFileContext().systemInfo,
        platform: 'win32',
        shell: 'bash',
      },
    })

  test('names the broker shell for the model', () => {
    const sessionState = state()
    applyTerminalShell(sessionState, 'powershell')
    expect(sessionState.fileContext.systemInfo.shell).toBe('powershell')
    expect(sessionState.fileContext.systemInfo.platform).toBe('win32')
  })

  test('unset leaves the default, so ordinary Windows runs stay on bash', () => {
    const sessionState = state()
    applyTerminalShell(sessionState, undefined)
    expect(sessionState.fileContext.systemInfo.shell).toBe('bash')
  })
})
