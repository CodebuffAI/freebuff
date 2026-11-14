export interface TokenCallerMap {
  [filePath: string]: {
    [token: string]: string[] // Array of files that call this token
  }
}

export function renderReadFilesResult(
  files: { path: string; content: string }[],
  tokenCallers: TokenCallerMap,
) {
  return files.map(({ path, content }) => {
    const referencedBy = tokenCallers[path]
    // Omitted when empty, which it always is when the run built no symbol index.
    return referencedBy && Object.keys(referencedBy).length > 0
      ? { path, content, referencedBy }
      : { path, content }
  })
}
