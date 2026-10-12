/**
 * Parses <think>...</think> tags from text and splits into segments.
 * Handles streaming scenarios where tags may be incomplete.
 */

export const THINK_OPEN_TAG = '<think>'
export const THINK_CLOSE_TAG = '</think>'

export type ThinkSegment = {
  type: 'text' | 'thinking'
  content: string
}

/**
 * Check if text ends with a potential partial tag that we should buffer.
 * Returns the length of the partial tag suffix, or 0 if none.
 */
export function getPartialTagLength(text: string): number {
  const len = text.length
  if (len === 0) return 0

  // The longest partial tag is '</think' (7 chars). If there is no '<' within
  // the last 7 characters, the string cannot end with a partial tag.
  const lastLt = text.lastIndexOf('<')
  if (lastLt === -1 || lastLt < len - 7) return 0

  const suffix = text.slice(lastLt)
  // Check for partial closing tag first (longer prefixes)
  if (THINK_CLOSE_TAG.startsWith(suffix) && suffix !== THINK_CLOSE_TAG) {
    return suffix.length
  }
  // Check for partial opening tag
  if (THINK_OPEN_TAG.startsWith(suffix) && suffix !== THINK_OPEN_TAG) {
    return suffix.length
  }
  return 0
}

/**
 * Parse text for think tags and return segments.
 * This handles complete tags only - partial tags at the end should be
 * handled by the caller using getPartialTagLength.
 */
export function parseThinkTags(text: string): ThinkSegment[] {
  if (!text) {
    return []
  }

  const segments: ThinkSegment[] = []
  const len = text.length
  let cursor = 0
  let insideThink = false

  while (cursor < len) {
    if (insideThink) {
      // Look for closing tag
      const closeIdx = text.indexOf(THINK_CLOSE_TAG, cursor)
      if (closeIdx === -1) {
        // No closing tag found - all remaining is thinking content
        if (cursor < len) {
          segments.push({ type: 'thinking', content: text.slice(cursor) })
        }
        break
      }
      // Content before closing tag is thinking
      if (closeIdx > cursor) {
        segments.push({
          type: 'thinking',
          content: text.slice(cursor, closeIdx),
        })
      }
      cursor = closeIdx + THINK_CLOSE_TAG.length
      insideThink = false
    } else {
      const openIdx = text.indexOf(THINK_OPEN_TAG, cursor)
      const closeIdx = text.indexOf(THINK_CLOSE_TAG, cursor)

      if (closeIdx !== -1 && (openIdx === -1 || closeIdx < openIdx)) {
        if (closeIdx > cursor) {
          segments.push({
            type: 'thinking',
            content: text.slice(cursor, closeIdx),
          })
        }
        cursor = closeIdx + THINK_CLOSE_TAG.length
        continue
      }

      // Look for opening tag
      if (openIdx === -1) {
        // No opening tag found - all remaining is regular text
        if (cursor < len) {
          segments.push({ type: 'text', content: text.slice(cursor) })
        }
        break
      }
      // Content before opening tag is regular text
      if (openIdx > cursor) {
        segments.push({ type: 'text', content: text.slice(cursor, openIdx) })
      }
      cursor = openIdx + THINK_OPEN_TAG.length
      insideThink = true
    }
  }

  return segments
}

// Note: isThinkingOpen and mergeSegments were removed as they are not currently used.
// They can be added back if needed for future functionality.
