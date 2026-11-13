/**
 * The review a root agent's own model writes once a turn ends
 * (packages/agent-runtime/src/turn-review.ts): a few one-click next prompts
 * and, when the turn made a change, a verdict on it. It is one request after
 * the same system prompt, tools and history the agent's own requests send, so
 * the provider serves the conversation from its prompt cache. The request and
 * its reply never join the conversation.
 */

import type { WorkspaceMode } from '../desktop-cloud/workspace-mode'

export const TURN_REVIEW_VERDICTS = [
  'ready',
  'needs_changes',
  'not_promising',
] as const
export type TurnReviewVerdict = (typeof TURN_REVIEW_VERDICTS)[number]

/**
 * In the order the pills show. `fix`: improves this change (a cut, a missing
 * piece, a better approach). `review`: the "Code review" pill, asking the
 * agent to review its own change. `next`: work beyond it.
 */
export const TURN_REVIEW_ACTION_KINDS = ['fix', 'review', 'next'] as const
export type TurnReviewActionKind = (typeof TURN_REVIEW_ACTION_KINDS)[number]

export type TurnReviewAction = {
  label: string
  prompt: string
  kind: TurnReviewActionKind
}

export type TurnReview = {
  /** null when the turn made no change to judge. */
  verdict: TurnReviewVerdict | null
  /** Why, in one short line; null without a verdict. */
  reason: string | null
  /** The one message the review recommends sending next, offered in the composer (Tab fills it). */
  nextPrompt: string | null
  actions: TurnReviewAction[]
}

/**
 * The Cloud A/B (docs/experiments.md): `review` turns get the review in place
 * of `suggest_prompts` cards; `control` is the agent as it was. Inert until
 * its `experiment` row is running.
 */
export const TURN_REVIEW_EXPERIMENT_KEY = 'turn_review_2026_11'

/** The run event that carries a review to the workspace. */
export const TURN_REVIEW_EVENT_KIND = 'turn_review'

/** `codebuff_metadata` key that marks a review request. */
export const TURN_REVIEW_METADATA_KEY = 'turn_review'

/**
 * How long a review may take, on every path (the runtime's request, a
 * Claude Code or Codex fork on the user's computer). A review may think as
 * long as it needs: a 4,000-token cap and 90 s limit failed 5.5% of reviews
 * (11-12), mostly a model's reasoning spending the whole budget.
 */
export const TURN_REVIEW_TIMEOUT_MS = 10 * 60_000

export const MAX_TURN_REVIEW_ACTIONS = 5

/** The label of the button a review offers once a turn finishes a feature or fix. */
export const BRAINSTORM_FOLLOW_UPS_LABEL = 'Brainstorm follow-ups'

/** Whether an action is the "Brainstorm follow-ups" button, so analytics can count it apart from other next steps. */
export function isBrainstormAction(action: Pick<TurnReviewAction, 'label'>): boolean {
  return action.label.trim().toLowerCase() === BRAINSTORM_FOLLOW_UPS_LABEL.toLowerCase()
}
const MAX_LABEL_CHARS = 60
const MAX_PROMPT_CHARS = 1_000
const MAX_REASON_CHARS = 160

