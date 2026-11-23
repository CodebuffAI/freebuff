/** Number blank projects after the highest existing Untitled name. */
export function nextUntitledProjectName(
  existingNames: Iterable<string | null | undefined>,
): string {
  let highest = 0
  for (const name of existingNames) {
    const match = name?.trim().match(/^untitled(?: ([1-9]\d*))?$/i)
    if (!match) continue
    const number = match[1] ? Number(match[1]) : 1
    if (Number.isSafeInteger(number) && number < Number.MAX_SAFE_INTEGER)
      highest = Math.max(highest, number)
  }
  return highest === 0 ? 'Untitled' : `Untitled ${highest + 1}`
}

/** "Untitled", "Untitled 2": a name nobody chose. */
export function isUntitledProjectName(name: string | null | undefined): boolean {
  return /^untitled(?: [1-9]\d*)?$/i.test(name?.trim() ?? '')
}

const LEAD_INS = [
  /^(?:hi|hey|hello)\b[,!.]?\s*/i,
  /^(?:please|pls)\s+/i,
  /^(?:can|could|would|will) you\s+(?:please\s+)?/i,
  /^i(?:'d| would)? (?:like|want|need)(?: you)? to\s+/i,
  /^(?:help me|let's|lets)\s+/i,
  /^(?:build|make|create|write|code|design|develop|generate|set up|start|add|implement|draft)\s+(?:me\s+|us\s+)?/i,
  /^(?:a|an|the|my|our|some|simple|quick|basic|new)\s+/i,
]
/** Words that end what is being built ("a snake game THAT…"). */
const STOP_WORDS = new Set([
  'that', 'which', 'where', 'who', 'with', 'for', 'using', 'in', 'on', 'to', 'so', 'i', 'we', 'you',
  'and', 'from', 'like', 'by', 'about', 'when', 'it', 'please',
])
const SMALL_WORDS = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'to', 'in', 'on', 'for'])

/**
 * A project's name from the message that started it, so no project is left
 * "Untitled": what is being built, title-cased ("Make a classic Snake game I
 * can play" → "Classic Snake Game"). Null when the message has no words.
 */
export function projectNameFromPrompt(prompt: string): string | null {
  let text = prompt.split(/[\n.!?]/).find((line) => line.trim())?.trim() ?? ''
  for (let changed = true; changed; ) {
    changed = false
    for (const lead of LEAD_INS) {
      const next = text.replace(lead, '')
      if (next !== text && next.trim()) {
        text = next.trim()
        changed = true
      }
    }
  }
  const words: string[] = []
  for (const raw of text.split(/\s+/)) {
    const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'-]+$/gu, '')
    if (!word) continue
    if (words.length && STOP_WORDS.has(word.toLowerCase())) break
    words.push(word)
    if (words.length === 4) break
  }
  if (!words.length) return null
  const name = words
    .map((word, index) =>
      index > 0 && SMALL_WORDS.has(word.toLowerCase())
        ? word.toLowerCase()
        : /[A-Z]/.test(word.slice(1))
          ? word
          : word[0]!.toUpperCase() + word.slice(1),
    )
    .join(' ')
  return name.length > 40 ? name.slice(0, 40).trimEnd() : name
}
