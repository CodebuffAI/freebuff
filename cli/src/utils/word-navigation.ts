type WordNavigationKey = {
  name?: string
  ctrl?: boolean
  meta?: boolean
  option?: boolean
}

export function findPreviousWordBoundary(text: string, cursor: number): number {
  let position = Math.max(0, Math.min(cursor, text.length))

  // Skip whitespace backwards, then the word immediately before the cursor.
  while (position > 0 && /\s/.test(text[position - 1]!)) {
    position--
  }
  while (position > 0 && !/\s/.test(text[position - 1]!)) {
    position--
  }

  return position
}

export function findNextWordBoundary(text: string, cursor: number): number {
  let position = Math.max(0, Math.min(cursor, text.length))

  // Skip the word at the cursor, then whitespace before the next word.
  while (position < text.length && !/\s/.test(text[position]!)) {
    position++
  }
  while (position < text.length && /\s/.test(text[position]!)) {
    position++
  }

  return position
}

/**
 * Resolve word-wise cursor movement for the conventions used by the input.
 *
 * Alt+Left/Right (and Alt+B/F) are supported on Unix-like terminals. Windows
 * terminals conventionally send Ctrl+Left/Right instead, so keep both paths
 * on the same boundary implementation.
 */
export function getWordNavigationPosition(
  key: WordNavigationKey,
  text: string,
  cursor: number,
  isAltLikeModifier: boolean,
): number | null {
  const lowerKeyName = (key.name ?? '').toLowerCase()
  // Keep Ctrl+Arrow exclusive to a plain Ctrl modifier. OpenTUI can expose
  // Option/Alt separately (and terminals may encode Alt-like chords with more
  // than one modifier bit); those chords belong to the existing Alt path and
  // must not be reclassified as Windows-style Ctrl+Arrow navigation.
  const isCtrlArrow = key.ctrl && !key.meta && !key.option

  if (
    (isAltLikeModifier && (key.name === 'left' || lowerKeyName === 'b')) ||
    (isCtrlArrow && key.name === 'left')
  ) {
    return findPreviousWordBoundary(text, cursor)
  }
  if (
    (isAltLikeModifier && (key.name === 'right' || lowerKeyName === 'f')) ||
    (isCtrlArrow && key.name === 'right')
  ) {
    return findNextWordBoundary(text, cursor)
  }

  return null
}
