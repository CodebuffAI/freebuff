import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { wireTools } from './foreign-client-wire-tools'
import {
  detectForeignFreebuffClient,
  FREEBUFF_CUSTOM_TOOL_NAMES,
} from '../constants/foreign-client-signals'
import { FREEBUFF_ROOT_AGENT_IDS } from '../constants/free-agents'

/**
 * Nothing we ship may be mistaken for a third-party client.
 *
 * The downgrade now runs unconditionally with no flag to disable it, so a
 * freebuff agent the detector flags is served a different model in production
 * with no way to switch it off short of a revert and redeploy. This has already
 * happened twice, both silently:
 *
 *  - `researcher-web` offers `['web_search', 'read_url']` and was flagged on
 *    100% of its 334,042 requests from 4,821 users over 30 days.
 *  - `freebuff-desktop-autorun` offers only the custom tool `decide`, so it had
 *    no signature tool at all — 2,904 requests from 41 users.
 *
 * Both were found by querying production, which is the wrong place to find
 * them. This scans the source instead, so the next one fails CI.
 *
 * Reading source with a regex is crude, and the real hazard is that it quietly
 * stops matching and the test passes on an empty set — hence the floor below
 * and the named spot checks.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

/** Where agent definitions live. */
const SEARCH_ROOTS = [
  'agents',
  '.agents',
  'freebuff',
  'freebuff-desktop/src',
  'web/src',
  'common/src',
  'sdk/src',
  'cli/src',
]

/**
 * Definitions that cannot reach the downgrade, with the property that makes
 * that true. `mustContain` is the load-bearing part: if the reason stops
 * holding, this fails rather than the exclusion silently outliving it.
 */
const EXCLUDED: Array<{ path: string; mustContain: string; why: string }> = [
  {
    path: 'freebuff/e2e/agent/freebuff-tester.ts',
    mustContain: "model: 'anthropic/claude-sonnet-4.5'",
    why:
      'e2e harness pinned to a paid Anthropic model. The downgrade only runs ' +
      'on free-mode requests, and a free-mode request for a non-free model is ' +
      'rejected by isFreeModeAllowedAgentModel long before the detector. It ' +
      'also had 0 production requests over 30 days. If it ever moves to a ' +
      'free model this exclusion stops applying and the test says so.',
  },
]

/**
 * The regex only sees literal names. A declaration built at runtime is invisible
 * to it, which is precisely how `decide` slipped through — so custom tools are
 * asserted separately below rather than assumed covered here.
 */
const TOOL_NAMES_DECLARATION = /toolNames:\s*\[([^\]]*)\]/g
const QUOTED_NAME = /'([^']+)'|"([^"]+)"/g

/** Below this, assume the scan broke rather than that we deleted 20 agents. */
const MINIMUM_DECLARATIONS = 25

type Declaration = { file: string; names: string[]; ids: string[] }

function collectSourceFiles(): string[] {
  const files: string[] = []
  const walk = (dir: string) => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'dist') {
        continue
      }
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) {
        walk(path)
        continue
      }
      // Test files carry deliberately-foreign fixtures; they are not shipped.
      if (
        path.endsWith('.ts') &&
        !path.includes('__tests__') &&
        !path.endsWith('.test.ts')
      ) {
        files.push(path)
      }
    }
  }
  for (const root of SEARCH_ROOTS) walk(join(REPO_ROOT, root))
  return files
}

function collectDeclarations(): Declaration[] {
  const excluded = new Set(EXCLUDED.map((entry) => entry.path))
  const declarations: Declaration[] = []
  for (const file of collectSourceFiles()) {
    const relativePath = relative(REPO_ROOT, file)
    if (excluded.has(relativePath)) continue
    const source = readFileSync(file, 'utf8')
    const ids = [...source.matchAll(/\bid:\s*'([^']+)'/g)].map((m) => m[1]!)
    for (const match of source.matchAll(TOOL_NAMES_DECLARATION)) {
      const names = [...match[1]!.matchAll(QUOTED_NAME)].map(
        (name) => name[1] ?? name[2]!,
      )
      // Empty declarations are kept, not filtered. `toolNames: []` on a ROOT is
      // precisely what the root test below must catch, and dropping it here
      // made that test vacuous — a root with an empty toolset simply vanished
      // from the scan and the assertion passed over nothing.
      declarations.push({ file: relativePath, names, ids })
    }
  }
  return declarations
}

