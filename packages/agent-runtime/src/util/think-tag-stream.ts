/**
 * Split a model's *content* stream into visible text and reasoning, for the
 * models that put their reasoning in `content` instead of `reasoning_content`.
 *
 * WHY THIS EXISTS. Reasoning reaches a client on exactly one path: a
 * `reasoning_delta` chunk, which every surface renders in its own thinking
 * box. That chunk is produced only from a provider's native reasoning field
 * (`reasoning_content` / `reasoning` / Responses-API summaries — see
 * openai-compatible-chat-language-model.ts). Nothing downstream ever inspects
 * `content`, so when a lane serves a thinking model WITHOUT populating the
 * native field, the whole chain of thought arrives as ordinary text and is
 * rendered as prose — usually with a bare `</think>` sitting in the middle of
 * it, because the chat template opened the block for the model and only the
 * close is generated. That is the "thinking escapes the thinking box" report.
 *
 * The leak is a property of the LANE, not the model: the DeepSeek direct lane
 * maps `reasoning_content` correctly, while the resold openai-compatible lanes
 * behind the same model id may not. So this cannot be a per-model catalog flag;
 * it has to be recognised from what actually arrives.
 *
 * THREE SHAPES, THREE RULES.
 *
 *  1. `<think>…</think>` — paired tags. Content between them is reasoning.
 *     Unambiguous, free, always on.
 *  2. A bare `<think>` that never closes. At the head of the step it is a
 *     thought and streams live as reasoning. If the model then ENDS the step
 *     itself with the block still open, what it wrote there was its answer,
 *     and flush re-emits it as text (see {@link ThinkStreamFlushOptions}).
 *     Only a step that was cut off (output limit, abort, interrupted stream)
 *     leaves it as a truncated thought. After visible text, `<think>` is far
 *     more often prose, such as a doc or template quoting the tag. So that
 *     block is held and becomes reasoning only if its close arrives, and is
 *     otherwise released verbatim as text. Before CodebuffAI/freebuff#1155 an
 *     open tag anywhere sent the rest of the step to the thinking box, and the
 *     user saw an empty or cut-short reply.
 *  3. An orphan `</think>` with no open tag — the DeepSeek shape above, where
 *     the open tag was consumed by the chat template's prefill. The text
 *     BEFORE it is reasoning, but by the time the marker arrives that text has
 *     already streamed. Handled by {@link ThinkTagStreamOptions.implicitOpen},
 *     which is armed only once this conversation has PROVEN the lane leaks
 *     (see {@link historyLeaksThinkTags}) and holds the head of the step back
 *     until the marker settles it. When the marker never comes the head is
 *     released as text, so an answer is delayed but never swallowed.
 *
 * With `implicitOpen` off — the default, and every step of every model that
 * does not leak — rule 3 degrades to stripping the marker: the prose before it
 * still renders as prose, but a literal `</think>` never reaches a transcript.
 */

const OPEN_TAG = '<think>'
const CLOSE_TAG = '</think>'

export type ThinkStreamSegment = {
  type: 'text' | 'reasoning'
  text: string
}

export interface ThinkTagStreamOptions {
  /**
   * Treat the stream as already inside a think block, so a first orphan
   * `</think>` closes it and everything before it is reasoning.
   *
   * Provisional, not a promise: while it holds, content is BUFFERED rather
   * than emitted, because the decision it is waiting on cannot be unmade once
   * a chunk has been sent. {@link ThinkTagStream.disarmImplicitOpen} and
   * {@link IMPLICIT_OPEN_BUDGET_CHARS} both give up on it and release the
   * buffer as text.
   */
  implicitOpen?: boolean
}

/**
 * How much leading content to hold while waiting for an orphan `</think>`.
 *
 * A leaked chain of thought runs well past this, so the cap is not there to
 * fit one — it bounds the wrong case. If the marker has not arrived by here
 * the step is answering, not thinking, and the buffer is released as text.
 */
export const IMPLICIT_OPEN_BUDGET_CHARS = 4000

/**
 * How much content to hold after a `<think>` that follows visible text, while
 * waiting for its close.
 *
 * Small on purpose: the user is watching an answer stream, and every held
 * character is a stall. No lane is known to open a thought mid-answer, so past
 * this the tag was prose and the hold is released as text.
 */
export const MID_PROSE_THINK_BUDGET_CHARS = 1000

export interface ThinkStreamFlushOptions {
  /**
   * The model ended the step itself: it finished with a reason other than the
   * output limit, and the stream was neither aborted nor interrupted.
   *
   * Only then is a head `<think>` that never closed re-emitted as text. A step
   * that was cut off leaves it as reasoning, because there the open block
   * really is a thought that ran out of room.
   */
  stepCompleted?: boolean
}

/**
 * Remove think scaffolding from a fragment, leaving everything else — including
 * surrounding whitespace — exactly as it was.
 *
 * Distinct from `stripThinkTags`, which trims: that one answers "is this whole
 * response nothing but scaffolding", while this one rewrites text that is still
 * going to be displayed.
 */
