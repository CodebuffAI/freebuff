/**
 * Set to `true` to log the full LLM request (system prompt, tools, messages)
 * to `debug/cache-debug/` on each user prompt. Use with:
 *   bun scripts/compare-cache-debug.ts
 * to diff sequential requests and find what's breaking prompt caching.
 */
export const CACHE_DEBUG_FULL_LOGGING = false

// When true, reasoning chunks emitted by the model are appended to the
// assistant message history so they replay on the next turn. Consecutive
// reasoning chunks are consolidated into a single message.
export const INCLUDE_REASONING_IN_MESSAGE_HISTORY = true
