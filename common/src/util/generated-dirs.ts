/**
 * Folders that package managers and builds fill, not the user: a path under
 * one is not the user's work even in a repo whose `.gitignore` forgets it.
 * Desktop's file tree skips them; the Cloud sponsored report leaves them out
 * of the file count it writes into a run's diagnostic.
 */
export const GENERATED_DIR_NAMES: readonly string[] = [
  'node_modules',
  'dist',
  'build',
  '.next',
]

const GENERATED_DIRS = new Set(GENERATED_DIR_NAMES)

/** Whether any folder on a relative path (either separator) is a generated one. */
export function isUnderGeneratedDir(path: string): boolean {
  const parts = path.split(/[\\/]/)
  // the last part is the file itself: a file named `build` is still the user's
  return parts.slice(0, -1).some((part) => GENERATED_DIRS.has(part))
}
