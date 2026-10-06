/**
 * Utility functions for the login screen component
 */

/**
 * Formats a URL for display by wrapping it at logical breakpoints
 */
export function formatUrl(url: string, maxWidth?: number): string[] {
  if (!maxWidth || maxWidth <= 0 || url.length <= maxWidth) {
    return [url]
  }

  const lines: string[] = []
  let remaining = url

  while (remaining.length > 0) {
    if (remaining.length <= maxWidth) {
      lines.push(remaining)
      break
    }

    // Try to break at a logical point (after /, ?, &, =)
    let breakPoint = maxWidth
    for (let i = maxWidth - 1; i > maxWidth - 20 && i > 0; i--) {
      if (['/', '?', '&', '='].includes(remaining[i])) {
        breakPoint = i + 1
        break
      }
    }

    lines.push(remaining.substring(0, breakPoint))
    remaining = remaining.substring(breakPoint)
  }

  return lines
}

/**
 * Determines the color for a character based on its position relative to the sheen
 * Block characters use blockColor, shadow/border characters animate to accent green
 * @param accentColor - The accent color to use for the sheen effect (typically theme.primary)
 * @param blockColor - The color for solid block characters (white for dark mode, black for light mode)
 * @param isReversing - Whether the sheen is in the reverse (unfill) phase
 */
export function getSheenColor(
  char: string,
  charIndex: number,
  sheenPosition: number,
  logoColor: string,
  shadowChars: Set<string>,
  accentColor: string = '#9EFC62',
  blockColor: string = '#ffffff',
  isReversing: boolean = false,
): string {
  // Block characters use the specified block color
  if (char === '█') {
    return blockColor
  }

  // Only apply sheen to shadow/border characters
  if (!shadowChars.has(char)) {
    return logoColor
  }

  if (isReversing) {
    // Reverse phase: characters behind the sheen return to logoColor
    if (charIndex <= sheenPosition) {
      return logoColor
    }
    // Characters ahead of the sheen stay accent color
    return accentColor
  } else {
    // Forward phase: characters at or behind the sheen get the accent color
    if (charIndex <= sheenPosition) {
      return accentColor
    }
    // Characters ahead of the sheen remain original color
    return logoColor
  }
}

/**
 * Parses the logo string into individual lines
 */
export function parseLogoLines(logo: string): string[] {
  return logo.split('\n').filter((line) => line.length > 0)
}

/**
 * Calculates responsive layout dimensions based on terminal size
 */
export function calculateResponsiveLayout(
  terminalWidth: number,
  terminalHeight: number,
) {
  // Responsive breakpoints based on terminal height
  const isVerySmall = terminalHeight < 15 // Minimal UI
  const isSmall = terminalHeight >= 15 && terminalHeight < 20 // Compact UI
  const isMedium = terminalHeight >= 20 && terminalHeight < 30 // Standard UI
  const isLarge = terminalHeight >= 30 // Spacious UI

  // Responsive breakpoints based on terminal width
  const isNarrow = terminalWidth < 60

  // Dynamic spacing based on terminal size - compressed to prevent scrolling
  const containerPadding = isVerySmall ? 0 : 1
  const headerMarginTop = 0
  const headerMarginBottom = isVerySmall ? 0 : 1
  const sectionMarginBottom = isVerySmall ? 0 : 1
  const contentMaxWidth = Math.max(
    10,
    Math.min(terminalWidth - (containerPadding * 2 + 4), 80),
  )

  const maxUrlWidth = Math.min(terminalWidth - 10, 100)

  return {
    isVerySmall,
    isSmall,
    isMedium,
    isLarge,
    isNarrow,
    containerPadding,
    headerMarginTop,
    headerMarginBottom,
    sectionMarginBottom,
    contentMaxWidth,
    maxUrlWidth,
  }
}
