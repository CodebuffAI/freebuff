/**
 * Env TEMPLATES: the files that document variable NAMES for a human to copy,
 * and are committed on purpose. Anything else in the `.env` family holds real
 * values and stays sensitive.
 *
 * Written in `.gitignore` glob form because one consumer is an ignore file
 * (Desktop's local Git setup un-ignores exactly these). The one GLOB,
 * `.env.*.example`, is un-ignored there and nowhere else:
 * {@link isEnvTemplateFilePath} -- the read policy, the sponsored write policy
 * and the sponsored outcome rule -- matches only the exact names, because a
 * scoped copy such as `.env.production.example` is where real values tend to
 * get pasted, and treating it as a template would make it readable by every
 * agent.
 */
export const ENV_TEMPLATE_FILE_PATTERNS = Object.freeze([
  '.env.example',
  '.env.*.example',
  '.env.sample',
  '.env.template',
] as const)

const ENV_TEMPLATE_BASENAMES: ReadonlySet<string> = new Set(
  ENV_TEMPLATE_FILE_PATTERNS.filter((pattern) => !pattern.includes('*')),
)

function basename(filePath: string): string {
  const segments: string[] = []
  for (const segment of filePath.replaceAll('\\', '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  const name = segments.at(-1)?.toLowerCase() ?? ''
  // `C:.env` is a drive-relative path on Windows, not a file literally named
  // `C:.env`. Full drive paths already split at their slash above.
  return /^[a-z]:/.test(name) ? name.slice(2) : name
}

export function isEnvTemplateFilePath(filePath: string): boolean {
  return ENV_TEMPLATE_BASENAMES.has(basename(filePath))
}

export function isEnvFilePath(filePath: string): boolean {
  const name = basename(filePath)
  // Win32 strips trailing spaces/dots from ordinary path components, and NTFS
  // alternate data streams append `:<stream>` to the underlying filename.
  // Classify those aliases as env files, but keep the template exemption exact.
  const windowsBaseName = name.split(':', 1)[0]!.replace(/[ .]+$/g, '')
  return (
    windowsBaseName === '.env' || windowsBaseName.startsWith('.env.')
  )
}

export function isSensitiveEnvFilePath(filePath: string): boolean {
  return isEnvFilePath(filePath) && !isEnvTemplateFilePath(filePath)
}
