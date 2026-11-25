import { contextPrunerBudgetForModel } from '@codebuff/common/constants/model-config'

import { fitToolResults } from './fit-tool-results'
import { countTokensMessages } from './token-counter'

import { sanitizeToolOutputValue } from './sanitize-tool-output'

import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type {
  Message,
  ToolMessage,
} from '@codebuff/common/types/messages/codebuff-message'

type ContextPolicy = Pick<AgentTemplate, 'model' | 'compactContext'>

function contextBudget(template: ContextPolicy): number {
  return (
    (typeof template.compactContext === 'object'
      ? template.compactContext.maxContextLength
      : undefined) ?? contextPrunerBudgetForModel(template.model)
  )
}

/** The most new user content may hold, in estimated tokens, unless the
 * model's context budget is smaller. */
export const MAX_USER_CONTENT_TOKENS = 128_000

/** `refused` is the content, which is never kept in history. */
export class UserContentTooLargeError extends Error {
  constructor(readonly refused: Message[]) {
    super(
      'The new message is too large. Send a smaller excerpt or attach a file instead.',
    )
  }
}

/** New input is not covered by the previous receipt. Refuse oversized user
 * content explicitly rather than silently changing a user's instructions. */
export function assertUserContentSize(
  messages: Message[],
  template: ContextPolicy,
): void {
  if (
    countTokensMessages(messages) >
    Math.min(MAX_USER_CONTENT_TOKENS, contextBudget(template))
  ) {
    throw new UserContentTooLargeError(messages)
  }
}

/** A tool already ran. Bound what enters context (including nested JSON), with
 * the existing omission/re-read notices, without repeating its side effects. */
export function boundToolResult(
  result: ToolMessage,
  template: ContextPolicy,
): ToolMessage {
  // Defensive Strategy 4a: strip common prompt-injection delimiter tags from
  // tool output before it enters the model's context. Operate on a clone so
  // the original result (and any UI/trace consumer) is untouched.
  const sanitized: ToolMessage = {
    ...result,
    content: result.content.map((part) => {
      if (part.type === 'json') {
        return { ...part, value: sanitizeToolOutputValue(part.value) as any }
      }
      return part
    }),
  }
  return fitToolResults(
    [sanitized],
    Math.min(64_000, Math.floor(contextBudget(template) / 4)),
  )[0] as ToolMessage
}
