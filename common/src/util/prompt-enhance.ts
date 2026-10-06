/**
 * Shared pieces of "turn a terse draft into a specific, well-structured
 * prompt" (the sparkle button on every composer): the prompts every surface
 * sends, the input cap, and the sanitizer that turns raw model output into
 * draft text.
 *
 * Kept dependency-free so the desktop server, the desktop renderer and the web
 * API can all import it. Freebuff Web and Cloud have their own, project-aware
 * refinement in Convex (`coding_agent/helpers/refinePromptContext.ts`); this
 * is the context-free rewrite Desktop uses.
 */

/** Long pastes are not what the enhancer is for; cap the input so the call
 *  stays cheap and fast. */
export const PROMPT_ENHANCE_INPUT_MAX_CHARS = 10_000

export const PROMPT_ENHANCE_SYSTEM_PROMPT =
  "You are a prompt enhancer for a coding agent. You rewrite the user's draft into a clear, specific instruction the agent can act on. You output only the rewritten prompt."

export const PROMPT_ENHANCE_INSTRUCTIONS_PROMPT = `Rewrite the draft so a coding agent can act on it without guessing.

Rules:
- Keep the user's intent, and their wording where it is already clear. Fix typos and awkward phrasing.
- Make it specific: say what to change, what "done" looks like, and the constraints a careful engineer would state (keep existing behaviour, avoid new dependencies, which checks to run).
- Keep it short. One short description, then a numbered list of 2-5 steps when the task has parts. Do not add work the user did not ask for.
- Plain text only: no markdown headings, no bold, no code fence around the answer, no preamble or explanation.
- Write in the same language as the draft.
- If the draft is already specific, return it with only light cleanup.
- Never invent file paths, names or facts you cannot know; say "the relevant file" instead.

Output only the rewritten prompt.`

/**
 * Drops the wrapper a model sometimes adds despite the instructions and
 * returns null when nothing usable is left, so the caller keeps the draft it
 * already has.
 */
export function sanitizeEnhancedPrompt(raw: string): string | null {
  let text = raw.trim()
  // the whole answer in one code fence
  const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(text)
  if (fenced) text = fenced[1].trim()
  // a label the model sometimes prepends
  text = text
    .replace(/^(enhanced|refined|rewritten|improved)\s+prompt:\s*/i, '')
    .trim()
  return text.length > 0 ? text : null
}
