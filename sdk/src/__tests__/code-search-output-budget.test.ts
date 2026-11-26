import { expect, it } from 'bun:test'
import { PassThrough } from 'stream'

import { codeSearch } from '../tools/code-search'

import type { TerminalCommandBroker } from '../tools/run-terminal-command'

it('stops streaming when context lines exhaust the output budget', async () => {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const signals: (NodeJS.Signals | undefined)[] = []
  let finish!: (code: number | null) => void
  const processBroker: TerminalCommandBroker = {
    start: () => ({
      stdout,
      stderr,
      completion: new Promise((resolve) => {
        finish = resolve
      }),
      kill: (signal) => {
        signals.push(signal)
      },
      isAlive: () => true,
    }),
  }
  const search = codeSearch({
    projectPath: '/test/project',
    pattern: 'needle',
    flags: '-A 10',
    maxOutputStringLength: 128,
    processBroker,
  })
  let settled = false
  void search.then(() => {
    settled = true
  })
  const event = (type: string, line: number, text: string) =>
    JSON.stringify({
      type,
      data: {
        path: { text: 'file.ts' },
        line_number: line,
        lines: { text: text + '\n' },
      },
    }) + '\n'

  try {
    stdout.write(event('match', 1, 'needle'))
    for (let line = 2; line <= 11; line++) {
      stdout.write(event('context', line, 'x'.repeat(80)))
    }
    await new Promise((resolve) => setImmediate(resolve))

    // The process has not exited: reaching the budget must settle the search.
    expect(settled).toBe(true)
    expect(signals).toEqual(['SIGTERM'])
    const [result] = await search
    expect(result.type).toBe('json')
    if (result.type !== 'json') throw new Error('Expected JSON search output')
    expect(result.value).toMatchObject({
      message: 'Stopped early after 1 match(es).',
    })
    expect(result.value).toHaveProperty(
      'stdout',
      expect.stringContaining('[Output size limit reached.]'),
    )
    expect(result.value).toHaveProperty(
      'stdout',
      expect.stringContaining('Found 1 matches'),
    )
  } finally {
    finish(0)
    await search
    stdout.destroy()
    stderr.destroy()
  }
})
