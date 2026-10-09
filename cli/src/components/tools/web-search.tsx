import { SimpleToolCallItem } from './tool-call-item'
import { defineToolComponent } from './types'

import type { ToolRenderConfig } from './types'

/**
 * UI component for web_search tool.
 * Displays the search query in a compact format.
 */
export const WebSearchComponent = defineToolComponent({
  toolName: 'web_search',

  render(toolBlock, theme): ToolRenderConfig {
    const input = toolBlock.input as { query?: string } | undefined

    const query = typeof input?.query === 'string' ? input.query.trim() : ''

    if (!query) {
      return { content: null }
    }

    return {
      content: (
        <SimpleToolCallItem
          name="Web Search"
          description={query}
          descriptionColor={theme.muted}
        />
      ),
    }
  },
})
