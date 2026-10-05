import path from 'path'

export const KNOWLEDGE_FILE_NAMES = [
  'AGENTS.md',
  'CLAUDE.md',
] as const

/** Opens the KNOWLEDGE_FILES_CONTENTS section of our agents' system prompt.
 *  The foreign-client detector keys on it verbatim to skip the user's own
 *  instructions files, so both sides import this one string. */
export const PROJECT_INSTRUCTIONS_HEADER =
  'Project instructions:\nEach fenced block below is one instructions file, labeled with its path. Follow them for the rest of the session.'

/**
 * Pre-computed lowercase knowledge file names for efficient matching.
 */
export const KNOWLEDGE_FILE_NAMES_LOWERCASE = KNOWLEDGE_FILE_NAMES.map((name) =>
  name.toLowerCase(),
)

/**
 * Checks if a file path is a knowledge file.
 * Matches:
 * - Exact file names: AGENTS.md, CLAUDE.md (case-insensitive)
 * - Pattern: *.knowledge.md (e.g., authentication.knowledge.md)
 */
export function isKnowledgeFile(filePath: string): boolean {
  const fileName = path.basename(filePath).toLowerCase()

  // Check for exact matches with standard knowledge file names
  if (KNOWLEDGE_FILE_NAMES_LOWERCASE.includes(fileName)) {
    return true
  }

  // Check for *.knowledge.md pattern (e.g., authentication.knowledge.md)
  if (fileName.endsWith('.knowledge.md')) {
    return true
  }

  return false
}
