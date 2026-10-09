import { SimpleToolCallItem } from './tool-call-item'
import { defineToolComponent } from './types'

import type { ToolRenderConfig } from './types'

/**
 * UI component for read_url tool.
 * Displays the URL being read in a compact format.
 */
export const ReadURLComponent = defineToolComponent({
  toolName: 'read_url',

  render(toolBlock, theme): ToolRenderConfig {
    const input = toolBlock.input as { url?: string } | undefined

    const url = typeof input?.url === 'string' ? input.url.trim() : ''

    if (!url) {
      return { content: null }
    }

    return {
      content: (
        <SimpleToolCallItem
          name="Read URL"
          description={url}
          descriptionColor={theme.muted}
        />
      ),
    }
  },
})
