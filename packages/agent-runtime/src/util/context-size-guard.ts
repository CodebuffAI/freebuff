import { contextPrunerBudgetForModel } from '@codebuff/common/constants/model-config'

import { fitToolResults } from './fit-tool-results'
import { countTokensMessages } from './token-counter'

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

/** New input is not covered by the previous receipt. Refuse oversized user
 * content explicitly rather than silently changing a user's instructions. */
export function assertUserContentSize(
  messages: Message[],
  template: ContextPolicy,
): void {
  if (
    countTokensMessages(messages) > Math.min(128_000, contextBudget(template))
  ) {
    throw new Error(
      'The new message is too large. Send a smaller excerpt or attach a file instead.',
    )
  }
}

/** A tool already ran. Bound what enters context (including nested JSON), with
 * the existing omission/re-read notices, without repeating its side effects. */
export function boundToolResult(
  result: ToolMessage,
  template: ContextPolicy,
): ToolMessage {
  return fitToolResults(
    [result],
    Math.min(64_000, Math.floor(contextBudget(template) / 4)),
  )[0] as ToolMessage
}
