import { describe, expect, it } from 'bun:test'

import { normalizeProviderRequestBodyForCacheDebug } from '../cache-debug'

describe('cache-debug data URL handling', () => {
  it('summarizes valid data URLs', () => {
    const result = normalizeProviderRequestBodyForCacheDebug({
      provider: 'openai',
      body: {
        model: 'gpt-4',
        messages: [
          {
            role: 'user',
            content: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
          },
        ],
      },
    })

    const message = (result as { messages: unknown[] }).messages[0] as {
      content: { type: string; mediaType: string; payloadLength: number }
    }
    expect(message.content.type).toBe('data-url')
    expect(message.content.mediaType).toBe('image/png')
    expect(message.content.payloadLength).toBeGreaterThan(0)
  })

  it('passes through non-data-URL strings unchanged', () => {
    const result = normalizeProviderRequestBodyForCacheDebug({
      provider: 'openai',
      body: {
        model: 'gpt-4',
        messages: [
          {
            role: 'user',
            content: 'https://example.com/image.png',
          },
        ],
      },
    })

    const message = (result as { messages: unknown[] }).messages[0] as {
      content: string
    }
    expect(message.content).toBe('https://example.com/image.png')
  })

  it('handles data URL-like strings without comma gracefully', () => {
    // Edge case: string starts with "data:" but has no comma
    const result = normalizeProviderRequestBodyForCacheDebug({
      provider: 'openai',
      body: {
        model: 'gpt-4',
        messages: [
          {
            role: 'user',
            content: 'data:image/png;base64',
          },
        ],
      },
    })

    const message = (result as { messages: unknown[] }).messages[0] as {
      content: { type: string; mediaType: string; payloadLength: number }
    }
    expect(message.content.type).toBe('data-url')
    expect(message.content.mediaType).toBe('image/png')
    expect(message.content.payloadLength).toBe(0)
  })
})
