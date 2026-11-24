import { Button } from './button'
import { DisplayAdStatusline } from './display-ad-statusline'
import { CLI_DISPLAY_AD_PLACEMENT_IDS } from '../ads/display-ads'
import { useTheme } from '../hooks/use-theme'
import { useChatStore } from '../state/chat-store'
import { useFreebuffModelDirectory } from '../state/freebuff-catalog-store'
import {
  useFreebuffChatStore,
  openFreebuffModelPicker,
} from '../state/freebuff-chat-store'
import {
  useFreebuffModelStore,
  getEffectiveFreebuffReasoningEffort,
} from '../state/freebuff-model-store'
import { truncateToSingleLinePreview } from '../utils/agent-display'
import { getFirstUserPrompt } from '../utils/chat-meta'
import { formatCwd } from '../utils/path-helpers'

export function FreebuffChatFooter({ projectRoot }: { projectRoot: string }) {
  const theme = useTheme()
  const selected = useFreebuffModelStore((s) => s.selectedModel)
  useFreebuffModelStore((s) => s.reasoningEffortByModel)
  const nextModel = useFreebuffChatStore((s) => s.nextModel)
  const directory = useFreebuffModelDirectory()
  const model = directory.get(nextModel ?? selected)
  const effort = getEffectiveFreebuffReasoningEffort(model.id)
  const prompt = useChatStore((s) => getFirstUserPrompt(s.messages))
  // Only while the message it names still opens the chat.
  const title = useChatStore((s) =>
    s.chatTitle &&
    s.messages.find((m) => m.variant === 'user')?.id === s.chatTitle.messageId
      ? s.chatTitle.title
      : null,
  )
  // The prompt stands in until the model's title arrives, or if it never does.
  const name =
    title ??
    (prompt === '(empty chat)'
      ? 'New chat'
      : truncateToSingleLinePreview(prompt, 40))
  return (
    <box style={{ flexDirection: 'column', flexShrink: 0 }}>
      <box style={{ flexDirection: 'column', paddingLeft: 1 }}>
        <Button onClick={openFreebuffModelPicker}>
          <text style={{ wrapMode: 'word', fg: theme.foreground }}>
            <span
              fg={theme.primary}
            >{`${model.displayName}${effort ? ` • ${effort}` : ''}`}</span>
            <span fg={theme.muted}>{` · ${formatCwd(projectRoot)} · `}</span>
            <span fg={theme.primary}>/model</span>
            <span
              fg={theme.muted}
            >{` to change · Chat: ${name}`}</span>
          </text>
        </Button>
        <text style={{ fg: theme.muted }}>
          <span fg={theme.foreground}>←</span> for history ·{' '}
          <span fg={theme.foreground}>?</span> for help
        </text>
      </box>
      <DisplayAdStatusline
        placementId={CLI_DISPLAY_AD_PLACEMENT_IDS.cliStatusline}
      />
    </box>
  )
}
