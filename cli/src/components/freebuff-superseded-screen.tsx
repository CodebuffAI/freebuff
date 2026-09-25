import { TextAttributes } from '@opentui/core'
import React from 'react'

import { useFreebuffCtrlCExit } from '../hooks/use-freebuff-ctrl-c-exit'
import { useLogo } from '../hooks/use-logo'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { useTheme } from '../hooks/use-theme'
import { getLogoAccentColor, getLogoBlockColor } from '../utils/theme-system'

/**
 * Terminal state after a 409 session_superseded response. This execution claim
 * was released or taken over; never automatically fight its new owner.
 */
export const FreebuffSupersededScreen: React.FC = () => {
  const theme = useTheme()
  const { contentMaxWidth } = useTerminalDimensions()
  const blockColor = getLogoBlockColor(theme.name)
  const accentColor = getLogoAccentColor(theme.name)
  const { component: logoComponent } = useLogo({
    availableWidth: contentMaxWidth,
    accentColor,
    blockColor,
  })

  useFreebuffCtrlCExit()

  return (
    <box
      style={{
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        backgroundColor: theme.background,
        alignItems: 'center',
        justifyContent: 'center',
        paddingLeft: 2,
        paddingRight: 2,
        gap: 1,
      }}
    >
      <box style={{ marginBottom: 1 }}>{logoComponent}</box>
      <text
        style={{ fg: theme.foreground, marginBottom: 1 }}
        attributes={TextAttributes.BOLD}
      >
        This Freebuff session is no longer active here.
      </text>
      <text style={{ fg: theme.muted, wrapMode: 'word' }}>
        The session was released or taken over by another instance.
      </text>
      <text style={{ fg: theme.muted, wrapMode: 'word' }}>
        Restart Freebuff to choose a model and start another session.
      </text>
      <box style={{ marginTop: 1 }}>
        <text style={{ fg: theme.muted }}>
          Press <span fg={theme.primary}>Ctrl+C</span> to exit.
        </text>
      </box>
    </box>
  )
}
