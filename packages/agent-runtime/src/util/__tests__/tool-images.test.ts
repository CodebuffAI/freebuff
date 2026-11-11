import { describe, expect, test } from 'bun:test'

import {
  assistantMessage,
  convertCbToModelMessages,
  jsonToolResult,
  mediaToolResult,
  userMessage,
} from '@codebuff/common/util/messages'

import {
  capToolResultImages,
  DETACHED_IMAGE_NOTE,
  DETACHED_IMAGE_TEXT,
  MAX_ATTACHED_TOOL_IMAGE_CHARS,
  MAX_ATTACHED_TOOL_IMAGES,
} from '../tool-images'

import type { Message, ToolMessage } from '@codebuff/common/types/messages/codebuff-message'

const image = (chars: number, tag = 'a') => tag.repeat(chars)

/** A read_files result for `paths`, each image attached after the entries. */
function readImages(id: string, paths: string[], chars = 100_000): ToolMessage {
  return {
    role: 'tool',
    toolCallId: id,
    toolName: 'read_files',
    content: [
      ...jsonToolResult(
        paths.map((path) => ({
          path,
          content: `[IMAGE] image/png, ${Math.round(chars / 1365)} KB. The image is attached after this result.`,
        })),
      ),
      ...paths.flatMap(() => mediaToolResult({ data: image(chars), mediaType: 'image/png' })),
    ],
  }
}

const attached = (messages: Message[]) =>
  messages.flatMap((m) =>
    m.role === 'tool' ? m.content.filter((p) => p.type === 'media') : [],
  )

describe('capToolResultImages', () => {
  test('the 2026-11-11 chat: 216 page images keep only the newest window attached', () => {
    const history: Message[] = []
    for (let call = 0; call < 54; call++)
      history.push(
        readImages(`c${call}`, [0, 1, 2, 3].map((n) => `work/hh/p${call}-${n}.png`)),
      )
    expect(attached(history)).toHaveLength(216)

    const capped = capToolResultImages(history)
    const kept = attached(capped)
    expect(kept).toHaveLength(MAX_ATTACHED_TOOL_IMAGES)
    expect(kept.reduce((n, p) => n + (p.type === 'media' ? p.data.length : 0), 0))
      .toBeLessThanOrEqual(MAX_ATTACHED_TOOL_IMAGE_CHARS)
    // The newest two calls are untouched objects; everything older is detached.
    expect(capped[53]).toBe(history[53])
    expect(capped[52]).toBe(history[52])
    const old = capped[0] as ToolMessage
    expect(old.content.some((p) => p.type === 'media')).toBe(false)
    const entries = (old.content[0] as unknown as { value: Array<{ content: string }> }).value
    for (const entry of entries) {
      expect(entry.content).toStartWith('[IMAGE]')
      expect(entry.content).toContain(DETACHED_IMAGE_TEXT)
      expect(entry.content).not.toContain('attached after this result')
    }
    // Detaching is stable: a second pass changes nothing.
    expect(capToolResultImages(capped)).toBe(capped)
  })

  test('the newest result is kept whole even over the size budget', () => {
    const big = Math.ceil(MAX_ATTACHED_TOOL_IMAGE_CHARS / 2)
    const history: Message[] = [
      readImages('older', ['a.png'], 10),
      readImages('newest', ['b.png', 'c.png', 'd.png'], big),
    ]
    const capped = capToolResultImages(history)
    expect(capped[1]).toBe(history[1])
    expect(attached([capped[1]!])).toHaveLength(3)
    expect(attached([capped[0]!])).toHaveLength(0)
  })

  test('a media-only result gets one note and still answers its call once', () => {
    const screenshot: ToolMessage = {
      role: 'tool',
      toolCallId: 'shot',
      toolName: 'preview_screenshot',
      content: mediaToolResult({ data: image(10), mediaType: 'image/png' }),
    }
    const history: Message[] = [
      assistantMessage({
        content: [{ type: 'tool-call', toolCallId: 'shot', toolName: 'preview_screenshot', input: {} }],
      }),
      screenshot,
      ...Array.from({ length: MAX_ATTACHED_TOOL_IMAGES }, (_, i) => readImages(`r${i}`, [`f${i}.png`], 10)),
    ]
    const capped = capToolResultImages(history)
    const detached = capped[1] as ToolMessage
    expect(detached.content).toEqual([{ type: 'json', value: DETACHED_IMAGE_NOTE }])
    const model = convertCbToModelMessages({ messages: capped.slice(0, 2), includeCacheControl: false })
    const results = model.filter((m) => m.role === 'tool')
    expect(results).toHaveLength(1)
    expect(model.some((m) => m.role === 'user')).toBe(false)
  })

  test('user-attached images and image-free histories are left alone', () => {
    const user = userMessage({
      content: [{ type: 'image', image: image(10), mediaType: 'image/png' }],
    } as Parameters<typeof userMessage>[0])
    const noImages: Message[] = [user, assistantMessage('ok')]
    expect(capToolResultImages(noImages)).toBe(noImages)

    const withTools: Message[] = [
      user,
      ...Array.from({ length: 4 }, (_, i) => readImages(`r${i}`, ['a.png', 'b.png', 'c.png'], 10)),
    ]
    const capped = capToolResultImages(withTools)
    expect(capped[0]).toBe(user)
    expect(attached(capped)).toHaveLength(6)
  })

  test('a tool message without a parts array is skipped, never thrown on', () => {
    const odd = { role: 'tool', toolCallId: 'x', toolName: 'run_terminal_command', content: 'text' } as unknown as Message
    const history: Message[] = [odd, readImages('r', ['a.png'], 10)]
    expect(() => capToolResultImages(history)).not.toThrow()
    expect(capToolResultImages(history)).toBe(history)
  })
})
