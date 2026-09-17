import { realpathSync } from 'node:fs'

import { isPathInside } from '../util/path'

/**
 * Whether `target` resolves inside `root` (§4.1.1: a path supplied by the
 * plugin package must remain within the filesystem-resolved plugin root).
 *
 * Both sides are resolved before the comparison, so a root or a file reached
 * through a symlink, junction, or reparse point is judged by where it points
 * rather than how it is spelled — §4.1.1 permits the ones that land inside
 * the root and rejects the rest. Throws when either path does not exist,
 * which leaves callers to map that onto their own missing-file rule.
 */
export function resolvesWithinRoot(root: string, target: string): boolean {
  return isPathInside(realpathSync(root), realpathSync(target))
}
