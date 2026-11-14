/** Browser uploads are buffered while packaging; Desktop supports larger projects. */
export const PROJECT_UPLOAD_BYTES = 100 * 1024 * 1024
export const PROJECT_UPLOAD_FILES = 4000
export const PROJECT_UPLOAD_BODY_BYTES = PROJECT_UPLOAD_BYTES + 4 * 1024 * 1024

export type ProjectUploadFile = {
  path: string
  file: File
  folderName?: string
}
export type ProjectUploadProgress = {
  phase: 'uploading' | 'saving'
  percent?: number
}
export type ProjectUploadOptions = {
  onProgress?(progress: ProjectUploadProgress): void
  signal?: AbortSignal
}

export function skipProjectUploadEntry(name: string) {
  return ['.git', '.freebuff', 'node_modules'].includes(name.toLowerCase())
}

export function validateProjectUpload(
  files: readonly { path: string; size: number }[],
) {
  if (!files.length) throw new Error('Choose at least one file.')
  if (files.length > PROJECT_UPLOAD_FILES)
    throw new Error('Choose up to 4,000 files per project.')
  if (
    files.reduce((total, file) => total + file.size, 0) > PROJECT_UPLOAD_BYTES
  )
    throw new Error('Choose files totaling 100 MB or less.')
  const paths = new Set<string>()
  for (const { path, size } of files) {
    const parts = path.split('/')
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      new TextEncoder().encode(path).length > 1024 ||
      /[\\\x00-\x1f\x7f:]/.test(path) ||
      parts.some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          ['.git', '.freebuff'].includes(part.toLowerCase()),
      )
    )
      throw new Error(`Unsupported file path: ${path}`)
    if (paths.has(path))
      throw new Error(
        `More than one file has the path ${path}. Remove one and try again.`,
      )
    paths.add(path)
  }
  for (const path of paths) {
    const parts = path.split('/')
    while (parts.length > 1) {
      parts.pop()
      if (paths.has(parts.join('/')))
        throw new Error(`A file and folder share the path ${parts.join('/')}.`)
    }
  }
}

/** Folder pickers include the selected folder's name; its contents seed the project root. */
export function projectUploadFiles(
  files: readonly File[],
): ProjectUploadFile[] {
  return files
    .map((file) => ({
      file,
      path: file.webkitRelativePath
        ? file.webkitRelativePath.split('/').slice(1).join('/')
        : file.name,
    }))
    .filter(({ path }) => !path.split('/').some(skipProjectUploadEntry))
}
