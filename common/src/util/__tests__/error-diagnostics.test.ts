import { describe, expect, test } from 'bun:test'

import { errorClassChain, normalizeErrorMessage } from '../error-diagnostics'

describe('normalizeErrorMessage', () => {
  test.each([
    // Node and Bun quote the path they failed on.
    [
      "ENOENT: no such file or directory, open '/Users/jane/Library/Application Support/Freebuff/hosted-runtime-transfers/9f2c.json'",
      'ENOENT: no such file or directory, open <path>',
    ],
    ['EPERM: operation not permitted, mkdir C:\\Users\\Jane\\AppData\\Roaming\\Freebuff', 'EPERM: operation not permitted, mkdir <path>'],
    ['Could not read ~/code/garden/package.json.', 'Could not read <path>.'],
    ['Could not open \\\\nas\\share\\garden', 'Could not open <path>'],
    ['Cannot stat src/components/app.tsx (missing)', 'Cannot stat <path> (missing)'],
    // A folder or branch name the user chose, quoted in any style.
    [
      'The local checkout changed: this chat was started in another folder ("acme-payroll"). Open "acme-payroll" to continue this chat.',
      'The local checkout changed: this chat was started in another folder (<q>). Open <q> to continue this chat.',
    ],
    ["fatal: invalid reference: 'feature/jane-secret-launch'", 'fatal: invalid reference: <path>'],
    ['Branch `jane-wip` already exists', 'Branch <q> already exists'],
    ['Folder “Client Work” is missing', 'Folder <q> is missing'],
    ['Signed in as jane.doe+work@example.co.uk, not owner@example.com', 'Signed in as <email>, not <email>'],
    [
      'request to https://www.codebuff.com/api/v1/cloud/history/chats/abc?token=secret failed',
      'request to <url> failed',
    ],
    ['connect ECONNREFUSED 127.0.0.1:54321', 'connect ECONNREFUSED <ip>'],
    [
      'Chat 0f8c2d7e-5b1a-4c3d-9e2f-1a2b3c4d5e6f in project desktop-5d41402abc4b2a76b9719d911017c592 is gone',
      'Chat <id> in project <id> is gone',
    ],
    ['Convex id jd7f3k2m9q8w4e6r1t5y has no row', 'Convex id <id> has no row'],
    ['Token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcd rejected', 'Token <id> rejected'],
    ['Upload of 104857600 bytes took 120000ms', 'Upload of <n> bytes took 120000ms'],
  ])('%s', (raw, expected) => {
    expect(normalizeErrorMessage(raw)).toBe(expected)
  })

  test('keeps the words, codes and short numbers that tell failures apart', () => {
    for (const message of [
      'The operation timed out.',
      'Cloud history request failed (404)',
      'SQLITE_FULL: database or disk is full',
      'getaddrinfo ENOTFOUND www.codebuff.com',
      "This chat’s checkout is locked after its first run",
      "can't open the folder: Desktop's profile was reset",
      'ERR_TLS_CERT_ALTNAME_INVALID',
    ])
      expect(normalizeErrorMessage(message)).toBe(message)
  })

  test('takes the first line, collapses whitespace and caps the length', () => {
    expect(normalizeErrorMessage('Request failed\n    at /Users/jane/app/server.ts:12:3')).toBe('Request failed')
    expect(normalizeErrorMessage('  too\t many   spaces ')).toBe('too many spaces')
    const long = normalizeErrorMessage('word '.repeat(100))!
    expect(long).toHaveLength(200)
    expect(long.endsWith('…')).toBe(true)
    expect(normalizeErrorMessage('abc def', 5)).toBe('abc …')
  })

  test('nothing to say is undefined', () => {
    expect(normalizeErrorMessage('')).toBeUndefined()
    expect(normalizeErrorMessage('   ')).toBeUndefined()
    expect(normalizeErrorMessage(undefined)).toBeUndefined()
    expect(normalizeErrorMessage({ message: 'x' })).toBeUndefined()
  })

  test('is idempotent', () => {
    const once = normalizeErrorMessage(
      "open '/Users/jane/x.json' for jane@example.com at https://x.test/a (id 0f8c2d7e-5b1a-4c3d-9e2f-1a2b3c4d5e6f)",
    )
    expect(normalizeErrorMessage(once)).toBe(once)
  })
})

describe('errorClassChain', () => {
  test('names each wrapped cause, outermost first, with its code', () => {
    const socket = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    const fetchFailed = new TypeError('fetch failed', { cause: socket })
    const wrapped = new Error('Could not change runtime', { cause: fetchFailed })
    expect(errorClassChain(wrapped)).toBe('Error>TypeError>Error[ECONNRESET]')
  })

  test('a lone error is its own class; DOMException names survive', () => {
    expect(errorClassChain(new RangeError('x'))).toBe('RangeError')
    expect(errorClassChain(new DOMException('The operation timed out.', 'TimeoutError'))).toBe('TimeoutError')
  })

  test('stops at the depth limit and on a cycle; odd names and codes are not shipped', () => {
    const a = new Error('a') as Error & { cause?: unknown }
    const b = new Error('b', { cause: a })
    a.cause = b
    expect(errorClassChain(b)).toBe('Error>Error')
    let deep: unknown = new Error('root')
    for (let i = 0; i < 10; i++) deep = new Error(String(i), { cause: deep })
    expect(errorClassChain(deep)!.split('>')).toHaveLength(4)
    const odd = Object.assign(new Error('x'), { name: '/Users/jane', code: 'jane@example.com' })
    expect(errorClassChain(odd)).toBe('?')
  })

  test('a thrown value that is not an object has no chain', () => {
    expect(errorClassChain('boom')).toBeUndefined()
    expect(errorClassChain(undefined)).toBeUndefined()
  })
})
