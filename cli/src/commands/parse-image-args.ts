/**
 * Parse image command arguments into image path and optional accompanying message.
 * Supports quoted paths ("path with spaces" or 'path with spaces') and backslash-escaped spaces.
 */
export function parseImageCommandArgs(args: string): {
  imagePath: string | null
  message: string
} {
  const trimmed = args.trim()
  if (!trimmed) {
    return { imagePath: null, message: '' }
  }

  const firstChar = trimmed[0]
  if (firstChar === '"' || firstChar === "'") {
    const closingQuoteIndex = trimmed.indexOf(firstChar, 1)
    if (closingQuoteIndex !== -1) {
      const imagePath = trimmed.slice(1, closingQuoteIndex)
      const message = trimmed.slice(closingQuoteIndex + 1).trim()
      return { imagePath: imagePath || null, message }
    }
  }

  let i = 0
  let inEscape = false
  let pathEnd = -1

  for (; i < trimmed.length; i++) {
    const char = trimmed[i]
    if (inEscape) {
      inEscape = false
      continue
    }
    if (char === '\\') {
      inEscape = true
      continue
    }
    if (/\s/.test(char)) {
      pathEnd = i
      break
    }
  }

  if (pathEnd === -1) {
    const imagePath = trimmed.replace(/\\(\s)/g, '$1')
    return { imagePath: imagePath || null, message: '' }
  }

  const rawPath = trimmed.slice(0, pathEnd)
  const imagePath = rawPath.replace(/\\(\s)/g, '$1')
  const message = trimmed.slice(pathEnd).trim()

  return { imagePath: imagePath || null, message }
}
