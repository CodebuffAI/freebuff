import type { CallToolResult, TextResourceContents, BlobResourceContents } from '@modelcontextprotocol/sdk/types.js'

import type { ToolResultOutput } from '../types/messages/content-part'

function getResourceData(
  resource: TextResourceContents | BlobResourceContents,
): string {
  if ('text' in resource) return resource.text as string
  if ('blob' in resource) return resource.blob as string
  return ''
}

/**
 * Convert MCP tool-result content blocks into codebuff tool-result outputs.
 *
 * A resource with text contents is text, not media. Wrapping prose as
 * media makes the AI SDK base64-decode it when rebuilding the prompt on
 * every later turn, which dies with "The string contains invalid
 * characters" forever, since the poisoned message replays from history.
 *
 * Only images stay media: every provider path (including the
 * OpenAI-compatible chat converter used by GLM) accepts image file
 * parts but throws on anything else — and a thrown converter poisons
 * the whole session, since the message replays on every later turn.
 * Other binary resources (gzip, PDF, ...) surface metadata instead of
 * undecodable bytes.
 */
export function mcpContentToToolResultOutputs(
  content: CallToolResult['content'],
): ToolResultOutput[] {
  return content.map((c: (typeof content)[number]) => {
    if (c.type === 'text') {
      return {
        type: 'json',
        value: c.text,
      } satisfies ToolResultOutput
    }
    if (c.type === 'audio') {
      return {
        type: 'media',
        data: c.data,
        mediaType: c.mimeType,
      } satisfies ToolResultOutput
    }
    if (c.type === 'image') {
      return {
        type: 'media',
        data: c.data,
        mediaType: c.mimeType,
      } satisfies ToolResultOutput
    }
    if (c.type === 'resource') {
      if ('text' in c.resource) {
        return {
          type: 'json',
          value: c.resource.text,
        } satisfies ToolResultOutput
      }
      const mimeType = c.resource.mimeType ?? 'application/octet-stream'
      if (mimeType.startsWith('image/')) {
        return {
          type: 'media',
          data: getResourceData(c.resource),
          mediaType: mimeType,
        } satisfies ToolResultOutput
      }
      const blobData = getResourceData(c.resource)
      return {
        type: 'json',
        value: `[Binary resource ${c.resource.uri}: ${mimeType}, ~${Math.round((blobData.length * 3) / 4)} bytes, not displayable]`,
      } satisfies ToolResultOutput
    }
    const fallbackValue =
      'uri' in c && typeof (c as { uri: unknown }).uri === 'string'
        ? (c as { uri: string }).uri
        : JSON.stringify(c)
    return {
      type: 'json',
      value: fallbackValue,
    } satisfies ToolResultOutput
  })
}