export const TURN_REVIEW_PROMPT = `Stop working on the task. The turn is over, and the user has not replied yet. Look back at the conversation as a skeptical senior engineer seeing it for the first time, and help the user decide what to do next. The user never sees this message or your reply, only the buttons and the verdict you return. Do not call any tools.

Consider these questions. Not every one makes sense for every turn: for a code change most of them do, for brainstorming or a plan the verdict usually does not, and for a plain question often only the follow-ups do. Skip any that do not fit, and say nothing rather than something weak.
1. Is there an alternative approach that would be clearly better? Usually there is not.
2. If we keep this approach, what could we cut that is not worth its complexity?
3. What else should this change include before it is done?
4. What follow-ups would be most valuable?
5. Is the change on track to merge? "ready": useful and a net positive after the complexity it adds, nothing important left. "needs_changes": a good direction with a few things to fix first. "not_promising": the wrong change, or not worth it. Use null when the turn made no change to judge. The assistant who did the work is biased toward it, so do not rubber-stamp it.

With a verdict, give its "reason": one plain sentence of at most 15 words that a non-expert understands, saying what makes it ready or what is wrong, like "Does what you asked with one small, clean change." or "The retry wrapper isn't needed, and empty input isn't handled." Use null with no verdict.

Turn the answers into at most ${MAX_TURN_REVIEW_ACTIONS} actions, the most valuable first. Each is a button the user can click to send its prompt as their next message:
- "kind": "fix" for anything that improves this change itself (a cut, a missing piece, a better approach), or "next" for a follow-up beyond it. A "needs_changes" or "not_promising" verdict should come with the fixes it names.
- "label": two to five words that say what the button does, like "Cut the retry wrapper" or "Try a single query".
- "prompt": what the user would send, in their voice. It must stand alone, because the agent that receives it never sees this review: name what to change or try and why, in one or two sentences, and leave the how to the agent.
When the turn changed code, include an action of kind "review" labeled "Code review" whose prompt asks the agent to review its own change with fresh eyes: switch to a better alternative where there is one, simplify the code, remove unnecessary cases, and cut anything not needed, for the cleanest, most maintainable result.
When the turn finished a feature or fix, such as merging a pull request or committing the change, include an action of kind "next" labeled "${BRAINSTORM_FOLLOW_UPS_LABEL}" whose prompt asks the agent to use the whole conversation as context and think up the most valuable follow-up ideas, including new ones no one has mentioned yet rather than only restating what was already discussed, each with why it is worth doing, ranked by value, without starting on any of them.
Every action, and "nextPrompt", must be something the user could sensibly send as their very next message, right now. Never offer a step that has to wait on something that has not happened yet, such as a merge, a deploy, a release, a review, or data arriving, like "Re-measure after deploy" while the pull request is still open: no one clicks it now. Offer only what the agent can start on as soon as it is sent.
Do not offer what was already done or declined, or two buttons that do the same thing.

Last, write "nextPrompt": the single message you would recommend the user send next, taking all of the above into account. It is offered in their empty message box, where one key fills it in for them to send. It may combine several instructions, such as the fixes the change needs and one valuable follow-up, but keep it concise: one to three short sentences in the user's voice that stand alone. Use null when nothing is worth sending.

Reply with only this JSON, and no other text:
{"verdict": "ready" | "needs_changes" | "not_promising" | null, "reason": "..." | null, "actions": [{"kind": "fix" | "review" | "next", "label": "...", "prompt": "..."}], "nextPrompt": "..." | null}`

/**
 * A Chat-mode turn's review (docs/freebuff-workspace-modes.md): its user is not
 * a developer and the turn rarely makes a change to judge, so it asks only for
 * follow-up buttons and the next message, with no verdict or fixes.
 */
export const TURN_REVIEW_CHAT_PROMPT = `Stop working on the task. The turn is over, and the user has not replied yet. Look back at the conversation and help the user decide what to ask next. The user never sees this message or your reply, only the buttons you return. Do not call any tools.

Offer at most ${MAX_TURN_REVIEW_ACTIONS} follow-ups, the most valuable first: the natural next questions or requests that build on this conversation and move the user toward what they are trying to get done. Each is a button the user can click to send its prompt as their next message:
- "label": two to five words that say what the button does, like "Make it shorter" or "Compare the two options".
- "prompt": what the user would send, in their voice and their language. It must stand alone in one or two sentences, saying what they want and why.
Do not offer what was already done or declined, or two buttons that do the same thing. Offer nothing rather than something weak; an answer that settles the matter needs no buttons.

Last, write "nextPrompt": the single message you would recommend the user send next. It is offered in their empty message box, where one key fills it in for them to send. Keep it to one or two short sentences in the user's voice that stand alone. Use null when nothing is worth sending.

Reply with only this JSON, and no other text:
{"actions": [{"label": "...", "prompt": "..."}], "nextPrompt": "..." | null}`

/** How many of the user's own recent messages a review reads, and how much of each. */
export const TURN_REVIEW_RECENT_PROMPTS = 25
const RECENT_PROMPT_CHARS = 300

/**
 * The review prompt for a turn's mode (TURN_REVIEW_PROMPT for Code,
 * TURN_REVIEW_CHAT_PROMPT for Chat) with the user's own recent messages from
 * across their chats, newest first, so the buttons and `nextPrompt` read the
 * way this user works: whether they open pull requests or keep changes local,
 * how much they ask for at once, their wording. Without any, the prompt alone.
 */
