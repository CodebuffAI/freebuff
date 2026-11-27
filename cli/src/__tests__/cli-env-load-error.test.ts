import { existsSync } from 'fs'
import path from 'path'
import { describe, expect, test } from 'bun:test'

import { describeEnvLoadFailure, getDefaultCliEnv } from './test-utils'

/**
 * The test-env loader reaches for the private module
 * `packages/internal/src/env`, which the public mirror deliberately does not
 * export. When that require fails, the thrown value is bun's `ResolveMessage`
 * — an object with a perfectly good `message` that is NOT an `instanceof
 * Error` — and the loader used to answer `unknown error loading environment`,
 * discarding `Cannot find module '../../../packages/internal/src/env'`.
 *
 * That costs a contributor the one fact they needed. Three tests:
 *
 * 1. behavioural — through the real loader, and skipped where the private
 *    module exists and the failure cannot happen;
 * 2. the shape — the thrown value's own message must survive, whatever its
 *    prototype says. This one runs everywhere, so the guard does not depend on
 *    the private package being absent to be meaningful;
 * 3. the adjacent case — a value with no message anywhere still produces
 *    something a human can act on.
 *
 * Probes, run 2026-11-26 while writing this file. Both went green BEFORE the
 * change below, and red after. The mutation must be verified in the diff, not
 * assumed — a mutation that silently fails looks exactly like a guard that
 * works.
 *
 *   (a) replace the `carried` branch in `describeEnvLoadFailure` with the
 *       literal `'unknown error loading environment'` → the behavioural test
 *       and the shape test both fail. The adjacent case (no message anywhere)
 *       still passes, which is correct: that mutation cannot affect it.
 *   (b) replace the closing instruction (`"infisical run -- bun …"`) with a
 *       vague sentence → the adjacent case fails alone, the other two stay
 *       green. That is what shows the third test is independent rather than
 *       riding along on the first two.
 */

const PRIVATE_ENV_MODULE = path.join(__dirname, '../../../packages/internal/src/env')

describe('test environment loader error', () => {
  test('behavioural: a missing private env module is named, not called "unknown error"', () => {
    // Positive control: only meaningful where the module is genuinely absent.
    if (existsSync(PRIVATE_ENV_MODULE)) return

    let caught: unknown
    try {
      getDefaultCliEnv()
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    const message = (caught as Error).message
    expect(message).toContain('packages/internal/src/env')
    expect(message).not.toContain('unknown error')
  })

  test('shape: a thrown value that carries a message but is not an Error keeps that message', () => {
    // Bun's ResolveMessage is exactly this shape: a message, no Error prototype.
    const resolveMessage = {
      name: 'ResolveMessage',
      message:
        "Cannot find module '../../../packages/internal/src/env' from 'test-utils.ts'",
    }
    expect(resolveMessage instanceof Error).toBe(false)

    const text = describeEnvLoadFailure(resolveMessage)

    expect(text).toContain('packages/internal/src/env')
    expect(text).toContain('Cannot find module')
    expect(text).not.toContain('unknown error')
  })

  test('shape: a value with nothing readable still says something a human can act on', () => {
    // Adjacent case that must keep working: no message anywhere.
    const text = describeEnvLoadFailure(undefined)
    expect(text).toContain('packages/internal/src/env')
    expect(text).toContain('infisical')
  })
})
