import { describe, expect, it } from 'bun:test'

import { noteWithCause, stopCause, USER_INTERRUPTED_MESSAGE } from '../messages'

// The daily trace report reads both: a runner restart must not read as the
// user's Stop, and a stop must not read as happening when the user next wrote.
describe('the turn stop note', () => {
  it('says why, when the host gave a cause, and always when', () => {
    const at = Date.parse('2026-11-28T01:02:03Z')
    expect(
      noteWithCause(USER_INTERRUPTED_MESSAGE, {
        cause: stopCause(new DOMException('runner_restart', 'AbortError')),
        at,
      }),
    ).toBe(
      `${USER_INTERRUPTED_MESSAGE} (cause: runner_restart; at 2026-11-28T01:02:03.000Z)`,
    )
    expect(noteWithCause(USER_INTERRUPTED_MESSAGE, { at })).toBe(
      `${USER_INTERRUPTED_MESSAGE} (at 2026-11-28T01:02:03.000Z)`,
    )
  })

  it('gives no cause for the CLI’s Esc, a bare abort or anything else', () => {
    expect(stopCause('user-interrupt')).toBeUndefined()
    expect(
      stopCause(new DOMException('This operation was aborted', 'AbortError')),
    ).toBeUndefined()
    expect(stopCause(new Error('runner_restart'))).toBeUndefined()
    expect(stopCause(undefined)).toBeUndefined()
  })
})
