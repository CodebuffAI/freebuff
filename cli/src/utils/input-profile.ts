/**
 * Counts of how the chat composer's text arrived, per submitted prompt, sent
 * in `codebuff_metadata` on the run that prompt starts.
 *
 * Counts and durations only — never the text itself:
 *
 *   tc  characters inserted by key events
 *   ke  key events that inserted text
 *   mc  key events that inserted more than one character at once
 *   pc  characters received as bracketed pastes
 *   pe  bracketed paste events
 *   ms  first input to submit, in milliseconds (absent when nothing was input)
 *   cps most characters inserted by key events within any one-second window
 *
 * The composer reports each insertion; submitting seals the counts under the
 * submitted text and starts a fresh count, and the run that sends that text
 * takes them.
 */
import { FREEBUFF_CLIENT_DESCRIPTOR_VERSION } from '@codebuff/common/constants/freebuff-client-descriptor'

export type InputProfile = {
  typedChars: number
  keypressEvents: number
  multiCharKeypressEvents: number
  pastedChars: number
  pasteEvents: number
  composeMs: number | null
  maxTypedCharsPerSecond: number
}

const WINDOW_MS = 1_000
const MAX_COUNT = 10_000_000
const MAX_SEALED = 8

const cap = (n: number) => Math.min(MAX_COUNT, Math.max(0, Math.floor(n)))

export class InputProfileCounter {
  private typedChars = 0
  private keypressEvents = 0
  private multiCharKeypressEvents = 0
  private pastedChars = 0
  private pasteEvents = 0
  private firstInputAt: number | null = null
  private maxWindowChars = 0
  // Sliding one-second window of typed insertions.
  private windowTimes: number[] = []
  private windowSizes: number[] = []
  private windowHead = 0
  private windowChars = 0

  recordTyped(text: string, now: number): void {
    const n = text.length
    if (n <= 0) return
    this.firstInputAt ??= now
    this.typedChars += n
    this.keypressEvents += 1
    if (n > 1) this.multiCharKeypressEvents += 1

    this.windowTimes.push(now)
    this.windowSizes.push(n)
    this.windowChars += n
    while (
      this.windowHead < this.windowTimes.length &&
      now - this.windowTimes[this.windowHead]! >= WINDOW_MS
    ) {
      this.windowChars -= this.windowSizes[this.windowHead]!
      this.windowHead += 1
    }
    // Compact occasionally so the arrays stay bounded by one window.
    if (this.windowHead > 1024) {
      this.windowTimes = this.windowTimes.slice(this.windowHead)
      this.windowSizes = this.windowSizes.slice(this.windowHead)
      this.windowHead = 0
    }
    if (this.windowChars > this.maxWindowChars) {
      this.maxWindowChars = this.windowChars
    }
  }

  recordPaste(length: number, now: number): void {
    this.firstInputAt ??= now
    this.pasteEvents += 1
    this.pastedChars += Math.max(0, length)
  }

  snapshot(now: number): InputProfile {
    return {
      typedChars: cap(this.typedChars),
      keypressEvents: cap(this.keypressEvents),
      multiCharKeypressEvents: cap(this.multiCharKeypressEvents),
      pastedChars: cap(this.pastedChars),
      pasteEvents: cap(this.pasteEvents),
      composeMs:
        this.firstInputAt === null ? null : cap(now - this.firstInputAt),
      maxTypedCharsPerSecond: cap(this.maxWindowChars),
    }
  }
}

export function encodeInputProfile(profile: InputProfile): string {
  const fields: Array<[string, number | null]> = [
    ['tc', profile.typedChars],
    ['ke', profile.keypressEvents],
    ['mc', profile.multiCharKeypressEvents],
    ['pc', profile.pastedChars],
    ['pe', profile.pasteEvents],
    ['ms', profile.composeMs],
    ['cps', profile.maxTypedCharsPerSecond],
  ]
  return [
    FREEBUFF_CLIENT_DESCRIPTOR_VERSION,
    ...fields.flatMap(([k, v]) => (v === null ? [] : [`${k}=${v}`])),
  ].join(';')
}

let current = new InputProfileCounter()
/** Sealed profiles keyed by the trimmed submitted text, oldest first. */
const sealed = new Map<string, InputProfile>()

/** The composer inserted `text` from a key event. Never throws. */
export function recordTypedInput(text: string, now: number = Date.now()): void {
  try {
    current.recordTyped(text, now)
  } catch {
    // counting must never affect input
  }
}

/** The composer received a bracketed paste. Never throws. */
export function recordPastedInput(
  text: string | undefined,
  now: number = Date.now(),
): void {
  try {
    current.recordPaste(text?.length ?? 0, now)
  } catch {
    // counting must never affect input
  }
}

/** Wrap the composer's paste handler so each paste is counted first. */
export function withPasteCount(
  handler: (eventText?: string) => void,
): (eventText?: string) => void {
  return (eventText) => {
    recordPastedInput(eventText)
    handler(eventText)
  }
}

/**
 * The composer submitted `text`: keep its counts for the run that sends it and
 * start counting the next prompt from zero.
 */
export function sealInputProfile(text: string, now: number = Date.now()): void {
  try {
    const key = text.trim()
    const profile = current.snapshot(now)
    current = new InputProfileCounter()
    if (!key) return
    sealed.delete(key)
    sealed.set(key, profile)
    while (sealed.size > MAX_SEALED) {
      const oldest = sealed.keys().next().value
      if (oldest === undefined) break
      sealed.delete(oldest)
    }
  } catch {
    current = new InputProfileCounter()
  }
}

/** The encoded counts sealed for `text`, removed on read. Absent when the
 *  prompt did not come from the composer (a suggestion, a command, a retry). */
export function takeInputProfile(text: string): string | undefined {
  const key = text.trim()
  const profile = sealed.get(key)
  if (!profile) return undefined
  sealed.delete(key)
  return encodeInputProfile(profile)
}

/** Test-only. */
export function resetInputProfileForTest(): void {
  current = new InputProfileCounter()
  sealed.clear()
}
