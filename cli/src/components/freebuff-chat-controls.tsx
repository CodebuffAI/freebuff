import { useKeyboard } from '@opentui/react'
import { useCallback, useEffect } from 'react'

import { Button } from './button'
import { FreebuffModelSelector } from './freebuff-model-selector'
import { useTheme } from '../hooks/use-theme'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import {
  beginFreebuffChatAdmission,
  FREEBUFF_ADMISSION_QUEUE_PAUSED_MESSAGE,
} from '../hooks/use-freebuff-chat-admission'
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
  openFreebuffModelPicker,
  selectFreebuffChatModel,
  requestFreebuffChatAdmission,
  type ChatAdmission,
} from '../state/freebuff-chat-store'
import { captureCliFunnel } from '../utils/cli-product-funnel'
import { isPlainEnterKey } from '../utils/terminal-enter-detection'

type EnterAction = { label: string; run: () => void }

/** What Enter, and the button beside Esc, does for this admission. */
function enterAction(
  admission: ChatAdmission,
  takeover: boolean,
  waitingOnTurn: boolean,
): EnterAction | null {
  const counted = (label: string, run: () => unknown): EnterAction => ({
    label,
    run: () => {
      captureCliFunnel('admission', 'clicked', { model: admission.model })
      void run()
    },
  })
  if (takeover) return counted('Enter: take over', takeOverFreebuffSession)
  if (admission.phase === 'confirm')
    return counted('Enter: confirm and send', () =>
      beginFreebuffChatAdmission(admission),
    )
  // Retrying a refusal for too few hours only repeats it.
  if (admission.phase === 'failed' && admission.chooseModel)
    return { label: 'Enter: choose another model', run: openFreebuffModelPicker }
  if (admission.phase === 'failed')
    return counted('Enter: retry', requestFreebuffChatAdmission)
  // A message queued behind a running turn: nothing is starting yet.
  if (waitingOnTurn)
    return { label: 'Enter: change model', run: openFreebuffModelPicker }
  return null
}

export function FreebuffChatControls() {
  const theme = useTheme()
  const { terminalHeight } = useTerminalDimensions()
  const pickerOpen = useFreebuffChatStore((s) => s.pickerOpen)
  const pickerInitialView = useFreebuffChatStore((s) => s.pickerInitialView)
  const admission = useFreebuffChatStore((s) => s.admission)
  const nextModel = useFreebuffChatStore((s) => s.nextModel)
  const model = useFreebuffModelStore((s) => s.selectedModel)
  const session = useFreebuffSessionStore((s) => s.session)
  const { clearQueue, queuePaused, turnRunning } = useChatRuntime()
  const takeover = session?.status === 'takeover_prompt'
  const waitingOnTurn =
    admission?.phase === 'requested' && !queuePaused && turnRunning
  const enter = admission
    ? enterAction(admission, takeover, waitingOnTurn)
    : null
  useEffect(() => {
    if (pickerOpen) {
      captureCliFunnel('model_picker', 'shown', { model: nextModel ?? model })
      void refreshFreebuffSessionMetadata().catch(() => {})
    }
  }, [pickerOpen])
  useEffect(() => {
    if (!admission) return
    const state =
      admission.phase === 'failed'
        ? 'failed'
        : admission.phase === 'starting'
          ? 'started'
          : 'shown'
    captureCliFunnel('admission', state, { model: admission.model })
  }, [admission?.phase, admission?.model])

  const cancel = useCallback(async () => {
    if (pickerOpen) {
      captureCliFunnel('model_picker', 'cancelled')
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
    captureCliFunnel('admission', 'cancelled', { model: current.model })
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
          enter?.run()
        }
      },
      [cancel, enter, pickerOpen],
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
          onSelectModel={(selected) => {
            selectFreebuffChatModel(selected)
            if (!useFreebuffChatStore.getState().pickerOpen)
              captureCliFunnel('model_selection', 'selected', {
                model: selected,
                previous_model: nextModel ?? model,
                selection_kind:
                  selected === (nextModel ?? model) ? 'reselected' : 'changed',
              })
          }}
          onCancel={() => {
            captureCliFunnel('model_picker', 'cancelled')
            useFreebuffChatStore.setState({ pickerOpen: false })
          }}
        />
      </box>
    )
  if (!admission) return null
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
            (admission.phase === 'requested' && queuePaused
              ? FREEBUFF_ADMISSION_QUEUE_PAUSED_MESSAGE
              : waitingOnTurn
                ? 'Your message is saved and will send after the current turn.'
                : 'Starting your model session… Your message is saved.'))}
      </text>
      <box style={{ flexDirection: 'row', gap: 2 }}>
        {enter && (
          <Button onClick={enter.run}>
            <text style={{ fg: theme.primary }}>{enter.label}</text>
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
