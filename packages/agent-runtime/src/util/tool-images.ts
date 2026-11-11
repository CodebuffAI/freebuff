import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { ToolResultOutput } from '@codebuff/common/types/messages/content-part'

/**
 * How many tool-result images stay attached to the conversation, newest
 * first. Two read_files calls' worth (MAX_IMAGES_PER_READ_FILES_CALL is 4).
 *
 * An attached image is re-sent on every later step, and the token counter
 * charges it a flat estimate (token-counter.ts), so compaction never sees its
 * size and never fires on images alone. On 2026-11-11 a chat transcribing
 * scanned attendance sheets read 4 page images at a time until its history
 * held 127 to 216 of them. Every request then carried all of them, copied
 * several times while it was built, and each turn grew its Cloud runner from
 * about 1.2 GB to the 8 GiB limit within a minute: 9 OOM kills, each taking
 * the runner's ~35 other turns with it.
 */
export const MAX_ATTACHED_TOOL_IMAGES = 8

/**
 * The most base64 characters of attached tool-result images, newest first
 * (about 12 MB of image). One Cloud read can be up to 11 MB, so the newest
 * result is always kept whole, whatever its size.
 */
export const MAX_ATTACHED_TOOL_IMAGE_CHARS = 16_000_000

/** What read_files says about an image that is still attached. */
const ATTACHED_IMAGE_TEXT = 'The image is attached after this result.'

/** What it says once the image is no longer attached. Keeps the [IMAGE]
 *  prefix, so compaction still records it as an image the model saw. */
export const DETACHED_IMAGE_TEXT =
  'No longer attached: only the most recent images stay in the conversation. Read the file again to look at it.'

/** The note a tool result gets when its only output was the image. */
export const DETACHED_IMAGE_NOTE =
  'The image(s) from this result are no longer attached: only the most recent images stay in the conversation. Open them again to look.'

type MediaPart = Extract<ToolResultOutput, { type: 'media' }>

function isImagePart(part: ToolResultOutput): part is MediaPart {
  return part.type === 'media' && part.mediaType.startsWith('image/')
}

/** A read_files result's entries, rewritten to say their image is gone. */
function detachReadFilesEntries(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  return value.map((entry) => {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as { content?: unknown }).content === 'string' &&
      (entry as { content: string }).content.startsWith('[IMAGE]')
    ) {
      const content = (entry as { content: string }).content
      return {
        ...entry,
        content: content.includes(ATTACHED_IMAGE_TEXT)
          ? content.replace(ATTACHED_IMAGE_TEXT, DETACHED_IMAGE_TEXT)
          : content,
      }
    }
    return entry
  })
}

/** The tool message without its images, saying so. Each json part becomes its
 *  own provider tool result (convertToolResultMessage), so a note is only
 *  added when no json part is left; a second one would answer the call twice. */
function detachImages(
  message: Extract<Message, { role: 'tool' }>,
): Extract<Message, { role: 'tool' }> {
  const kept = message.content.filter((part) => !isImagePart(part))
  const content: ToolResultOutput[] = kept.map((part) =>
    part.type === 'json' && message.toolName === 'read_files'
      ? { ...part, value: detachReadFilesEntries(part.value) as typeof part.value }
      : part,
  )
  if (!content.some((part) => part.type === 'json'))
    content.unshift({ type: 'json', value: DETACHED_IMAGE_NOTE })
  return { ...message, content }
}

/**
 * Keeps only the newest tool-result images attached: at most
 * MAX_ATTACHED_TOOL_IMAGES and MAX_ATTACHED_TOOL_IMAGE_CHARS, counting whole
 * tool results from the end, and always the newest result that has any.
 * Older results lose their images and say so. User-attached images are
 * untouched. Messages that do not change keep their identity, and a history
 * with nothing to detach is returned as is.
 */
export function capToolResultImages(messages: Message[]): Message[] {
  let images = 0
  let chars = 0
  let full = false
  let out: Message[] | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    // Restored or hand-built state can hold a tool message without a parts
    // array; it has no images to detach, and this must never throw mid-step.
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue
    const parts = message.content.filter(isImagePart)
    if (parts.length === 0) continue
    const size = parts.reduce((total, part) => total + part.data.length, 0)
    const fits =
      images === 0 ||
      (images + parts.length <= MAX_ATTACHED_TOOL_IMAGES &&
        chars + size <= MAX_ATTACHED_TOOL_IMAGE_CHARS)
    if (!full && fits) {
      images += parts.length
      chars += size
      continue
    }
    // Once one result does not fit, every older one goes too: the model keeps
    // a contiguous recent window, never a stray old picture.
    full = true
    out ??= messages.slice()
    out[i] = detachImages(message)
  }
  return out ?? messages
}
