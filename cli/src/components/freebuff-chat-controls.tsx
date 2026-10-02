import { useKeyboard } from '@opentui/react'
import { useCallback, useEffect } from 'react'

import { Button } from './button'
import { FreebuffModelSelector } from './freebuff-model-selector'
import { useTheme } from '../hooks/use-theme'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { beginFreebuffChatAdmission } from '../hooks/use-freebuff-chat-admission'
import {
  returnToFreebuffLanding,
  refreshFreebuffSessionMetadata,
  takeOverFreebuffSession,
} from '../hooks/use-freebuff-session'
import { useChatRuntime } from '../contexts/chat-runtime-context'
import { useChatStore } from '../state/chat-store'
import { useFreebuffModelStore } from '../state/freebuff-model-store'
import { useFreebuffSessionStore } from '../state/freebuff-session-store'
import {
  useFreebuffChatStore,
  selectFreebuffChatModel,
  requestFreebuffChatAdmission,
} from '../state/freebuff-chat-store'
import { isPlainEnterKey } from '../utils/terminal-enter-detection'

export function FreebuffChatControls() {
  const theme = useTheme()
  const { terminalHeight } = useTerminalDimensions()
  const pickerOpen = useFreebuffChatStore((s) => s.pickerOpen)
  const pickerInitialView = useFreebuffChatStore((s) => s.pickerInitialView)
  const admission = useFreebuffChatStore((s) => s.admission)
  const nextModel = useFreebuffChatStore((s) => s.nextModel)
  const model = useFreebuffModelStore((s) => s.selectedModel)
  const session = useFreebuffSessionStore((s) => s.session)
  const { clearQueue } = useChatRuntime()
  useEffect(() => {
    if (pickerOpen) void refreshFreebuffSessionMetadata().catch(() => {})
  }, [pickerOpen])

  const cancel = useCallback(async () => {
    if (pickerOpen) {
      useFreebuffChatStore.setState({ pickerOpen: false })
      return
    }
    const current = useFreebuffChatStore.getState().admission
    if (!current) return
    // Abort/release an in-flight claim before returning to the composer. The
    // queue remains held until DELETE confirms, including a lost POST reply.
    if (
      current.phase === 'starting' ||
      (current.phase === 'failed' &&
        current.previousSession !== undefined &&
        useFreebuffSessionStore.getState().pendingAdmission)
    ) {
      try {
        await returnToFreebuffLanding({ preserveQueue: true })
      } catch {
        return
      }
    }
    const queued = clearQueue()
    const chat = useChatStore.getState()
    const text = [...queued.map((m) => m.content), chat.inputValue]
      .filter(Boolean)
      .join('\n\n')
    useChatStore.setState((s) => {
      s.pendingAttachments = [
        ...queued.flatMap((m) => m.attachments),
        ...s.pendingAttachments,
      ]
    })
    chat.setInputValue({
      text,
      cursorPosition: text.length,
      lastEditDueToNav: false,
    })
    useFreebuffChatStore.setState({ admission: null })
  }, [pickerOpen, clearQueue])

  const confirm = useCallback(() => {
    if (!admission) return
    if (session?.status === 'takeover_prompt') {
      void takeOverFreebuffSession()
    } else if (admission.phase === 'confirm') {
      void beginFreebuffChatAdmission(admission)
    } else if (admission.phase === 'failed') {
      requestFreebuffChatAdmission()
    }
  }, [admission, session])

  useKeyboard(
    useCallback(
      (key) => {
        if ((!pickerOpen && key.name === 'escape') || (key.ctrl && key.name === 'c')) {
          key.preventDefault?.()
          key.stopPropagation?.()
          void cancel()
        } else if (!pickerOpen && isPlainEnterKey(key)) {
          key.preventDefault?.()
          key.stopPropagation?.()
          confirm()
        }
      },
      [cancel, confirm, pickerOpen],
    ),
  )

  if (pickerOpen)
    return (
      <box style={{ flexDirection: 'column', paddingLeft: 1, paddingRight: 1 }}>
        <text style={{ fg: theme.foreground }}>
          ↑↓ choose model · Tab reasoning · Enter select · Esc cancel
        </text>
        <FreebuffModelSelector
          maxHeight={Math.max(4, Math.floor(terminalHeight * 0.65) - 2)}
          selectedModelOverride={nextModel ?? model}
          initialView={pickerInitialView}
          onSelectModel={selectFreebuffChatModel}
          onCancel={() => useFreebuffChatStore.setState({ pickerOpen: false })}
        />
      </box>
    )
  if (!admission) return null
  const takeover = session?.status === 'takeover_prompt'
  const canConfirm =
    takeover || admission.phase === 'confirm' || admission.phase === 'failed'
  return (
    <box
      style={{
        border: true,
        borderColor: theme.border,
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: 'column',
      }}
    >
      <text style={{ fg: theme.foreground, wrapMode: 'word' }}>
        {takeover
          ? (session.message ??
            'Freebuff is already running elsewhere. Take over that session?')
          : (admission.message ??
            'Starting your model session… Your message is saved.')}
      </text>
      <box style={{ flexDirection: 'row', gap: 2 }}>
        {canConfirm && (
          <Button onClick={confirm}>
            <text style={{ fg: theme.primary }}>
              {takeover
                ? 'Enter: take over'
                : admission.phase === 'failed'
                  ? 'Enter: retry'
                  : 'Enter: confirm and send'}
            </text>
          </Button>
        )}
        <Button
          onClick={() => {
            void cancel()
          }}
        >
          <text style={{ fg: theme.muted }}>Esc: back to draft</text>
        </Button>
      </box>
    </box>
  )
}