const DECLARATIONS = collectDeclarations()

/** Wire-shaped, so the schema check sees what production sees: a name in
 *  `toolParams` carries our real parameters, anything else a generic schema.
 *  A declaration whose only signature tools are zero-parameter (`end_turn`,
 *  `task_completed`) fails below by design — those never count, see
 *  `isGenuineSignatureTool`. */
const asToolSchemas = (names: readonly string[]) => wireTools(...names)

describe('no shipped freebuff agent is flagged as a foreign client', () => {
  test('the scan actually found our agents', () => {
    // Guards the failure mode where a reformat stops the regex matching and
    // every assertion below passes over an empty set.
    expect(DECLARATIONS.length).toBeGreaterThanOrEqual(MINIMUM_DECLARATIONS)
  })

  test.each(DECLARATIONS.map((d): [string, Declaration] => [d.file, d]))(
    '%s',
    (_file, declaration) => {
      const verdict = detectForeignFreebuffClient({
        tools: asToolSchemas(declaration.names),
      })
      // Surface the toolset in the failure, since the fix is almost always
      // "this agent's tools are all generic — give it a distinctive one, or
      // add the missing name back to the signature".
      expect({
        file: declaration.file,
        names: declaration.names,
        signal: verdict.signal,
      }).toEqual({
        file: declaration.file,
        names: declaration.names,
        signal: null,
      })
    },
  )

  test.each([
    ['researcher-web', 'agents/researcher/researcher-web.ts'],
    ['desktop mission', 'freebuff-desktop/src/server/services/mission.ts'],
    ['glob-matcher', 'agents/file-explorer/glob-matcher.ts'],
  ])(
    'still covers %s, which the scan must not silently drop',
    (_name, path) => {
      // The first two are the agents this test exists because of. The third has
      // exactly one signature tool (`glob` is generic, `set_output` is not), so
      // it is the closest thing we ship to the failure mode.
      expect(DECLARATIONS.some((d) => d.file === path)).toBe(true)
    },
  )

  test('every root agent we ship declares tools', () => {
    // `root_agent_no_tools` downgrades any ROOT agent request that offers no
    // tools, on the grounds that our roots are agentic by definition. A root
    // shipped with an empty toolset would therefore have every one of its
    // requests downgraded in production, with no flag to turn it off.
    const roots = new Set<string>(FREEBUFF_ROOT_AGENT_IDS)
    const shippedRoots = DECLARATIONS.filter((d) =>
      d.ids.some((id) => roots.has(id)),
    )
    // The scan must actually be finding roots, or this passes vacuously.
    expect(shippedRoots.length).toBeGreaterThan(0)
    // Name the offending file in the failure, since "a root declares no tools"
    // is useless without knowing which one.
    expect(
      shippedRoots
        .filter((d) => d.names.length === 0)
        .map((d) => `${d.file} (${d.ids.join(', ')})`),
    ).toEqual([])
  })

  test.each([...FREEBUFF_CUSTOM_TOOL_NAMES])(
    'custom tool %s clears on its own',
    (name) => {
      // Custom tools are registered at runtime through customToolDefinitions,
      // so the source scan cannot see them. An agent offering one and nothing
      // else — which is exactly what desktop autorun does — has no signature
      // tool unless it is enumerated.
      expect(
        detectForeignFreebuffClient({ tools: asToolSchemas([name]) }).signal,
      ).toBeNull()
    },
  )

  test('custom tools appended to a real toolset stay cleared', () => {
    // How the chat surface composes: base-chat's tools plus per-turn image and
    // document tools (freebuff/web/src/server/chat/agent.ts). The additions are
    // caller-named and arbitrary, so this must not depend on recognising them.
    expect(
      detectForeignFreebuffClient({
        tools: asToolSchemas([
          'spawn_agents',
          'gravity_index',
          'render_ui',
          'suggest_followups',
          'read_attached_image_abc123',
          'read_attached_doc_def456',
        ]),
      }).signal,
    ).toBeNull()
  })

  test.each(EXCLUDED)('exclusion of $path still holds', (entry) => {
    // An exclusion outliving its reason is how a real false positive gets
    // waved through, so the reason is asserted rather than just written down.
    const source = readFileSync(join(REPO_ROOT, entry.path), 'utf8')
    expect(source).toContain(entry.mustContain)
  })
})
