import { TextAttributes } from '@opentui/core'

import { defineToolComponent } from './types'
import { useTheme } from '../../hooks/use-theme'
import { parseTodos } from '../../utils/todos'

import type { ToolRenderConfig } from './types'
import type { TodoItem } from '../../utils/todos'

interface WriteTodosItemProps {
  todos: TodoItem[]
  showHeader?: boolean
}

export const WriteTodosItem = ({
  todos,
  showHeader = true,
}: WriteTodosItemProps) => {
  const theme = useTheme()
  const bulletChar = '• '

  return (
    <box
      style={{ flexDirection: 'column', flexShrink: 0, gap: 0, width: '100%' }}
    >
      {/* Header line */}
      {showHeader && (
        <box
          style={{ flexDirection: 'row', alignItems: 'center', width: '100%' }}
        >
          <text style={{ wrapMode: 'word' }}>
            <span fg={theme.foreground}>{bulletChar}</span>
            <span fg={theme.foreground} attributes={TextAttributes.BOLD}>
              TODOs
            </span>
          </text>
        </box>
      )}

      {/* Todo items */}
      {todos.map((todo, index) => (
        <box
          key={`todo-${index}`}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            width: '100%',
            flexShrink: 0,
            paddingLeft: 2,
          }}
        >
          <text style={{ wrapMode: 'word', width: '100%', flexShrink: 0 }}>
            {todo.completed ? (
              <>
                <span fg={theme.success}>{'✓  '}</span>
                <span
                  fg={theme.muted}
                  attributes={TextAttributes.STRIKETHROUGH}
                >
                  {todo.task}
                </span>
              </>
            ) : (
              <>
                <span fg={theme.foreground}>{'☐  '}</span>
                <span fg={theme.foreground}>{todo.task}</span>
              </>
            )}
          </text>
        </box>
      ))}
    </box>
  )
}

/**
 * UI component for write_todos tool.
 * Displays todos with checkboxes for incomplete items and checkmarks for completed items.
 */
export const WriteTodosComponent = defineToolComponent({
  toolName: 'write_todos',

  render(toolBlock): ToolRenderConfig {
    const { input } = toolBlock

    const todos = parseTodos(input) ?? []

    if (todos.length === 0) {
      return { content: null }
    }

    return {
      content: <WriteTodosItem todos={todos} />,
    }
  },
})
