import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { getStubProjectFileContext } from '@codebuff/common/util/file'
import { describe, expect, test } from 'bun:test'

import { applyHostPlatform, applyTerminalShell } from '../run'

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

/**
 * `hostPlatform`: a hosted runner (Linux) driving a user's Windows computer
 * reports that computer's platform, so the model gets the Windows note
 * instead of the runner's "linux".
 */
describe('RunOptions.hostPlatform', () => {
  const runnerState = () =>
    getInitialSessionState({
      ...getStubProjectFileContext(),
      systemInfo: {
        ...getStubProjectFileContext().systemInfo,
        platform: 'linux',
        shell: 'bash',
      },
    })

  test("names the user's computer's platform, keeping the shell", () => {
    const sessionState = runnerState()
    applyHostPlatform(sessionState, 'win32')
    expect(sessionState.fileContext.systemInfo.platform).toBe('win32')
    expect(sessionState.fileContext.systemInfo.shell).toBe('bash')
  })

  test("unset keeps this process's platform", () => {
    const sessionState = runnerState()
    applyHostPlatform(sessionState, undefined)
    expect(sessionState.fileContext.systemInfo.platform).toBe('linux')
  })
})
