import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { spyOn } from 'bun:test'

/**
 * The fixture machinery every plugin-component test shares: temp-root
 * registration and cleanup, the network watcher, and the reparse-point
 * primitives the §4.1.1 escape fixtures compose. Component fixtures live
 * beside their tests (`manifest.ts`, `skills.ts`) and import from here.
 */

/** Temp directories created by the running test, removed when it finishes. */
const tempDirs: string[] = []

/** Spies created by the running test, restored when it finishes. */
const testSpies: ReturnType<typeof spyOn>[] = []

/**
 * Discards everything the running test created — spies first, then the temp
 * directories — so no fixture state crosses into the next test and nothing
 * survives the run. Tests register it once with `afterEach`.
 */
export function cleanUpPluginFixtures(): void {
  for (const spy of testSpies.splice(0)) spy.mockRestore()
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
}

/**
 * Watches the network for the running test and returns the watcher, so a load
 * that retrieves the schema it names fails an assertion on that spy (spec §5.2
 * MUST NOT retrieve a schema while loading a plugin).
 */
export function watchNetworkAccess(): ReturnType<typeof spyOn> {
  const spy = spyOn(globalThis, 'fetch')
  testSpies.push(spy)
  return spy
}

/** A registered temp directory the running test may fill. */
export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/**
 * The sibling directory a §4.1.1 escape fixture builds its target contents
 * in, registered for cleanup. Named as a lexical extension of the plugin
 * root on purpose: a comparison that stopped at a path prefix would admit
 * it, so the escape fixtures test filesystem-resolved containment, not
 * spelling (§4.1.1).
 */
export function makeOutsideDir(root: string): string {
  const outside = `${root}-outside`
  tempDirs.push(outside)
  mkdirSync(outside, { recursive: true })
  return outside
}

/** A junction at `linkPath` resolving to `targetPath` — no privilege needed. */
export function linkJunction(linkPath: string, targetPath: string): void {
  symlinkSync(targetPath, linkPath, 'junction')
}
