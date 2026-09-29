import { sanitizeTerminalText } from '@codebuff/common/util/terminal-safe-text'
import React from 'react'

import { useTheme } from '../hooks/use-theme'
import { BORDER_CHARS } from '../utils/ui-constants'

interface UserErrorBannerProps {
  error: string
  title?: string
}

/** Displays runtime errors in the UI (not sent to LLM). */
export const UserErrorBanner = React.memo(function UserErrorBanner({
  error,
  title,
}: UserErrorBannerProps) {
  const theme = useTheme()

  // Error text is often a server's (or a provider's) own words, passed
  // through: strip escape sequences before the terminal sees them.
  const safeError = sanitizeTerminalText(error)
  // Handle empty and whitespace-only errors
  const trimmedError = safeError.trim()
  if (!trimmedError) {
    return null
  }

  return (
    <box
      style={{
        width: '100%',
        borderStyle: 'single',
        borderColor: theme.error,
        customBorderChars: BORDER_CHARS,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0,
        flexDirection: 'column',
        gap: 0,
        marginTop: 1,
      }}
    >
      <box
        style={{
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 0,
        }}
      >
        <text style={{ fg: theme.error, wrapMode: 'word' }}>
          {title === undefined ? 'Error' : sanitizeTerminalText(title)}
        </text>
        <text style={{ fg: theme.foreground, wrapMode: 'word' }}>
          {safeError}
        </text>
      </box>
    </box>
  )
})
