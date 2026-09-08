import { describe, test, expect } from 'bun:test'

import { mcpContentToToolResultOutputs } from '../client'

/**
 * Regression tests for MCP tool-result content mapping.
 *
 * Tool results live in message history and are replayed into every later
 * prompt build, and the AI SDK base64-decodes file-part data at prompt
 * build. Text content therefore never travels as media: prose stored as
 * media died with "The string contains invalid characters" on every
 * subsequent turn, permanently, because the poisoned message replays from
 * history.
 */
describe('mcpContentToToolResultOutputs resources', () => {
  /**
   * Given: an MCP resource whose contents are plain text.
   * When: it is mapped.
   * Then: the output is a json value carrying that text - never media.
   */
  test('maps text resource to json value not media', () => {
    const outputs = mcpContentToToolResultOutputs([
      {
        type: 'resource',
        resource: {
          uri: 'file:///notes.txt',
          mimeType: 'text/plain',
          text: 'Resource 1: This is a plain text resource.',
        },
      },
    ] as never)

    expect(outputs).toEqual([
      {
        type: 'json',
        value: 'Resource 1: This is a plain text resource.',
      },
    ])
  })

  /**
   * Given: an MCP resource carrying binary image data.
   * When: it is mapped.
   * Then: the output stays media with the server's mime type, because
   *   every provider path accepts image file parts.
   */
  test('keeps image resource as media with server mime type', () => {
    const outputs = mcpContentToToolResultOutputs([
      {
        type: 'resource',
        resource: {
          uri: 'file:///logo.png',
          mimeType: 'image/png',
          blob: 'aGVsbG8=',
        },
      },
    ] as never)

    expect(outputs).toHaveLength(1)
    expect(outputs[0].type).toBe('media')
    expect((outputs[0] as { mediaType?: string }).mediaType).toBe('image/png')
  })

  /**
   * Given: an MCP resource carrying non-image binary data.
   * When: it is mapped.
   * Then: the output is descriptive text, not media - media here killed
   *   the OpenAI-compatible converter at prompt build (session death).
   */
  test('maps non-image binary resource to descriptive text not media', () => {
    const outputs = mcpContentToToolResultOutputs([
      {
        type: 'resource',
        resource: {
          uri: 'file:///archive.gz',
          mimeType: 'application/gzip',
          blob: 'aGVsbG8=',
        },
      },
    ] as never)

    expect(outputs[0].type).toBe('json')

    const value = (outputs[0] as { value: string }).value
    expect(value).toContain('application/gzip')
    expect(value).toContain('not displayable')
  })

  /**
   * Given: an ordinary MCP text content block (no resource involved).
   * When: it is mapped.
   * Then: it stays a json value - the extraction must not alter the
   *   pre-existing text mapping.
   */
  test('maps plain text content to json value', () => {
    const outputs = mcpContentToToolResultOutputs([
      { type: 'text', text: 'Echo: hello' },
    ] as never)

    expect(outputs).toEqual([{ type: 'json', value: 'Echo: hello' }])
  })
})
