/**
 * Loads `*.scm` tree-sitter query files as text.
 *
 * `cli/bunfig.toml` lists this file as a preload and `docs/testing.md` passes it
 * to `bun test --preload`. Bun's default for an extension it does not know is to
 * resolve the import to the file's *path*, so without this the query text
 * `@codebuff/code-map` imports through the `@codebuff/sdk` barrel is a path.
 * `createLanguageConfig` reads an absolute path back off disk as a fallback
 * (`packages/code-map/src/languages.ts`), which is why the CLI still works when
 * this loader is missing — but only because the path it gets happens to be
 * absolute, and any bundler that inlines the import has no file to read.
 *
 * bun 1.3.14 has no `loader: 'text'`, so the contents are emitted as a JS module
 * whose default export is the JSON-escaped text.
 */
import { plugin } from 'bun'

/**
 * The module bun should hand an importer in place of the `.scm` file.
 *
 * `JSON.stringify` is both the escaper and the quoting: it produces a literal
 * JavaScript can evaluate back to the exact text, so a query containing
 * backslashes, quotes or newlines survives the round trip.
 */
export function scmTextModule(text: string): string {
  return `export default ${JSON.stringify(text)}`
}

plugin({
  name: 'scm-text-loader',
  setup(build) {
    build.onLoad({ filter: /\.scm$/ }, async (args) => ({
      contents: scmTextModule(await Bun.file(args.path).text()),
      loader: 'js',
    }))
  },
})
