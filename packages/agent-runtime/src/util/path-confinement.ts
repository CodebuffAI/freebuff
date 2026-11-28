// Defense-in-depth for file tools: reject paths that escape the project root
// (absolute paths, drive letters, `..` segments, null bytes). The SDK client
// also enforces this via realpath (confineFileToolsToProject). Here we do a
// cheap lexical check so the agent-runtime never delegates an obviously
// out-of-bounds request. Off by default? No — confined by default; opt out
// with agentTemplate.confineFileToolsToProject === false.

export const PATH_OUTSIDE_PROJECT_MESSAGE =
  'Path is outside the project root and was not read.'

/**
 * Returns true when `filePath` is confined to the project root by lexical
 * inspection. Does not resolve symlinks (the client does that); this is a
 * cheap first line of defense.
 */
export function isPathConfined(filePath: unknown): boolean {
  if (typeof filePath !== 'string' || filePath === '') return false
  if (filePath.includes('\u0000')) return false
  // Normalize separators.
  const normalized = filePath.replace(/\\/g, '/')
  // Absolute paths and drive letters are never confined.
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return false
  const segments = normalized.split('/')
  for (const seg of segments) {
    if (seg === '..') return false
    // A segment like 'foo/..' already split; '..' covers traversal.
  }
  return true
}

export function isPathConfinedEnabled(
  agentTemplate: { confineFileToolsToProject?: boolean } | undefined,
): boolean {
  // Default: confined (true) unless explicitly disabled.
  return agentTemplate?.confineFileToolsToProject !== false
}
