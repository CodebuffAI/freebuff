import stringWidth from 'string-width'

// Keep measurement logic centralised so components can share consistent wrap behavior.
function measureLines(text: string, cols: number): number {
  if (text.length === 0) return 1

  let lines = 1
  let current = 0
  const tokens = text.split(/(\s+)/)

  const emitHardWrap = () => {
    lines += 1
    current = 0
  }

  const appendSegment = (
    segment: string,
    { flushBeforeOversize = true }: { flushBeforeOversize?: boolean } = {},
  ) => {
    if (!segment) return

    const segmentWidth = stringWidth(segment)
    if (segmentWidth > cols) {
      if (flushBeforeOversize && current > 0) emitHardWrap()
      let acc = 0
      for (const ch of Array.from(segment)) {
        const w = stringWidth(ch)
        if (acc + w > cols) {
          emitHardWrap()
          acc = 0
        }
        acc += w
      }
      current = acc
      return
    }

    if (current + segmentWidth > cols) emitHardWrap()
    current += segmentWidth
  }

  for (const token of tokens) {
    if (!token) continue

    if (token.includes('\n')) {
      const parts = token.split('\n')
      for (let i = 0; i < parts.length; i++) {
        appendSegment(parts[i], { flushBeforeOversize: false })
        if (i < parts.length - 1) emitHardWrap()
      }
      continue
    }

    appendSegment(token)
  }

  return lines
}

export function getLastNVisualLines(text: string, cols: number, n: number): { lines: string[]; hasMore: boolean } {
  if (n <= 0 || cols <= 0) return { lines: [], hasMore: false }
  const lines: string[] = []
  if (!text) return { lines, hasMore: false }

  let hasMore = false
  const tokens = text.split(/(\s+)/)
  let current = ''
  let currentWidth = 0

  const pushLine = () => {
    if (lines.length === n) {
      hasMore = true
      lines.shift()
    }
    lines.push(current)
    current = ''
    currentWidth = 0
  }

  const appendSegment = (segment: string) => {
    if (!segment) return
    const segWidth = stringWidth(segment)

    if (segWidth > cols) {
      for (const ch of Array.from(segment)) {
        const w = stringWidth(ch)
        if (currentWidth + w > cols) pushLine()
        current += ch
        currentWidth += w
      }
      return
    }

    if (currentWidth + segWidth > cols) pushLine()
    current += segment
    currentWidth += segWidth
  }

  for (const token of tokens) {
    if (!token) continue
    if (token.includes('\n')) {
      const parts = token.split('\n')
      for (let i = 0; i < parts.length; i++) {
        appendSegment(parts[i])
        if (i < parts.length - 1) pushLine()
      }
      continue
    }
    appendSegment(token)
  }

  if (current.length > 0 || (!hasMore && lines.length === 0)) pushLine()
  return { lines, hasMore }
}

export function computeInputLayoutMetrics({
  layoutContent,
  cursorProbe,
  cols,
  maxHeight,
  minHeight = 1,
}: {
  layoutContent: string
  cursorProbe: string
  cols: number
  maxHeight: number
  minHeight?: number
}): { heightLines: number; gutterEnabled: boolean } {
  const safeMaxHeight = Math.max(1, maxHeight)
  const effectiveMinHeight = Math.max(
    1,
    Math.min(minHeight ?? 1, safeMaxHeight),
  )
  const totalLines = measureLines(layoutContent, cols)
  const cursorLines = measureLines(cursorProbe, cols)

  // Add bottom gutter when cursor is on line 2 of exactly 2 lines
  const gutterEnabled =
    totalLines === 2 && cursorLines === 2 && totalLines + 1 <= safeMaxHeight

  const rawHeight = Math.min(
    totalLines + (gutterEnabled ? 1 : 0),
    safeMaxHeight,
  )

  const heightLines = Math.max(effectiveMinHeight, rawHeight)

  return {
    heightLines,
    gutterEnabled,
  }
}
