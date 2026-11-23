import { expect, test } from 'bun:test'

import { isTerminalGoneError } from '../terminal-gone'

const errno = (
  message: string,
  props: Partial<NodeJS.ErrnoException> = {},
): Error => Object.assign(new Error(message), props)

test('a failed write or read on the closed terminal is the terminal going away', () => {
  expect(
    isTerminalGoneError(
      errno('EIO: i/o error, write', { code: 'EIO', syscall: 'write' }),
    ),
  ).toBe(true)
  expect(
    isTerminalGoneError(
      errno('EIO: i/o error, read', { code: 'EIO', syscall: 'read' }),
    ),
  ).toBe(true)
  expect(
    isTerminalGoneError(
      errno('ENXIO: no such device or address, write', {
        code: 'ENXIO',
        syscall: 'write',
      }),
    ),
  ).toBe(true)
  expect(isTerminalGoneError(errno('EPIPE: broken pipe, write'))).toBe(true)
})

test('a file error, another syscall or any other error is still a crash', () => {
  expect(
    isTerminalGoneError(
      errno("EIO: i/o error, write '/home/me/.config/x'", {
        code: 'EIO',
        syscall: 'write',
        path: '/home/me/.config/x',
      }),
    ),
  ).toBe(false)
  expect(
    isTerminalGoneError(
      errno('EIO: i/o error, uv_spawn', { code: 'EIO', syscall: 'uv_spawn' }),
    ),
  ).toBe(false)
  expect(
    isTerminalGoneError(
      errno('EPERM: operation not permitted, write', {
        code: 'EPERM',
        syscall: 'write',
      }),
    ),
  ).toBe(false)
  expect(isTerminalGoneError(new Error('Minified React error #185'))).toBe(
    false,
  )
  expect(isTerminalGoneError('EIO: i/o error, write')).toBe(false)
})