export function stripThinkScaffolding(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/g, '')
    .split(CLOSE_TAG)
    .join('')
}

/** Longest suffix of `text` that is a proper prefix of either tag — the part
 *  that must be held back because the next chunk may complete it. `"…done<"`
 *  and `"…done</thi"` are both a tag arriving one delta at a time. */
function partialTagSuffixLength(text: string): number {
  const max = Math.min(text.length, CLOSE_TAG.length - 1)
  for (let len = max; len > 0; len--) {
    const suffix = text.slice(text.length - len)
    if (OPEN_TAG.startsWith(suffix) || CLOSE_TAG.startsWith(suffix)) {
      return len
    }
  }
  return 0
}

/**
 * True when an assistant turn in this history leaked a think marker into its
 * visible content — an orphan `</think>` left over after every properly paired
 * block is removed.
 *
 * This is the arming signal for `implicitOpen`. It reads the history rather
 * than a model id on purpose: the same model id leaks or does not depending on
 * which lane served it, and the history is the only place that answers for the
 * lane actually in use. It is also why the leak is left INTACT in the message
 * history while being stripped from the display stream — the evidence has to
 * survive for the next step to find it.
 */
export function historyLeaksThinkTags(
  messages: readonly { role: string; content: unknown }[],
): boolean {
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      continue
    }
    for (const part of message.content) {
      if (
        !part ||
        typeof part !== 'object' ||
        (part as { type?: unknown }).type !== 'text'
      ) {
        continue
      }
      const text = (part as { text?: unknown }).text
      if (typeof text !== 'string' || !text.includes(CLOSE_TAG)) continue
      // Only the HEAD of the message counts. A leaked chain of thought is what
      // the step opens with, so its close lands inside the same window the
      // speculation is willing to hold; a `</think>` further in is someone
      // quoting one — a bug report about this very problem, a diff, a doc — and
      // must not arm the next step against a model that never leaked.
      const head = text.slice(0, IMPLICIT_OPEN_BUDGET_CHARS + CLOSE_TAG.length)
      if (!head.includes(CLOSE_TAG)) continue
      if (head.replace(/<think>[\s\S]*?<\/think>/g, '').includes(CLOSE_TAG)) {
        return true
      }
    }
  }
  return false
}

/**
 * Incremental classifier over one step's content stream.
 *
 * Feed it every text delta; it returns the segments that are safe to emit now.
 * Adjacent segments of the same type are merged so a caller sends one event per
 * delta in the common case. Call {@link flush} once the step's text is done.
 */
export class ThinkTagStream {
  /** Trailing bytes withheld because they may be the start of a tag. */
  private partial = ''
  /** Leading content withheld while `implicitOpen` is still undecided. */
  private held = ''
  private implicitOpen: boolean
  private inThinkBlock: boolean
  /**
   * Which explicit `<think>` opened the current block: one at the head of the
   * step (streamed as reasoning), or one after visible text (held until its
   * close proves it). Null outside a block and inside an implicit one.
   */
  private explicitBlock: 'head' | 'midProse' | null = null
  /** Copy of the open head block's reasoning, re-emitted as text if the model
   *  ends the step without closing it. */
  private headThought = ''
  /** Raw content after a mid-prose `<think>`, not yet emitted as anything. */
  private midProse = ''
  /** Whether non-whitespace text has been emitted in this step. */
  private sawText = false

  constructor(options: ThinkTagStreamOptions = {}) {
    this.implicitOpen = options.implicitOpen ?? false
    this.inThinkBlock = this.implicitOpen
  }

  /**
   * Give up on `implicitOpen` and release anything held as text.
   *
   * Called when the step turns out not to be leaking after all. The strongest
   * such signal is a native reasoning chunk: a lane that populates
   * `reasoning_content` is by definition not putting the thought in `content`,
   * so whatever is in `content` is the answer.
   */
  disarmImplicitOpen(): ThinkStreamSegment[] {
    if (!this.implicitOpen) return []
    return this.abandonImplicitOpen()
  }

