import { useKeyboard } from '@opentui/react'
import { useCallback } from 'react'

import { Button } from './button'
import { useTheme } from '../hooks/use-theme'
import { useChatHistoryStore } from '../state/chat-history-store'

export const HISTORY_SHORTCUT_LABEL = 'H · History'

export function HistoryShortcut({ disabled = false }: { disabled?: boolean }) {
  const theme = useTheme()
  const openHistory = useChatHistoryStore((state) => state.openChatHistory)
  useKeyboard(
    useCallback(
      (key) => {
        if (disabled || key.ctrl || key.meta || key.option) return
        if (key.name?.toLowerCase() === 'h') {
          key.preventDefault?.()
          openHistory()
        }
      },
      [disabled, openHistory],
    ),
  )
  return (
    <Button onClick={disabled ? undefined : openHistory}>
      <text style={{ fg: theme.muted }}>{HISTORY_SHORTCUT_LABEL}</text>
    </Button>
  )
}
