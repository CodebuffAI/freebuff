/**
 * Bun preload: teach bun to import .scm (tree-sitter query) files as text.
 *
 * packages/code-map/src/languages.ts imports .scm files directly, and the SDK
 * barrel re-exports code-map — so any test importing @codebuff/sdk (or the CLI
 * modules that reach it) needs this registered before those imports evaluate.
 *
 * cli/bunfig.toml lists this preload, but the file itself was not present in
 * the public mirror, so sdk-touching tests died at import time ("Unknown file
 * type" for the first .scm import), which bun reports as an unhandled error
 * between tests rather than a test failure (see docs/testing.md).
 *
 * The bundled build handles .scm imports the same way: loader 'text', default
 * export is the file's contents as a string.
 */
import { plugin } from 'bun'
import { readFileSync } from 'fs'

plugin({
  name: 'scm-text-loader',
  setup(build) {
    build.onLoad({ filter: /\.scm$/ }, (args) => ({
      // Wrap in a JS module: bun's plugin API only accepts code loaders
      // (js/json/...), and the import sites expect a default-exported string.
      contents: `export default ${JSON.stringify(readFileSync(args.path, 'utf8'))}`,
      loader: 'js' as const,
    }))
  },
})
