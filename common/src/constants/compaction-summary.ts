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

/**
 * Which summary a root asks for (`compactContext.summary`). The default is a
 * coding task's: one objective, its work state, its files. `personal` is for a
 * conversation that is not one task but an ongoing thread with one person
 * (a personal assistant's): many small subjects over days, where what must
 * survive is the person, what they asked of the agent, and what is still open.
 */
export type CompactionSummaryStyle = 'personal'

/** The first heading of each format: where a summary starts in a model's reply. */
export const COMPACTION_SUMMARY_FIRST_HEADING = '## Objective'
export const PERSONAL_SUMMARY_FIRST_HEADING = '## Standing Requests'

/**
 * The `personal` summary. It follows what the personal assistants that keep
 * one thread per person carry between turns: a small profile, the open items,
 * and a recap of what was said, with the newest turns kept word for word
 * beside it by the runtime (conversation-summary.ts, `personalTailTokens`).
 * Days are written as dates so "yesterday" still means something a week on.
 */
function buildPersonalSummaryPrompt(targetTokens: number): string {
  return `${COMPACTION_SUMMARY_PROMPT_OPENING}
The summary replaces the older part of this conversation. You continue the conversation from it yourself, with the same instructions and tools, so it must hold what you need to stay the same assistant to this person: what they asked of you, what is still open, and what you would be embarrassed to have forgotten.

This conversation is one ongoing thread with one person, about many things over time. It is not one task. Summarize what the two of you said and what you did for them. Do not restate your system instructions. If the conversation starts with an earlier summary, merge it into this one, section by section: newer messages take precedence, and nothing still true or still open is dropped because it is old.

Use exactly this format. Write "(none)" for an empty section.

${PERSONAL_SUMMARY_FIRST_HEADING}
- [what they asked you to always or never do, and how they want to be addressed and answered; their exact words, with the date when known]

## About Them
- [lasting things they told you or that you learned for certain: their name, the people, places, work and tastes in their life, the accounts and apps they use; exact values]

## How They Text
- [the language they write in, how long, how formal, capitals, punctuation, emoji, slang: enough to keep matching them]

## Open Threads
- [each thing still in motion: what they want, where it stands, what happens next, and who is waiting on whom]

## Handed Off
- [each chat or project you started or messaged for them: its title and id, what kind it is, what you asked it for, and whether it is still running or how it ended; and whether you are watching it]

## Scheduled
- [each reminder, schedule or watcher you set, with its id and when it fires; and anything you said you would do or tell them later]

## Timeline
- [YYYY-MM-DD: what they asked for that day and how it ended, a line per subject, oldest first]

## Details
- [exact things you could not easily find again: addresses, names, numbers, amounts, dates, links, ids, the paths of files and folders you made, the ids and titles of documents you made]

## Latest Exchange
- [their latest message, and what you last answered or did]

Rules:
- Use short single-line bullets, not paragraphs.
- Write dates as YYYY-MM-DD, taken from the times given in the conversation. Never write "today", "yesterday" or "last week".
- Keep their exact wording for requests and preferences. Keep exact names, numbers, ids, links and paths.
- Say only what the conversation shows. Record something as sent, ordered, saved, started or finished only if it succeeded; otherwise record where it stopped.
- A thread that ended goes to the Timeline as one line and leaves Open Threads. When the Timeline grows long, merge its oldest days into one line per week, then per month.
- Leave out how you did things (tool calls, searches, retries) unless the next step depends on it.
- Name each image or file they sent or you showed, by name, with what it was. You cannot see it again without opening it.
- Keep every heading exactly as written here, in English. Write the text under the headings in the language they write in.
- Keep the summary under about ${targetTokens} tokens.
- Do not call tools. Do not continue the conversation. Return only the summary, with no preamble.`
}

export function buildCompactionSummaryPrompt(
  targetTokens: number,
  style?: CompactionSummaryStyle,
): string {
  if (style === 'personal') return buildPersonalSummaryPrompt(targetTokens)
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
- [finished items relevant to the objective, including from earlier summaries. Name each outcome and any check that confirmed it]
### Active
- [for each unfinished item, say what has already changed and what remains to do or verify]
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
- Name each image the user attached or a tool showed, by file name when it has one, with what it showed. The next agent cannot see any of them and must open the file again to look.
- Keep every heading exactly as written here, in English. Write the text under the headings in the language the user writes in.
- Keep the summary under about ${targetTokens} tokens.
- Do not call tools. Do not continue the task. Return only the summary, with no preamble.`
}
