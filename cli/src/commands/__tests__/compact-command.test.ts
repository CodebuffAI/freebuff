import { describe, expect, test } from 'bun:test'

describe('/compact command', () => {
  test('sends the runtime its exact command, or waits out a running turn', () => {
    const commandRegistryUrl = new URL(
      '../command-registry.ts',
      import.meta.url,
    ).href
    const slashCommandsUrl = new URL(
      '../../data/slash-commands.ts',
      import.meta.url,
    ).href

    const result = Bun.spawnSync({
      cmd: [
        'bun',
        '--eval',
        `
          import assert from 'node:assert/strict'
          import { findCommand } from ${JSON.stringify(commandRegistryUrl)}
          import { SLASH_COMMANDS } from ${JSON.stringify(slashCommandsUrl)}

          assert(SLASH_COMMANDS.some((cmd) => cmd.id === 'compact'))
          const compact = findCommand('compact')
          assert(compact)

          const sent = []
          const queued = []
          const noop = () => {}
          const params = (streaming) => ({
            agentMode: 'DEFAULT',
            inputValue: '/compact',
            isStreaming: streaming,
            streamMessageIdRef: { current: null },
            isChainInProgressRef: { current: false },
            inputRef: { current: null },
            saveToHistory: noop,
            setInputValue: noop,
            setInputFocused: noop,
            scrollToLatest: noop,
            sendMessage: (message) => sent.push(message),
            addToQueue: (message) => queued.push(message),
          })

          await compact.handler(params(false), '')
          assert.deepEqual(sent, [{ content: '/compact', agentMode: 'DEFAULT' }])
          assert.deepEqual(queued, [])

          await compact.handler(params(true), '')
          assert.equal(sent.length, 1)
          assert.deepEqual(queued, ['/compact'])
        `,
      ],
      env: { ...process.env },
      stderr: 'pipe',
      stdout: 'pipe',
    })

    expect(result.stderr.toString()).not.toContain('error:')
    expect(result.exitCode).toBe(0)
  })
})
