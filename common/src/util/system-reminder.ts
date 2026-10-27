import { BASE3_BATCHING_STEP_PROMPT } from '../constants/base3-step-prompt'

/**
 * How the agent runtime frames an agent's step prompt: a user message of its
 * own, wrapped so the model does not read it as the user speaking again
 * (packages/agent-runtime/src/templates/strings.ts).
 */
export function withSystemReminderTags(text: string): string {
  return `<system_reminder>${text}</system_reminder>`
}

/** Our roots' step reminders, as they arrive. */
const ROOT_STEP_REMINDERS: ReadonlySet<string> = new Set([
  withSystemReminderTags(BASE3_BATCHING_STEP_PROMPT),
])

/**
 * A user message that is exactly one of our roots' step reminders: the last
 * message of every request on base3 batching (agents/base3.ts), and never the
 * user's own words. Matched by its whole text, never by its tags alone, so a
 * prompt cannot pass for one by wrapping itself in them.
 */
export function isRootStepReminderMessage(message: unknown): boolean {
  const { role, content } = (message ?? {}) as {
    role?: unknown
    content?: unknown
  }
  if (role !== 'user') return false
  let text: string
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    const parts = content as { type?: unknown; text?: unknown }[]
    if (!parts.every((part) => part?.type === 'text')) return false
    text = parts.map((part) => String(part.text ?? '')).join('')
  } else {
    return false
  }
  return ROOT_STEP_REMINDERS.has(text.trim())
}
