/**
 * Shared pieces of "summarize the user's first message into a tab/thread
 * title": the prompts every surface sends, and the sanitizer that turns raw
 * model output into something safe to draw in a one-line label.
 *
 * Kept dependency-free so the desktop server, the desktop renderer and the web
 * API can all import it.
 */

/** The model only needs the gist; truncate long first messages so the title
 *  call stays cheap and fast. */
export const THREAD_TITLE_INPUT_MAX_CHARS = 2000

/** Titles are drawn in a tab label — anything longer is cut off anyway. */
export const THREAD_TITLE_MAX_CHARS = 60

export const THREAD_TITLE_SYSTEM_PROMPT =
  'You generate short, clean titles for chat conversations. You output only the title.'

export const THREAD_TITLE_INSTRUCTIONS_PROMPT = `Write a concise title (3-6 words) summarizing the topic of the user's message.

Rules:
- Plain text only: no surrounding quotes, no trailing punctuation, no preamble or explanation.
- Write the title in the same language as the user's message.
- Capitalize it like a headline (when the language uses capitalization).
- Describe what the message is *about*, in general terms. Never copy sensitive personal data into the title — names, emails, phone numbers, addresses, API keys, passwords, or other secrets. Summarize the topic, not the private details.
- If the message is too vague to summarize, use its wording as the title instead of a generic placeholder.

Output only the title.`

/**
 * Cleans up the model's raw output into a single-line, quote-free, length-
 * bounded title. Returns null when nothing usable is left, so the caller keeps
 * whatever placeholder it already showed.
 */
export function sanitizeThreadTitle(raw: string): string | null {
  let title = raw.replace(/\s+/g, ' ').trim()
  // a "Title:" label the model sometimes prepends despite instructions
  title = title.replace(/^title:\s*/i, '').trim()
  // surrounding quotes, straight or smart
  title = title.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim()
  // trailing sentence punctuation
  title = title.replace(/[.!?,;:]+$/g, '').trim()
  if (!title) return null
  if (title.length <= THREAD_TITLE_MAX_CHARS) return title
  // Slice by code point, not UTF-16 unit: a 60-unit cut through an emoji or
  // any other astral character leaves a lone high surrogate, which renders as
  // a replacement glyph in the tab label.
  const end = THREAD_TITLE_MAX_CHARS
  const lastUnit = title.charCodeAt(end - 1)
  const cutInsidePair = lastUnit >= 0xd800 && lastUnit <= 0xdbff
  return title.slice(0, cutInsidePair ? end - 1 : end)
}
