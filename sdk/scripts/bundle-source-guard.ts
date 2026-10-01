/**
 * Fence between the published SDK bundle and code withheld from the public
 * repository export.
 *
 * `@codebuff/sdk` inlines every workspace module it imports (common/,
 * packages/*) into dist/index.{mjs,cjs}. The public export
 * (scripts/public-export-manifest.txt) deliberately leaves some of those
 * modules out, so an SDK import of one would publish it on npm anyway. This
 * guards that the bundle's sourcemap contains only public sources: it runs on
 * the maps before the build deletes them and fails the build if any bundled
 * source is not part of the public export.
 *
 * Pure (no fs), so it can be unit-tested.
 */

export type ExportManifest = {
  /** Repo-relative paths (files or directories) the export includes. */
  includes: string[]
  /** `!` lines: repo-relative paths, or `**`-prefixed globs. */
  excludes: string[]
}

export function parseExportManifest(text: string): ExportManifest {
  const includes: string[] = []
  const excludes: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('!')) excludes.push(stripSlashes(line.slice(1)))
    else includes.push(stripSlashes(line))
  }
  return { includes, excludes }
}

function stripSlashes(value: string): string {
  return value.replace(/^\/+/, '').replace(/\/+$/, '')
}

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

function matchesExclude(path: string, pattern: string): boolean {
  if (!pattern.startsWith('**/')) return isUnder(path, pattern)
  const tail = pattern.slice(3)
  const segments = path.split('/')
  if (tail.startsWith('*.')) {
    return path.endsWith(tail.slice(1))
  }
  // `**/name` — any path segment equal to name (a file or a directory).
  return segments.includes(tail)
}

/**
 * The repo-relative sources in `sources` that the public export does not
 * contain. Third-party code under node_modules is ignored (it is published by
 * its own authors); anything else must be included and not excluded.
 */
export function findWithheldSources(
  repoRelativeSources: readonly string[],
  manifest: ExportManifest,
): string[] {
  const withheld: string[] = []
  for (const source of repoRelativeSources) {
    const path = source.replace(/\\/g, '/')
    if (path.split('/').includes('node_modules')) continue
    const included = manifest.includes.some((prefix) => isUnder(path, prefix))
    const excluded = manifest.excludes.some((pattern) =>
      // `**/node_modules`, `**/dist` etc. describe build output, never source
      // the bundle could legitimately need; they still count.
      matchesExclude(path, pattern),
    )
    if (!included || excluded) withheld.push(path)
  }
  return withheld
}
