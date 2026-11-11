/**
 * The review a root agent's own model writes once a turn ends
 * (packages/agent-runtime/src/turn-review.ts): a few one-click next prompts
 * and, when the turn made a change, a verdict on it. It is one request after
 * the same system prompt, tools and history the agent's own requests send, so
 * the provider serves the conversation from its prompt cache. The request and
 * its reply never join the conversation.
 */

export const TURN_REVIEW_VERDICTS = [
  'ready',
  'needs_changes',
  'not_promising',
] as const
export type TurnReviewVerdict = (typeof TURN_REVIEW_VERDICTS)[number]

/** `fix`: improves this change (a cut, a missing piece, a better approach). `next`: work beyond it. */
export type TurnReviewActionKind = 'fix' | 'next'

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

export const MAX_TURN_REVIEW_ACTIONS = 5
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
Do not offer what was already done or declined, or two buttons that do the same thing.

Reply with only this JSON, and no other text:
{"verdict": "ready" | "needs_changes" | "not_promising" | null, "reason": "..." | null, "actions": [{"kind": "fix" | "next", "label": "...", "prompt": "..."}]}`

function clip(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/** The review in a model's reply, or null when the reply holds none. */
export function parseTurnReview(reply: string): TurnReview | null {
  const text = reply.replace(/<think>[\s\S]*?<\/think>/g, '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return turnReviewFrom(JSON.parse(text.slice(start, end + 1)))
  } catch {
    return null
  }
}

/** A review from untrusted JSON (a model's reply, a stored event), or null. */
export function turnReviewFrom(value: unknown): TurnReview | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as { verdict?: unknown; reason?: unknown; actions?: unknown }
  const verdict = TURN_REVIEW_VERDICTS.includes(raw.verdict as TurnReviewVerdict)
    ? (raw.verdict as TurnReviewVerdict)
    : null
  const actions: TurnReviewAction[] = []
  for (const item of Array.isArray(raw.actions) ? raw.actions : []) {
    const label = clip(item?.label, MAX_LABEL_CHARS)
    const prompt = clip(item?.prompt, MAX_PROMPT_CHARS)
    if (label && prompt)
      actions.push({ label, prompt, kind: item?.kind === 'fix' ? 'fix' : 'next' })
    if (actions.length === MAX_TURN_REVIEW_ACTIONS) break
  }
  if (!verdict && !actions.length) return null
  const reason = (verdict && clip(raw.reason, MAX_REASON_CHARS)) || null
  return { verdict, reason, actions }
}
