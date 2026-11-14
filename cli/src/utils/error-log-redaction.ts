import { summarizeAnalyticsValue } from '@codebuff/common/util/analytics-sampling'
import {
  redactErrorFieldForLog,
  redactQueryErrorForLog,
} from '@codebuff/common/util/log-redaction'

/**
 * Keys whose values are a user's conversation or code: chat history, prompts,
 * file contents, tool inputs and results, an agent's state or output. An error
 * record keeps only their shape (kind and length, or key names). The agent
 * runtime runs inside the CLI and logs through its logger, so these are the
 * names it and the SDK use (`messageHistory`, `systemPrompt`, `agentState`,
 * set_output's `output`, `fileContext`, the AI SDK's `requestBodyValues`).
 * Matched case-insensitively.
 */
const CONVERSATION_KEYS = new Set(
  [
    'messageHistory',
    'messages',
    'message_history',
    'systemPrompt',
    'system',
    'prompt',
    'userPrompt',
    'assistantPrompt',
    'promptMessage',
    'content',
    'contents',
    'text',
    'fileContents',
    'fileContext',
    'knowledgeFiles',
    'userKnowledgeFiles',
    'toolResults',
    'toolResult',
    'toolCalls',
    'input',
    'output',
    'agentState',
    'sessionState',
    'runState',
    'requestBodyValues',
  ].map((key) => key.toLowerCase()),
)

/** Longer strings are a payload, not a reason. Matches the server's error clip. */
export const MAX_ERROR_LOG_STRING_CHARS = 2_000
/** Longer arrays are bulk data; the record keeps their length. */
export const MAX_ERROR_LOG_ARRAY_ITEMS = 25
const MAX_DEPTH = 6

export function clipErrorLogString(text: string): string {
  return text.length > MAX_ERROR_LOG_STRING_CHARS
    ? `${text.slice(0, MAX_ERROR_LOG_STRING_CHARS)}… [${text.length - MAX_ERROR_LOG_STRING_CHARS} chars omitted]`
    : text
}

function sanitize(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') return clipErrorLogString(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') return undefined
  if (value === null || typeof value !== 'object') return value

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
  }
  if (seen.has(value)) return '[Circular]'
  if (depth >= MAX_DEPTH) return summarizeAnalyticsValue(value)
  seen.add(value)

  if (Array.isArray(value)) {
    if (value.length > MAX_ERROR_LOG_ARRAY_ITEMS) {
      return summarizeAnalyticsValue(value)
    }
    return value.map((item) => sanitize(item, depth + 1, seen))
  }

  if (value instanceof Error) {
    // name, message and stack are non-enumerable; library fields (status,
    // code, an AI SDK error's request body) are enumerable and walked below.
    const error = redactQueryErrorForLog(value)
    const fields: Record<string, unknown> = {}
    for (const [key, field] of Object.entries(error)) {
      fields[key] = sanitizeField(key, field, depth, seen)
    }
    return {
      ...fields,
      name: error.name,
      message: clipErrorLogString(error.message),
      ...(error.stack ? { stack: clipErrorLogString(error.stack) } : {}),
      ...(error.cause !== undefined
        ? { cause: sanitize(error.cause, depth + 1, seen) }
        : {}),
    }
  }

  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(value)) {
    out[key] = sanitizeField(key, field, depth, seen)
  }
  return out
}

function sanitizeField(
  key: string,
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (CONVERSATION_KEYS.has(key.toLowerCase())) {
    return summarizeAnalyticsValue(value)
  }
  return sanitize(redactErrorFieldForLog(key, value), depth + 1, seen)
}

/**
 * An error or fatal log payload fit to leave the machine (the Axiom mirror and
 * PostHog error tracking). Error names, messages, stacks and scalar fields
 * stay; conversation-shaped fields become their shape, strings over
 * {@link MAX_ERROR_LOG_STRING_CHARS} are clipped with a length note, and arrays
 * over {@link MAX_ERROR_LOG_ARRAY_ITEMS} become their length.
 */
export function sanitizeErrorLogData(data: unknown): unknown {
  return sanitize(data, 0, new WeakSet())
}
