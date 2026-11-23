/**
 * The controlling terminal went away under the CLI: the window closed or the
 * SSH connection dropped, so a write to (or read from) it fails with EIO,
 * ENXIO or EPIPE. That is not a crash. It usually lands while the CLI is
 * already exiting on the SIGHUP from the same close, when the terminal reset
 * falls back to `process.stdout.write` and the stream reports the error a
 * tick later as an uncaught exception. Recorded as a fatal crash, it was
 * about 95% of `cli.fatal_crash` (2026-11-21).
 *
 * A file error carries its path (`EIO: i/o error, write '/path'`); a
 * terminal stream's does not, so only a bare read or write counts.
 */
const TERMINAL_GONE_CODES = new Set(['EIO', 'ENXIO', 'EPIPE'])
const TERMINAL_GONE_MESSAGE = /^(EIO|ENXIO|EPIPE): [^,']+, (write|read)$/

export function isTerminalGoneError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const { code, syscall, path } = error as NodeJS.ErrnoException
  if (path) return false
  if (code && syscall) {
    return (
      TERMINAL_GONE_CODES.has(code) &&
      (syscall === 'write' || syscall === 'read')
    )
  }
  return TERMINAL_GONE_MESSAGE.test(error.message)
}
