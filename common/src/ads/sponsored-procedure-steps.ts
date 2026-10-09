/**
 * THE step list of a sponsored (agentic-ad) procedure, and THE way a step
 * count is read and printed. The run card's step tracker, the funnel and the
 * agentic run grader all count steps through this module, so "3/8" means the
 * same thing on the card, the agentic-runs page and in a grade row (COD-832).
 *
 * A procedure's steps are its top-level numbered items ("1. …", "2) …"). A
 * procedure written as prose has no parsed steps (`[]`): callers then fall
 * back to their own count (the grader asks the model), never to a guess here.
 *
 * `needsUser` marks a step only a human can do: a browser login or approval,
 * an account sign-up, an API key or secret to paste, OAuth consent, payment,
 * an email confirmation. A run may leave those for the user and still be
 * `perfect`; it may not leave any other step undone. The match is a keyword
 * heuristic over the advertiser's own wording, so the grader also lets the
 * model name human-only steps it reads from the run.
 */

export type SponsoredProcedureStep = {
  /** 1-based, as the procedure numbers it (renumbered when the source skips). */
  number: number
  text: string
  needsUser: boolean
}

/** A top-level numbered item: "1. Install", "2) Run", "3 - Write". */
const NUMBERED_STEP = /^(\d{1,2})\s*(?:[.)]|\s-)\s+(\S.*)$/

/**
 * Phrasings of a HUMAN doing something, not of code about it: "log in to X"
 * is the user's, "add a /login route" is the agent's. A false match lets a
 * run skip a step and still be `perfect`, so these stay narrow; the model
 * names the human-only steps these miss.
 */
const NEEDS_USER_PATTERNS: readonly RegExp[] = [
  /\b(?:log|sign) ?in (?:to|on|at)\b/i,
  /\bsign ?up (?:for|at|on|with)\b|\bcreate (?:an? |your )?(?:\w+ )?account (?:on|at|with)\b/i,
  /\bin (?:the|a|your) browser\b|\bopens? (?:a|the) browser\b/i,
  /\boauth consent\b/i,
  /\benter (?:a |your )?(?:payment|credit card|billing)\b/i,
  /\b(?:confirm|verify) your email\b|\bconfirmation (?:email|link)\b/i,
  /\bask (?:the )?user\b/i,
  /\bthe user (?:must|should|needs to|will|can|completes?|approves?|enters?|pastes?|signs?|logs?)\b/i,
]

/** Whether a step's own wording says only a human can do it. */
export function sponsoredStepNeedsUser(text: string): boolean {
  return NEEDS_USER_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * The procedure's numbered steps, in order. Only items at the shallowest
 * numbered indent count, so a nested "1." under a step is part of that step.
 * A list that restarts at 1 (a second numbered list) ends the first.
 */
export function parseSponsoredProcedureSteps(
  procedure: string | null | undefined,
): SponsoredProcedureStep[] {
  if (!procedure) return []
  const lines = procedure.replace(/\r\n?/g, '\n').split('\n')
  const items: Array<{ indent: number; number: number; text: string }> = []
  for (const line of lines) {
    const indent = line.length - line.trimStart().length
    const match = NUMBERED_STEP.exec(line.trim())
    if (match) {
      items.push({ indent, number: Number(match[1]), text: match[2]!.trim() })
    } else if (items.length && line.trim() && indent > items.at(-1)!.indent) {
      // A wrapped or nested line belongs to the step above it.
      items.at(-1)!.text += ` ${line.trim()}`
    }
  }
  if (!items.length) return []
  const top = Math.min(...items.map((item) => item.indent))
  const steps: SponsoredProcedureStep[] = []
  for (const item of items) {
    if (item.indent !== top) {
      if (steps.length) steps.at(-1)!.text += ` ${item.text}`
      continue
    }
    if (steps.length && item.number === 1) break
    const text = item.text.replace(/\s+/g, ' ')
    steps.push({
      number: steps.length + 1,
      text,
      needsUser: sponsoredStepNeedsUser(text),
    })
  }
  return steps
}

/** How many of `steps` are done, by the card's per-step state. */
export function sponsoredDoneStepCount(
  steps: ReadonlyArray<{ state: string }> | null | undefined,
): number {
  return (steps ?? []).filter((step) => step.state === 'done').length
}

/**
 * The one way an N/M step count is printed: "3/8". Null when the total is
 * unknown, so a surface shows nothing rather than a made-up denominator.
 */
export function formatSponsoredStepCount(
  completed: number | null | undefined,
  total: number | null | undefined,
): string | null {
  if (total === null || total === undefined || total <= 0) return null
  const done = Math.max(0, Math.min(completed ?? 0, total))
  return `${done}/${total}`
}
