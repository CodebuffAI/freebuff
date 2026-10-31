/**
 * The instruction a root agent appends to its own history to ask its model
 * for a structured summary of the conversation (packages/agent-runtime/src/
 * conversation-summary.ts). It is the request's last message, after the same
 * system prompt, tools and history the agent's own requests send, so the
 * provider serves the history from its prompt cache.
 *
 * The section format follows Factory's anchored iterative summary
 * (https://factory.com/news/evaluating-compression) as OpenCode words it.
 */
export const COMPACTION_SUMMARY_PROMPT_OPENING =
  'Stop working on the task. Write a structured summary of this whole conversation.'

/** `codebuff_metadata` key that marks a summary request. */
export const COMPACTION_SUMMARY_METADATA_KEY = 'compaction_summary'

export function buildCompactionSummaryPrompt(targetTokens: number): string {
  return `${COMPACTION_SUMMARY_PROMPT_OPENING}
The summary replaces the conversation history. Another agent continues the work from it, with the same system prompt and tools, so it must be able to continue without the original messages.

Summarize what the user and the assistant said and did. Do not restate the system prompt, repository instructions or environment details: the next agent gets them separately. If the conversation starts with an earlier summary, merge it into this one. Newer messages take precedence over it.

Use exactly this format. Write "(none)" for an empty section.

## Objective
- [one or two sentences: what the user wants to accomplish]

## Requirements
- [constraints, preferences and scope limits the user stated; keep their exact wording when it matters]

## Decisions
- [decisions made and why]

## Work State
### Completed
- [finished goals]
### Active
- [goals in progress, and how far they got]
### Blocked
- [what blocks progress, and why]

## Next Move
1. [the next actions, in order]

## Relevant Files
- \`path\`: [why it matters, what changed in it]

## Important Context
- [facts the next agent cannot easily find again: exact commands, error messages, values, identifiers, URLs, and test or build results]

## Latest Exchange
- [the user's latest message, and what the assistant last did or answered]

Rules:
- Use short single-line bullets, not paragraphs.
- Prefer short references over restating details. Leave out what the next agent can get again from the code or files.
- Keep exact file paths, symbols, commands, error text and identifiers.
- Keep user requests that are still open, with their exact wording. Drop the ones newer messages resolved.
- Keep the state of changes: uncommitted, committed, pushed, in review or merged.
- Keep every heading exactly as written here, in English. Write the text under the headings in the language the user writes in.
- Keep the summary under about ${targetTokens} tokens.
- Do not call tools. Do not continue the task. Return only the summary, with no preamble.`
}
