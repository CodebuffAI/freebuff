import {
  startToolTag,
  endToolTag,
  toolNameParam,
} from '@codebuff/common/tools/constants'

export type ParsedToolCallFromText = {
  type: 'tool_call'
  toolName: string
  input: Record<string, unknown>
}

export type ParsedTextSegment = {
  type: 'text'
  text: string
}

export type ParsedSegment = ParsedToolCallFromText | ParsedTextSegment

/**
 * Parses text containing tool calls in the <codebuff_tool_call> XML format,
 * returning interleaved text and tool call segments in order.
 *
 * Example input:
 * ```
 * Some text before
 * <codebuff_tool_call>
 * {
 *   "cb_tool_name": "read_files",
 *   "paths": ["file.ts"]
 * }
 * </codebuff_tool_call>
 * Some text after
 * ```
 *
 * @param text - The text containing tool calls in XML format
 * @returns Array of segments (text and tool calls) in order of appearance
 */
export function parseTextWithToolCalls(text: string): ParsedSegment[] {
  const segments: ParsedSegment[] = []

  // Match <codebuff_tool_call>...</codebuff_tool_call> blocks
  const toolExtractionPattern = new RegExp(
    `${escapeRegex(startToolTag)}([\\s\\S]*?)${escapeRegex(endToolTag)}`,
    'gs',
  )

  let lastIndex = 0

  for (const match of text.matchAll(toolExtractionPattern)) {
    // Add any text before this tool call
    if (match.index !== undefined && match.index > lastIndex) {
      const textBefore = text.slice(lastIndex, match.index).trim()
      if (textBefore) {
        segments.push({ type: 'text', text: textBefore })
      }
    }

    const jsonContent = match[1].trim()

    try {
      const parsed = JSON.parse(jsonContent)
      const toolName = parsed[toolNameParam]

      if (typeof toolName === 'string') {
        // Remove the tool name param from the input
        const input = { ...parsed }
        delete input[toolNameParam]

        // Also remove cb_easp if present
        delete input['cb_easp']

        segments.push({
          type: 'tool_call',
          toolName,
          input,
        })
      }
    } catch {
      // Skip malformed JSON - don't add segment
    }

    // Update lastIndex to after this match
    if (match.index !== undefined) {
      lastIndex = match.index + match[0].length
    }
  }

  // Add any remaining text after the last tool call
  if (lastIndex < text.length) {
    const textAfter = text.slice(lastIndex).trim()
    if (textAfter) {
      segments.push({ type: 'text', text: textAfter })
    }
  }

  return segments
}

/**
 * Parses tool calls from text in the <codebuff_tool_call> XML format.
 * This is a convenience function that returns only tool calls (no text segments).
 *
 * @param text - The text containing tool calls in XML format
 * @returns Array of parsed tool calls with toolName and input
 */
export function parseToolCallsFromText(
  text: string,
): Omit<ParsedToolCallFromText, 'type'>[] {
  return parseTextWithToolCalls(text)
    .filter((segment): segment is ParsedToolCallFromText => segment.type === 'tool_call')
    .map(({ toolName, input }) => ({ toolName, input }))
}

function escapeRegex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