  push(chunk: string): ThinkStreamSegment[] {
    if (!chunk) return []
    const segments: ThinkStreamSegment[] = []
    let buffer = this.partial + chunk
    this.partial = ''

    while (buffer.length > 0) {
      if (this.inThinkBlock) {
        const closeIdx = buffer.indexOf(CLOSE_TAG)
        if (closeIdx === -1) break
        const inside = buffer.slice(0, closeIdx)
        buffer = buffer.slice(closeIdx + CLOSE_TAG.length)
        if (this.explicitBlock === 'midProse') {
          // The close proves the hold was a thought after all.
          const held = (this.midProse + inside).split(OPEN_TAG).join('')
          this.midProse = ''
          if (held) push(segments, 'reasoning', held)
        } else {
          this.addReasoning(segments, inside)
        }
        this.inThinkBlock = false
        this.explicitBlock = null
        this.headThought = ''
        // The close the implicit block was waiting for: everything held is
        // confirmed reasoning. It can only happen once — a later orphan close
        // is an ordinary stray marker and is stripped below.
        this.confirmImplicitOpen(segments)
        continue
      }

      const openIdx = buffer.indexOf(OPEN_TAG)
      const closeIdx = buffer.indexOf(CLOSE_TAG)
      if (openIdx === -1 && closeIdx === -1) break
      if (openIdx !== -1 && (closeIdx === -1 || openIdx < closeIdx)) {
        this.addText(segments, buffer.slice(0, openIdx))
        buffer = buffer.slice(openIdx + OPEN_TAG.length)
        this.inThinkBlock = true
        this.explicitBlock = this.sawText ? 'midProse' : 'head'
        continue
      }
      // Orphan close with nothing to close: drop the marker so it cannot reach
      // a transcript as prose, and keep the text around it as text.
      this.addText(segments, buffer.slice(0, closeIdx))
      buffer = buffer.slice(closeIdx + CLOSE_TAG.length)
    }

    const hold = partialTagSuffixLength(buffer)
    this.partial = buffer.slice(buffer.length - hold)
    const rest = buffer.slice(0, buffer.length - hold)
    if (this.inThinkBlock) this.addThinkContent(segments, rest)
    else this.addText(segments, rest)
    return segments
  }

  /** Emit everything withheld. A partial tag that never completed was always
   *  just text, and content held for a close that never came is the answer.
   *  Releasing it here is what makes the speculation lossless. */
  flush(options: ThinkStreamFlushOptions = {}): ThinkStreamSegment[] {
    const segments: ThinkStreamSegment[] = []
    const trailing = this.partial
    this.partial = ''
    if (trailing) {
      if (this.inThinkBlock) this.addThinkContent(segments, trailing)
      else this.addText(segments, trailing)
    }
    if (this.implicitOpen) segments.push(...this.abandonImplicitOpen())
    if (this.explicitBlock === 'midProse') this.releaseMidProse(segments)
    if (this.explicitBlock === 'head' && options.stepCompleted) {
      // The model stopped on its own inside the block, so it was answering
      // there. The thinking box already shows this text; the reply needs it.
      const answer = this.headThought
      this.headThought = ''
      this.explicitBlock = null
      this.inThinkBlock = false
      if (answer.trim()) this.addText(segments, answer)
    }
    return segments
  }

  /** Route content inside a block by the kind of block it is. */
  private addThinkContent(segments: ThinkStreamSegment[], text: string): void {
    if (this.explicitBlock !== 'midProse') {
      this.addReasoning(segments, text)
      return
    }
    this.midProse += text
    if (this.midProse.length >= MID_PROSE_THINK_BUDGET_CHARS) {
      this.releaseMidProse(segments)
    }
  }

  /** No close is coming for a mid-prose open, so the tag was prose: emit it
   *  and everything held after it verbatim. A later `</think>` is then an
   *  orphan and is stripped, like any other. */
  private releaseMidProse(segments: ThinkStreamSegment[]): void {
    const held = this.midProse
    this.midProse = ''
    this.explicitBlock = null
    this.inThinkBlock = false
    this.addText(segments, OPEN_TAG + held)
  }

  /** The orphan close arrived: what was held was reasoning after all. */
  private confirmImplicitOpen(segments: ThinkStreamSegment[]): void {
    if (!this.implicitOpen) return
    this.implicitOpen = false
    const held = this.held
    this.held = ''
    if (held) push(segments, 'reasoning', held)
  }

  /** No close is coming: what was held was the answer. */
  private abandonImplicitOpen(): ThinkStreamSegment[] {
    this.implicitOpen = false
    this.inThinkBlock = false
    const held = this.held
    this.held = ''
    if (/\S/.test(held)) this.sawText = true
    return held ? [{ type: 'text', text: held }] : []
  }

  private addReasoning(
    segments: ThinkStreamSegment[],
    text: string,
  ): void {
    // A nested/duplicated open tag inside a block is scaffolding, never thought.
    const cleaned = text.split(OPEN_TAG).join('')
    if (!cleaned) return
    if (!this.implicitOpen) {
      push(segments, 'reasoning', cleaned)
      if (this.explicitBlock === 'head') this.headThought += cleaned
      return
    }
    // Still undecided: this is reasoning only if an orphan close confirms it,
    // so hold rather than send. Past the budget the step is answering, not
    // thinking, and the hold is released as text.
    this.held += cleaned
    if (this.held.length >= IMPLICIT_OPEN_BUDGET_CHARS) {
      segments.push(...this.abandonImplicitOpen())
    }
  }

  private addText(segments: ThinkStreamSegment[], text: string): void {
    if (!text) return
    if (/\S/.test(text)) this.sawText = true
    push(segments, 'text', text)
  }
}

/** Append, merging into the tail when the type matches so a caller sends one
 *  event per delta in the common case. */
function push(
  segments: ThinkStreamSegment[],
  type: ThinkStreamSegment['type'],
  text: string,
): void {
  const last = segments[segments.length - 1]
  if (last && last.type === type) last.text += text
  else segments.push({ type, text })
}
