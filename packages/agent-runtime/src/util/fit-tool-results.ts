import { countTokensMessages } from './token-counter'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { JSONValue } from '@codebuff/common/types/json'

/** Only used when fresh results cannot fit even with all older history removed. */
export function fitToolResults(
  messages: Message[],
  tokenBudget: number,
): Message[] {
  if (countTokensMessages(messages) <= tokenBudget) return messages

  // Never mutate the full results already handed to the UI/trace writer.
  const fitted: Message[] = messages.map((message) =>
    message.role === 'tool'
      ? {
          ...message,
          content: message.content.map((part) =>
            part.type === 'json'
              ? { ...part, value: structuredClone(part.value) }
              : part,
          ),
        }
      : message,
  )
  const calls = new Map(
    fitted.flatMap((message) =>
      message.role === 'assistant'
        ? message.content.flatMap((part) =>
            part.type === 'tool-call'
              ? [[part.toolCallId, part.input] as const]
              : [],
          )
        : [],
    ),
  )
  const slots: {
    restore: () => void
    clip: (chars: number) => void
    length: number
  }[] = []

  for (const message of fitted) {
    if (message.role !== 'tool') continue
    for (const part of message.content) {
      if (part.type !== 'json') continue // Images are indivisible.
      const original = part.value
      if (message.toolName === 'read_files' && Array.isArray(original)) {
        for (let i = 0; i < original.length; i++) {
          const file = original[i]
          if (
            !file ||
            typeof file !== 'object' ||
            Array.isArray(file) ||
            typeof file.path !== 'string' ||
            typeof file.content !== 'string'
          )
            continue
          const { path, content } = file
          const paths = calls.get(message.toolCallId)?.paths
          const windows = Array.isArray(paths)
            ? paths.filter(
                (entry) =>
                  entry === path ||
                  (entry && typeof entry === 'object' && entry.path === path),
              )
            : []
          // Multiple windows are joined into one result: do not invent a line
          // number for a prefix that may cross that join.
          const window = windows.length === 1 ? windows[0] : undefined
          const annotated =
            content.includes('[read_files:') ||
            content.includes('[FILE_TOO_LARGE]') ||
            content.startsWith('[TEMPLATE]')
          const startLine = annotated
            ? undefined
            : typeof window === 'string'
              ? 1
              : window && typeof window === 'object'
                ? Math.max(
                    1,
                    Math.floor(
                      typeof window.offset === 'number' ? window.offset : 1,
                    ),
                  )
                : undefined
          const clip = (chars: number) => {
            const end = chars > 0 ? content.lastIndexOf('\n', chars - 1) : -1
            const prefix = end >= 0 ? content.slice(0, end + 1) : ''
            const next =
              startLine !== undefined
                ? ` Read this file with offset=${startLine + (prefix.match(/\n/g)?.length ?? 0)} and a smaller limit to continue; use code_search for oversized lines.`
                : ' Read a smaller explicit window of this file using offset and limit, or use code_search to locate the needed section.'
            original[i] = {
              path,
              content:
                prefix +
                `\n[read_files: ${prefix ? 'Remaining contents' : 'Contents'} omitted to fit the context window.${next}]`,
            }
          }
          slots.push({
            length: content.length,
            clip,
            restore: () => {
              original[i] = file
            },
          })
          clip(0)
        }
      } else {
        const text =
          typeof original === 'string' ? original : JSON.stringify(original)
        const clip = (chars: number) => {
          part.value = {
            truncated: true,
            notice:
              'Tool result shortened to fit the context window. The tool already ran; do not repeat state-changing actions. Request a smaller output if needed.',
            preview: text.slice(0, chars),
          } satisfies JSONValue
        }
        slots.push({
          length: text.length,
          clip,
          restore: () => {
            part.value = original
          },
        })
        clip(0)
      }
    }
  }

  if (countTokensMessages(fitted) > tokenBudget) {
    throw new Error(
      'The latest tool calls and their result metadata exceed the configured context window. Use a larger supported context window or request fewer tools at once.',
    )
  }

  // Requested order, with space already reserved for every later result's
  // omission notice. Count the whole message envelope, not just source text.
  for (const slot of slots) {
    slot.restore()
    if (countTokensMessages(fitted) <= tokenBudget) continue
    let low = 0
    let high = slot.length
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      slot.clip(mid)
      if (countTokensMessages(fitted) <= tokenBudget) low = mid
      else high = mid - 1
    }
    slot.clip(low)
    // Tokenization isn't strictly monotonic at string boundaries. Never return
    // an oversized request even for that edge case.
    if (countTokensMessages(fitted) > tokenBudget) slot.clip(0)
  }
  return fitted
}
