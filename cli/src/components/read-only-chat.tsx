import { useKeyboard } from '@opentui/react'
import { useCallback, useLayoutEffect } from 'react'

import { Button } from './button'
import { HistoryShortcut } from './history-shortcut'
import { LoadPreviousButton } from './load-previous-button'
import { MessageWithAgents } from './message-with-agents'
import { useChatMessages } from '../hooks/use-chat-messages'
import { useChatUI } from '../hooks/use-chat-ui'
import { useFreebuffCtrlCExit } from '../hooks/use-freebuff-ctrl-c-exit'
import { useChatHistoryStore } from '../state/chat-history-store'
import { useChatStore } from '../state/chat-store'
import { useMessageBlockStore } from '../state/message-block-store'

/** Transcript presentation only: no composer, run callbacks or admission. */
export function ReadOnlyChat({ onChooseModel }: { onChooseModel: () => void }) {
  const messages = useChatStore((state) => state.messages)
  const setMessages = useChatStore((state) => state.setMessages)
  const {
    messageTree,
    visibleTopLevelMessages,
    hiddenMessageCount,
    handleCollapseToggle,
    handleLoadPreviousMessages,
    isUserCollapsing,
  } = useChatMessages({ messages, setMessages })
  const {
    theme,
    markdownPalette,
    messageAvailableWidth,
    scrollRef,
    appliedScrollboxProps,
    scrollUp,
    scrollDown,
    scrollToLatest,
  } = useChatUI({ messages, isUserCollapsing })

  useFreebuffCtrlCExit()
  useKeyboard(
    useCallback(
      (key) => {
        if (key.ctrl || key.meta || key.option) return
        switch (key.name?.toLowerCase()) {
          case 'escape':
            useChatHistoryStore.getState().openChatHistory()
            break
          case 'm':
            onChooseModel()
            break
          case 'up':
            scrollUp()
            break
          case 'down':
            scrollDown()
            break
          case 'pageup':
            scrollRef.current?.scrollBy(-10)
            break
          case 'pagedown':
            scrollRef.current?.scrollBy(10)
            break
          case 'home':
            scrollRef.current?.scrollTo(0)
            break
          case 'end':
            scrollToLatest()
            break
          default:
            return
        }
        key.preventDefault?.()
      },
      [onChooseModel, scrollUp, scrollDown, scrollRef, scrollToLatest],
    ),
  )

  // The shared renderer can retain callbacks from the previous live chat.
  // Replace them with inert defaults before showing any saved message.
  useLayoutEffect(() => {
    const store = useMessageBlockStore.getState()
    store.reset()
    store.setCallbacks({
      ...useMessageBlockStore.getState().callbacks,
      onToggleCollapsed: handleCollapseToggle,
    })
    return () => useMessageBlockStore.getState().reset()
  }, [handleCollapseToggle])
  useLayoutEffect(() => {
    useMessageBlockStore.getState().setContext({
      theme,
      markdownPalette,
      messageTree,
      availableWidth: messageAvailableWidth,
      readOnly: true,
    })
  }, [theme, markdownPalette, messageTree, messageAvailableWidth])

  return (
    <box style={{ flexDirection: 'column', flexGrow: 1 }}>
      <scrollbox
        ref={scrollRef}
        stickyScroll
        stickyStart="bottom"
        scrollX={false}
        {...appliedScrollboxProps}
        style={{
          flexGrow: 1,
          contentOptions: { paddingLeft: 1, paddingRight: 2 },
        }}
      >
        {hiddenMessageCount > 0 && (
          <LoadPreviousButton
            hiddenCount={hiddenMessageCount}
            onLoadMore={handleLoadPreviousMessages}
          />
        )}
        {visibleTopLevelMessages.map((message, index) => (
          <MessageWithAgents
            key={message.id}
            message={message}
            depth={0}
            isLastMessage={index === visibleTopLevelMessages.length - 1}
            availableWidth={messageAvailableWidth}
          />
        ))}
        {messages.length === 0 && (
          <text>No saved messages found. Press H to browse history.</text>
        )}
      </scrollbox>
      <box style={{ flexShrink: 0, flexDirection: 'column', paddingLeft: 1 }}>
        <HistoryShortcut />
        <Button onClick={onChooseModel}>
          <text style={{ fg: theme.foreground }}>
            M · Choose model
          </text>
        </Button>
      </box>
    </box>
  )
}
