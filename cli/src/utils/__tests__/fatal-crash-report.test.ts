import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  recordFatalCrashSync,
  takePreviousFatalCrash,
} from '../fatal-crash-report'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-fatal-crash-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('a fatal error is recorded for the next launch to ship, exactly once', () => {
  const error = new Error(
    'Minified React error #185; visit https://react.dev/errors/185 ' +
      'x'.repeat(1_000),
  )
  error.stack = [
    `Error: ${error.message}`,
    ...Array.from({ length: 40 }, (_, i) => `    at frame${i} (file.ts:${i})`),
  ].join('\n')

  recordFatalCrashSync(
    'Unhandled rejection',
    error,
    {
      heldFreebuffSession: true,
    },
    dir,
  )

  const report = takePreviousFatalCrash(dir)
  expect(report).toMatchObject({
    label: 'Unhandled rejection',
    errorName: 'Error',
    heldFreebuffSession: true,
    platform: process.platform,
  })
  // bounded payload
  expect(report!.errorMessage.length).toBe(300)
  expect(report!.errorMessage).toContain('#185')
  expect(report!.stack!.split('\n')).toHaveLength(21)
  // consumed: a second launch does not report it again
  expect(takePreviousFatalCrash(dir)).toBeUndefined()
  expect(readdirSync(dir)).toEqual([])
})

test('non-Error rejections and unprintable values are still recorded', () => {
  const unprintable = {
    toString() {
      throw new Error('nope')
    },
  }
  recordFatalCrashSync(
    'Uncaught exception',
    unprintable,
    {
      heldFreebuffSession: false,
    },
    dir,
  )
  expect(takePreviousFatalCrash(dir)).toMatchObject({
    errorName: 'object',
    errorMessage: '<unprintable error>',
  })
})

test('a stale or corrupt report is dropped, never shipped', () => {
  const file = join(dir, 'last-fatal-crash.json')
  writeFileSync(file, '{not json')
  expect(takePreviousFatalCrash(dir)).toBeUndefined()
  expect(existsSync(file)).toBe(false)

  recordFatalCrashSync(
    'Uncaught exception',
    new Error('old'),
    {
      heldFreebuffSession: false,
    },
    dir,
  )
  expect(
    takePreviousFatalCrash(dir, Date.now() + 8 * 24 * 60 * 60 * 1000),
  ).toBeUndefined()
})

test('recording never throws, even when the directory is unusable', () => {
  const blocker = join(dir, 'file')
  writeFileSync(blocker, '')
  expect(() =>
    recordFatalCrashSync(
      'Uncaught exception',
      new Error('x'),
      {
        heldFreebuffSession: false,
      },
      join(blocker, 'nested'),
    ),
  ).not.toThrow()
})
