import { memo, useState } from 'react'

import { useLogo } from '../hooks/use-logo'
import { useSheenAnimation } from '../hooks/use-sheen-animation'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { useTheme } from '../hooks/use-theme'
import { IS_FREEBUFF } from '../utils/constants'
import { openFileAtPath } from '../utils/open-file'
import { formatCwd } from '../utils/path-helpers'
import { getLogoAccentColor, getLogoBlockColor } from '../utils/theme-system'
import { shouldAnimateChatHeader } from '../utils/chat-header-animation'
import { TerminalLink } from './terminal-link'

export const ChatHeader = memo(function ChatHeader({
  projectRoot,
  animationEnabled,
}: {
  projectRoot: string
  animationEnabled: boolean
}) {
  const { contentMaxWidth, terminalWidth } = useTerminalDimensions()
  const theme = useTheme()
  const [sheenPosition, setSheenPosition] = useState(0)
  const blockColor = getLogoBlockColor(theme.name)
  const accentColor = getLogoAccentColor(theme.name)
  const { applySheenToChar } = useSheenAnimation({
    enabled: shouldAnimateChatHeader(animationEnabled, IS_FREEBUFF),
    logoColor: theme.foreground,
    accentColor,
    blockColor,
    terminalWidth,
    sheenPosition,
    setSheenPosition,
  })
  const { component: logoComponent } = useLogo({
    availableWidth: contentMaxWidth,
    accentColor,
    blockColor,
    applySheenToChar,
  })

  return (
    <box
      style={{
        flexDirection: 'column',
        gap: 0,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <box
        style={{
          flexDirection: 'column',
          marginBottom: 1,
          marginTop: 2,
        }}
      >
        {logoComponent}
      </box>
      <text style={{ wrapMode: 'word', marginBottom: 1, fg: theme.foreground }}>
        {IS_FREEBUFF ? 'Freebuff' : 'Codebuff'} will run commands on your behalf
        to help you build.
      </text>
      <text style={{ wrapMode: 'word', marginBottom: 1, fg: theme.foreground }}>
        Directory{' '}
        <TerminalLink
          text={formatCwd(projectRoot)}
          color={theme.muted}
          inline={true}
          underlineOnHover={true}
          onActivate={() => openFileAtPath(projectRoot)}
        />
      </text>
    </box>
  )
})
