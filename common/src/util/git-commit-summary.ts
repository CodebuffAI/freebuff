type GitChangeKind = 'added' | 'modified' | 'deleted' | 'renamed'

type GitChange = {
  path: string
  kind: GitChangeKind
}

export type GitCommitSummaryInput = {
  status?: string
  diff?: string
  diffCached?: string
  maxFiles?: number
}

const DEFAULT_SUMMARY = 'Update project files'

const normalizePath = (path: string) =>
  path.trim().replace(/^"|"$/g, '').replace(/^a\//, '').replace(/^b\//, '')

const basename = (path: string) =>
  path.split('/').filter(Boolean).at(-1) ?? path

const stripExtension = (fileName: string) => fileName.replace(/\.[^.]+$/, '')

const humanizeFileName = (fileName: string) =>
  stripExtension(fileName)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())

const parseStatusKind = (code: string): GitChangeKind => {
  if (code.includes('A') || code.includes('?')) return 'added'
  if (code.includes('D')) return 'deleted'
  if (code.includes('R')) return 'renamed'
  return 'modified'
}

const parseStatusChanges = (status: string): GitChange[] => {
  return status
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .flatMap((line) => {
      const porcelain = line.match(/^([ MADRCU?!]{1,2})\s+(.+)$/)
      if (!porcelain) return []

      const [, code, rawPath] = porcelain
      const path = rawPath.includes(' -> ')
        ? rawPath.split(' -> ').at(-1)!
        : rawPath

      return [{ path: normalizePath(path), kind: parseStatusKind(code) }]
    })
}

const parseDiffChanges = (diff: string): GitChange[] => {
  const changes: GitChange[] = []
  let currentPath: string | null = null
  let currentKind: GitChangeKind = 'modified'

  const flush = () => {
    if (currentPath) {
      changes.push({ path: normalizePath(currentPath), kind: currentKind })
    }
  }

  for (const line of diff.split('\n')) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (header) {
      flush()
      currentPath = header[2]
      currentKind = 'modified'
      continue
    }

    if (line.startsWith('new file mode')) {
      currentKind = 'added'
    } else if (line.startsWith('deleted file mode')) {
      currentKind = 'deleted'
    } else if (line.startsWith('rename to ')) {
      currentPath = line.slice('rename to '.length)
      currentKind = 'renamed'
    }
  }

  flush()
  return changes
}

const dedupeChanges = (changes: GitChange[]): GitChange[] => {
  const byPath = new Map<string, GitChange>()
  for (const change of changes) {
    if (!change.path) continue
    byPath.set(change.path, change)
  }
  return [...byPath.values()]
}

const listNames = (names: string[]) => {
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`
}

const summarizeSpecialChanges = (changes: GitChange[]) => {
  const paths = new Set(changes.map((change) => change.path.toLowerCase()))
  const summaries: string[] = []

  if (
    [...paths].some((path) =>
      /(^|\/)(agents|ai-instructions|instructions)\.md$/.test(path),
    )
  ) {
    summaries.push('update AI agent instructions')
  }

  if (
    paths.has('changelog.md') ||
    [...paths].some((path) => path.endsWith('/changelog.md'))
  ) {
    summaries.push('add changelog')
  }

  if (
    [...paths].some((path) => /(^|\/)(package\.json|bun\.lock)$/.test(path))
  ) {
    summaries.push('update dependencies')
  }

  return summaries
}

const getAction = (changes: GitChange[]) => {
  if (changes.every((change) => change.kind === 'added')) return 'Add'
  if (changes.every((change) => change.kind === 'deleted')) return 'Remove'
  if (changes.every((change) => change.kind === 'renamed')) return 'Rename'
  return 'Update'
}

/**
 * Builds a concise commit title from actual git changes. This is intentionally
 * deterministic so push flows can avoid falling back to the user's prompt.
 */
export const summarizeGitChangesForCommit = ({
  status = '',
  diff = '',
  diffCached = '',
  maxFiles = 3,
}: GitCommitSummaryInput) => {
  const changes = dedupeChanges([
    ...parseStatusChanges(status),
    ...parseDiffChanges(diffCached),
    ...parseDiffChanges(diff),
  ])

  if (changes.length === 0) {
    return DEFAULT_SUMMARY
  }

  const specialSummaries = summarizeSpecialChanges(changes)
  if (specialSummaries.length > 0) {
    return specialSummaries
      .map((summary, index) =>
        index === 0 ? summary[0].toUpperCase() + summary.slice(1) : summary,
      )
      .join(' and ')
  }

  const names = changes
    .slice(0, maxFiles)
    .map((change) => humanizeFileName(basename(change.path)))
  const suffix =
    changes.length > maxFiles ? ` and ${changes.length - maxFiles} more` : ''

  return `${getAction(changes)} ${listNames(names)}${suffix}`
}
