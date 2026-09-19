import { describe, expect, test } from 'bun:test'
import path from 'node:path'

import {
  compressCompletedTerminalResult,
  EverestBridge,
  isEligibleEverestCommand,
} from '../everest-compression'

const command =
  '# coact-focus: Which test names and assertion lines fail?\nbun test'
const longOutput = 'failing test detail\n'.repeat(150)

describe('optional Everest terminal result transformation', () => {
  test('short, raw, and unfocused output never reaches the bridge', async () => {
    expect(isEligibleEverestCommand(command, 'short')).toBe(false)
    expect(
      isEligibleEverestCommand('# coact-focus: raw\nbun test', longOutput),
    ).toBe(false)
    expect(isEligibleEverestCommand('bun test', longOutput)).toBe(false)
    let calls = 0
    const part = { type: 'json', value: { stdout: 'short', exitCode: 0 } }
    const result = await compressCompletedTerminalResult(
      [part],
      command,
      'task',
      '/tmp',
      async () => {
        calls++
        return 'changed'
      },
    )
    expect(result[0]).toBe(part)
    expect(calls).toBe(0)
  })

  test('rewrites each eligible stream but preserves exit code and metadata', async () => {
    const part = {
      type: 'json',
      value: {
        command,
        stdout: longOutput,
        stderr: longOutput,
        exitCode: 0,
        detail: 'keep',
      },
    }
    const seen: string[] = []
    const result = await compressCompletedTerminalResult(
      [part],
      command,
      'fix failing tests',
      '/tmp',
      async (cmd, output, goal, cwd) => {
        expect(cmd).toBe(command)
        expect(output).toBe(longOutput)
        expect(goal).toBe('fix failing tests')
        expect(cwd).toBe('/tmp')
        seen.push(output)
        return 'focused result'
      },
    )
    expect(seen).toHaveLength(2)
    expect(result[0]?.value).toEqual({
      ...part.value,
      stdout: 'focused result',
      stderr: 'focused result',
    })
  })

  test('never changes failed or interrupted command diagnostics', async () => {
    const failed = {
      type: 'json',
      value: { stdout: longOutput, stderr: longOutput, exitCode: 1 },
    }
    const interrupted = {
      type: 'json',
      value: { stdout: longOutput, message: 'Command interrupted' },
    }
    let calls = 0
    const result = await compressCompletedTerminalResult(
      [failed, interrupted],
      command,
      'task',
      '/tmp',
      async () => {
        calls++
        return 'changed'
      },
    )
    expect(result).toEqual([failed, interrupted])
    expect(calls).toBe(0)
  })

  test('a bridge failure leaves the original stream unchanged', async () => {
    const part = { type: 'json', value: { stdout: longOutput, exitCode: 0 } }
    const result = await compressCompletedTerminalResult(
      [part],
      command,
      'task',
      '/tmp',
      async () => {
        throw new Error('unavailable')
      },
    )
    expect(result[0]).toBe(part)
  })
})

describe('Everest bridge protocol', () => {
  const fixture = path.join(
    import.meta.dir,
    'fixtures',
    'everest-bridge-fixture.js',
  )
  const makeBridge = () => new EverestBridge(process.execPath, [fixture], 200)

  test('correlates concurrent responses received out of order', async () => {
    const bridge = makeBridge()
    try {
      const [first, second] = await Promise.all([
        bridge.request('first', 'one', 'task', '/tmp'),
        bridge.request('second', 'two', 'task', '/tmp'),
      ])
      expect(first).toBe('compressed:one')
      expect(second).toBe('compressed:two')
    } finally {
      bridge.close()
    }
  })

  test('keeps original output when response says compression was not applied', async () => {
    const bridge = makeBridge()
    try {
      expect(
        await bridge.request('not-applied', 'original', 'task', '/tmp'),
      ).toBe('original')
    } finally {
      bridge.close()
    }
  })

  test.each(['malformed', 'wrong-id', 'silent'])(
    '%s response fails open without returning untrusted text',
    async (command) => {
      const bridge = makeBridge()
      try {
        await expect(
          bridge.request(command, 'original', 'task', '/tmp'),
        ).rejects.toThrow('everest_unavailable')
      } finally {
        bridge.close()
      }
    },
  )

  test('missing Everest executable fails open', async () => {
    const bridge = new EverestBridge('/nonexistent/everest-cli-test', [], 200)
    try {
      await expect(bridge.request('test', 'original', 'task', '/tmp')).rejects.toThrow(
        'everest_unavailable',
      )
    } finally {
      bridge.close()
    }
  })

  test('shutdown rejects pending calls', async () => {
    const bridge = makeBridge()
    const pending = bridge.request('silent', 'original', 'task', '/tmp')
    bridge.close()
    await expect(pending).rejects.toThrow('everest_unavailable')
  })

  test('run cancellation stops waiting for a bridge response', async () => {
    const bridge = makeBridge()
    const controller = new AbortController()
    const pending = bridge.request(
      'silent',
      'original',
      'task',
      '/tmp',
      controller.signal,
    )
    controller.abort()
    await expect(pending).rejects.toThrow('everest_unavailable')
    expect(bridge.isClosed).toBe(true)
    const nextRun = makeBridge()
    try {
      expect(await nextRun.request('second', 'new run', 'task', '/tmp')).toBe(
        'compressed:new run',
      )
    } finally {
      nextRun.close()
    }
  })
})
