/**
 * The files a user adds to a Chat-mode project (workspace-mode.ts): the
 * listing the project panel shows, and the manifest the Cloud worker syncs
 * into every chat's `files/` folder. The bytes live in R2; this is the
 * shared wire contract between the browser, the gateway and the Cloud API.
 */
export const PROJECT_FILE_MAX_BYTES = 25 * 1024 * 1024
export const PROJECT_FILE_MAX_COUNT = 200
export const PROJECT_FILE_NAME_MAX_CHARS = 200

export type CloudProjectFileKind = 'image' | 'document' | 'file'

export type CloudProjectFile = {
  id: string
  name: string
  mediaType: string
  bytes: number
  createdAt: string
  /** Content revision for conditional edits; older servers may omit it. */
  sha256?: string
}

/** A name a file may carry inside `files/`: one path segment, nothing hidden. */
export function validProjectFileName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= PROJECT_FILE_NAME_MAX_CHARS &&
    !name.startsWith('.') &&
    !/[\\/\x00-\x1f\x7f:*?"<>|]/.test(name) &&
    name.trim() === name &&
    name !== '..'
  )
}

/** How the panel previews a file and which tools the agent is told to reach for. */
export function projectFileKind(file: Pick<CloudProjectFile, 'name' | 'mediaType'>): CloudProjectFileKind {
  if (/^image\/(png|jpeg|gif|webp|svg\+xml|avif)$/.test(file.mediaType)) return 'image'
  if (/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(file.name)) return 'image'
  if (
    /^(text\/|application\/(pdf|json|xml|msword|vnd\.openxmlformats|vnd\.ms-excel|vnd\.oasis|rtf))/.test(file.mediaType) ||
    /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|pdf|docx?|xlsx?|pptx?|rtf|odt|ods|html?|js|ts|py|java|rb|go|rs|c|cpp|h|css)$/i.test(file.name)
  )
    return 'document'
  return 'file'
}

/**
 * A name the browser cannot pass the server's check gets a safe form: the
 * characters the check forbids become dashes and a hidden name is unhidden.
 */
export function safeProjectFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/\x00-\x1f\x7f:*?"<>|]/g, '-')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, PROJECT_FILE_NAME_MAX_CHARS)
  return cleaned || 'file'
}

/**
 * A file added when another of the same name exists gets a numbered name
 * (`report (2).pdf`), as a desktop file manager would.
 */
export function uniqueProjectFileName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${stem} (${n})${ext}`.slice(0, PROJECT_FILE_NAME_MAX_CHARS)
    if (!taken.has(candidate)) return candidate
  }
  return `${crypto.randomUUID().slice(0, 8)}-${name}`.slice(0, PROJECT_FILE_NAME_MAX_CHARS)
}
