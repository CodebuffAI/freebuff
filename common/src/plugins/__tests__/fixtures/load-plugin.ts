import { expect } from 'bun:test'

import type { LoadPluginResult } from '../../load-plugin'

/**
 * The composition fixtures: the result pair for the plugin-level load. The
 * component-level pairs live beside their own components (`manifest.ts`,
 * `skills.ts`, `mcp.ts`); this one sits above them, as the composition does.
 */

/**
 * Asserts the load succeeded, failing with the composer's reason otherwise,
 * and returns the result so tests assert on the plugin and its reports,
 * never on the result's shape.
 *
 * Rejection rows use expectPluginRejected rather than negating this one: a
 * rejection is not the boolean complement of success — "not ok" also covers
 * a crash — and the rejection helper additionally asserts the reason names
 * the cause under test.
 */
export function expectPluginOk(result: LoadPluginResult) {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`)
  return result
}

/**
 * Asserts the load failed and that the composer's reason names the cause
 * given by `blame`, so a failure for the wrong cause still fails the test.
 * Returns the rejection, so a row that also asserts on the reports it
 * carries does not need its own narrowing branch.
 */
export function expectPluginRejected(result: LoadPluginResult, blame: string) {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error(`expected rejection blaming ${blame}, got ok`)
  expect(result.reason).toContain(blame)
  return result
}
