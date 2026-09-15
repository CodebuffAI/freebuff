import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import { scmTextModule } from '../../../test/setup-scm-loader'

/**
 * Import what the loader would emit. The loader's whole job is to hand the
 * importer a module instead of a path, so a round trip through a real import is
 * the only assertion that covers both the escaping and the default export.
 */
async function importEmitted(text: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'scm-loader-'))
  const file = path.join(dir, 'query.mjs')
  try {
    await Bun.write(file, scmTextModule(text))
    const module = (await import(file)) as { default: string }
    return module.default
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('scm-text-loader', () => {
  // The loader is a preload for `cd cli && bun test` (cli/bunfig.toml), so its
  // test lives with the package that preloads it.
  test('hands the importer the file text, not its path', async () => {
    const query =
      '(method_declaration name: (identifier) @name) @definition.method'

    expect(await importEmitted(query)).toBe(query)
  })

  test('escapes text that would otherwise end the string literal', async () => {
    // Real queries carry regexes with backslashes and quoted literals. The
    // unescaped form is a syntax error, not a wrong query, so this asserts the
    // module still evaluates and still carries every character.
    const query = '(string_literal) @literal (#match? @literal "\\\\n")'

    const emitted = scmTextModule(query)

    expect(emitted).not.toContain('\n')
    expect(await importEmitted(query)).toBe(query)
  })

  test('round-trips newlines and quotes', async () => {
    const query = '(comment) @c\n// "quoted" \\ backslash\n(program) @p'

    expect(await importEmitted(query)).toBe(query)
  })

  test('the queries it loads are real, non-empty text', async () => {
    const file = path.join(
      __dirname,
      '../../../packages/code-map/src/tree-sitter-queries/tree-sitter-c_sharp-tags.scm',
    )

    const text = await Bun.file(file).text()

    expect(text.length).toBeGreaterThan(0)
    expect(await importEmitted(text)).toBe(text)
  })
})
