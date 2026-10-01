import { useKeyboard } from '@opentui/react'
import { useCallback, useMemo, useRef } from 'react'

import { ClickableTitleBox } from './clickable-title-box'
import { WriteTodosItem } from './tools/write-todos'
import { useTheme } from '../hooks/use-theme'
import { getLatestTodos } from '../utils/todos'
import { BORDER_CHARS } from '../utils/ui-constants'

import type { ChatMessage } from '../types/chat'
import type { KeyEvent, ScrollBoxRenderable } from '@opentui/core'

interface TodoPanelProps {
  messages: ChatMessage[]
  onClose: () => void
  maxVisibleRows?: number
}

/** A local, live view of the latest main-agent checklist, outside the transcript. */
export function TodoPanel({
  messages,
  onClose,
  maxVisibleRows = 8,
}: TodoPanelProps) {
  const theme = useTheme()
  const scrollRef = useRef<ScrollBoxRenderable | null>(null)
  const todos = useMemo(() => getLatestTodos(messages), [messages])
  const completed = todos.filter((todo) => todo.completed).length

  useKeyboard(
    useCallback(
      (key: KeyEvent) => {
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
          key.preventDefault()
          onClose()
          return
        }
        if (key.ctrl || key.meta || key.option || key.shift) return
        const scrollbox = scrollRef.current
        if (!scrollbox) return
        switch (key.name) {
          case 'up':
            scrollbox.scrollBy(-1)
            break
          case 'down':
            scrollbox.scrollBy(1)
            break
          case 'pageup':
            scrollbox.scrollBy(-1, 'viewport')
            break
          case 'pagedown':
            scrollbox.scrollBy(1, 'viewport')
            break
          case 'home':
            scrollbox.scrollTo(0)
            break
          case 'end':
            scrollbox.scrollTo(scrollbox.scrollHeight)
            break
          default:
            return
        }
        key.preventDefault()
      },
      [onClose],
    ),
  )

  return (
    <ClickableTitleBox
      title={` ▾ Todos — ${completed}/${todos.length} completed `}
      titleAlignment="center"
      onTitleClick={onClose}
      style={{
        width: '100%',
        borderStyle: 'single',
        borderColor: theme.border,
        customBorderChars: BORDER_CHARS,
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: 'column',
      }}
    >
      {todos.length === 0 ? (
        <text style={{ fg: theme.muted, wrapMode: 'word' }}>
          No todos yet. The agent's checklist will appear here when it creates
          one.
        </text>
      ) : (
        <scrollbox
          ref={scrollRef}
          scrollX={false}
          style={{ height: maxVisibleRows, width: '100%' }}
        >
          <WriteTodosItem todos={todos} showHeader={false} />
        </scrollbox>
      )}
      <text style={{ fg: theme.muted, wrapMode: 'word' }}>
        Latest main-agent checklist · ↑↓ scroll · esc close
      </text>
    </ClickableTitleBox>
  )
}
