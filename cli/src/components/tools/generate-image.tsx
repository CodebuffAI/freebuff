import { SimpleToolCallItem } from './tool-call-item'
import { defineToolComponent } from './types'

import type { ToolRenderConfig } from './types'

/**
 * One line: the image's prompt. No inline picture: OpenTUI draws text through
 * its own cell buffer and swallows iTerm2's image escape sequence.
 */
export const GenerateImageComponent = defineToolComponent({
  toolName: 'generate_image',

  render(toolBlock, theme): ToolRenderConfig {
    const prompt = String(toolBlock.input?.prompt ?? '').trim()
    return {
      content: (
        <SimpleToolCallItem
          name="Generate image"
          description={prompt}
          descriptionColor={theme.muted}
        />
      ),
    }
  },
})