export function turnReviewPrompt(
  recentPrompts: readonly string[] = [],
  mode: WorkspaceMode = 'code',
): string {
  const prompt = mode === 'chat' ? TURN_REVIEW_CHAT_PROMPT : TURN_REVIEW_PROMPT
  const lines = recentPrompts
    .map((recent) => clip(recent, RECENT_PROMPT_CHARS))
    .filter(Boolean)
    .slice(0, TURN_REVIEW_RECENT_PROMPTS)
  if (!lines.length) return prompt
  const habits = mode === 'chat'
    ? 'how much they ask for at once and their wording'
    : 'whether they open pull requests or keep changes local, how much they ask for at once, and their wording'
  return `${prompt}

For reference, the user's recent messages across their chats, newest first. Match how they work, such as ${habits}, but never copy a request they already made:
${lines.map((line) => `- ${line}`).join('\n')}`
}

function clip(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/** The review in a model's reply, or null when the reply holds none (or an empty one). */
export function parseTurnReview(reply: string): TurnReview | null {
  const read = readTurnReview(reply)
  return read === 'empty' ? null : read
}

/**
 * The review in a model's reply: the first complete JSON object shaped like
 * one (it names `verdict`, `actions` or `nextPrompt`), ignoring prose and
 * other braces around it and anything after it, such as a stray `"}`.
 * `'empty'` is a well-formed review with nothing in it (the model judged there
 * was nothing to suggest); null is a reply that holds no review at all.
 */
export function readTurnReview(reply: string): TurnReview | 'empty' | null {
  const text = reply.replace(/<think>[\s\S]*?<\/think>/g, '')
  for (const candidate of jsonObjects(text)) {
    const review = reviewShaped(candidate)
    if (review !== undefined) return review
  }
  // A model sometimes drops the last string's closing quote ("nextPrompt":"…}).
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return reviewShaped(text.slice(start, end).trimEnd() + '"}') ?? null
}

/** The review in one JSON object's text, `'empty'`, or undefined when it is not one. */
function reviewShaped(json: string): TurnReview | 'empty' | undefined {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (!['verdict', 'actions', 'nextPrompt'].some((key) => key in value)) return undefined
  return turnReviewFrom(value) ?? 'empty'
}

/** At most this many `{` are tried, so a reply full of code costs little. */
const MAX_JSON_STARTS = 200

/**
 * Each balanced `{…}` in the text, outermost first, skipping braces inside
 * JSON strings. An object that fails to parse is followed by the ones inside
 * it, so a CSS block or a broken wrapper never hides the review after it.
 */
function* jsonObjects(text: string): Generator<string> {
  let tried = 0
  for (let start = text.indexOf('{'); start >= 0 && tried < MAX_JSON_STARTS; start = text.indexOf('{', start + 1)) {
    tried++
    let depth = 0
    let inString = false
    for (let i = start; i < text.length; i++) {
      const char = text[i]
      if (inString) {
        if (char === '\\') i++
        else if (char === '"') inString = false
      } else if (char === '"') inString = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) {
        yield text.slice(start, i + 1)
        break
      }
    }
  }
}

/** A review from untrusted JSON (a model's reply, a stored event), or null. */
export function turnReviewFrom(value: unknown): TurnReview | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const verdict = TURN_REVIEW_VERDICTS.includes(raw.verdict as TurnReviewVerdict)
    ? (raw.verdict as TurnReviewVerdict)
    : null
  const actions: TurnReviewAction[] = []
  for (const item of Array.isArray(raw.actions) ? raw.actions : []) {
    const label = clip(item?.label, MAX_LABEL_CHARS)
    const prompt = clip(item?.prompt, MAX_PROMPT_CHARS)
    if (label && prompt)
      actions.push({
        label,
        prompt,
        kind: TURN_REVIEW_ACTION_KINDS.includes(item?.kind) ? item.kind : 'next',
      })
    if (actions.length === MAX_TURN_REVIEW_ACTIONS) break
  }
  const nextPrompt = clip(raw.nextPrompt, MAX_PROMPT_CHARS) || null
  if (!verdict && !actions.length && !nextPrompt) return null
  const reason = (verdict && clip(raw.reason, MAX_REASON_CHARS)) || null
  return { verdict, reason, actions, nextPrompt }
}
