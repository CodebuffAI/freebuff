export const tryToDoStringReplacementWithExtraIndentation = (params: {
  oldFileContent: string
  searchContent: string
  replaceContent: string
}) => {
  const { oldFileContent, searchContent, replaceContent } = params
  const searchLines = searchContent.split('\n')
  const firstNonEmptyLine = searchLines.find((line) => Boolean(line))

  const indentLines = (lines: string[], prefix: string) =>
    lines.map((line) => (line ? prefix + line : line)).join('\n')

  for (let i = 1; i <= 12; i++) {
    const prefix = ' '.repeat(i)
    if (
      firstNonEmptyLine !== undefined &&
      !oldFileContent.includes(prefix + firstNonEmptyLine)
    ) {
      continue
    }
    const searchContentWithIndentation = indentLines(searchLines, prefix)
    if (oldFileContent.includes(searchContentWithIndentation)) {
      return {
        searchContent: searchContentWithIndentation,
        replaceContent: indentLines(replaceContent.split('\n'), prefix),
      }
    }
  }

  for (let i = 1; i <= 6; i++) {
    const prefix = '\t'.repeat(i)
    if (
      firstNonEmptyLine !== undefined &&
      !oldFileContent.includes(prefix + firstNonEmptyLine)
    ) {
      continue
    }
    const searchContentWithIndentation = indentLines(searchLines, prefix)
    if (oldFileContent.includes(searchContentWithIndentation)) {
      return {
        searchContent: searchContentWithIndentation,
        replaceContent: indentLines(replaceContent.split('\n'), prefix),
      }
    }
  }

  return null
}
