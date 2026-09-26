import { getFreebuffModel } from '@codebuff/common/constants/freebuff-models'

import { Button } from './button'
import { useTheme } from '../hooks/use-theme'
import { useChatStore } from '../state/chat-store'
import {
  useFreebuffChatStore,
  openFreebuffModelPicker,
} from '../state/freebuff-chat-store'
import {
  useFreebuffModelStore,
  getEffectiveFreebuffReasoningEffort,
} from '../state/freebuff-model-store'
import { getFirstUserPrompt } from '../utils/chat-meta'
import { formatCwd } from '../utils/path-helpers'

export function FreebuffChatFooter({ projectRoot }: { projectRoot: string }) {
  const theme = useTheme()
  const selected = useFreebuffModelStore((s) => s.selectedModel)
  useFreebuffModelStore((s) => s.reasoningEffortByModel)
  const nextModel = useFreebuffChatStore((s) => s.nextModel)
  const model = getFreebuffModel(nextModel ?? selected)
  const effort = getEffectiveFreebuffReasoningEffort(model.id)
  const name = useChatStore((s) => getFirstUserPrompt(s.messages))
  return (
    <box style={{ flexDirection: 'column', flexShrink: 0, paddingLeft: 1 }}>
      <Button onClick={openFreebuffModelPicker}>
        <text style={{ wrapMode: 'word', fg: theme.foreground }}>
          <span
            fg={theme.primary}
          >{`${model.displayName}${effort ? ` • ${effort}` : ''}`}</span>
          <span fg={theme.muted}>{` · ${formatCwd(projectRoot)} · `}</span>
          <span fg={theme.primary}>/model</span>
          <span
            fg={theme.muted}
          >{` to change · Chat: ${name === '(empty chat)' ? 'New chat' : name.replace(/\s+/g, ' ')}`}</span>
        </text>
      </Button>
      <text style={{ fg: theme.muted }}>
        <span fg={theme.foreground}>←</span> for history ·{' '}
        <span fg={theme.foreground}>?</span> for help
      </text>
    </box>
  )
}
