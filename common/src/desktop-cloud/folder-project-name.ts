/**
 * The name a project takes from its folder: the folder's own name, or, for a drive root (`R:\`),
 * which has none, the drive (`R:`). `basename` answers '' for a root, and a project with an empty
 * name was refused by every Cloud bind, so it could neither start a chat nor be renamed. Either
 * separator is accepted whatever the platform, since a server reads a Windows computer's paths.
 * Null for an empty path.
 */
export function folderProjectName(path: string): string | null {
  const segments = path.split(/[\\/]+/).filter(Boolean)
  return segments.at(-1) ?? (path.startsWith('/') ? '/' : null)
}
