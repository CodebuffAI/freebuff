import type { CliRenderer } from '@opentui/core'

/**
 * Keeps mouse reports that arrive split across stdin reads out of the input box.
 *
 * With mouse tracking on, the terminal sends each move or wheel tick as an SGR
 * report, `ESC [ < 35 ; 76 ; 40 M`. OpenTUI's stdin parser waits a short time
 * for the rest of an unfinished sequence, then flushes it. A report split
 * right after `ESC [` (a slow ssh or relay hop, a busy machine) loses its
 * introducer to that flush as an opaque `ESC [` response, and the rest,
 * `<35;76;40M`, is then parsed as typed characters. OpenTUI recovers a report
 * split after a lone ESC or after `ESC [ <`, but not this one.
 *
 * The guard watches the renderer's input sequences: after a flushed `ESC [`,
 * keys that spell an SGR report body are swallowed. Nothing a person types
 * produces a lone flushed `ESC [` followed by `<`, so typing is untouched.
 */

/** The introducer OpenTUI flushes on its own when a report is split after it. */
const FLUSHED_CSI = '\x1b['
/** How long after the flush the rest of the report may still arrive. */
const REST_OF_REPORT_WINDOW_MS = 2_000
/**
 * Waiting this long for the rest of a split sequence before OpenTUI flushes it
 * (its own default is 20ms). Terminals (Ghostty, iTerm2, VS Code) also split
 * bracketed paste across reads when files are dropped, and a flush corrupts
 * paste detection. Still unnoticeable on a lone Escape press.
 */
export const STDIN_PARSER_TIMEOUT_MS = 100

type GuardRenderer = Pick<
  CliRenderer,
  'prependInputHandler' | 'removeInputHandler'
>

/**
 * Progress through `<` digits `;` digits `;` digits (`M` | `m`).
 * `field` counts the semicolons seen; `digits` whether this field has one.
 */
type ReportBody = { field: number; digits: boolean }

export class SplitMouseReportGuard {
  private armedAt: number | null = null
  private body: ReportBody | null = null

  constructor(private readonly now: () => number = Date.now) {}

  /** True when `sequence` is part of a split mouse report and must not be typed. */
  readonly handleInput = (sequence: string): boolean => {
    if (sequence === FLUSHED_CSI) {
      this.armedAt = this.now()
      this.body = null
      return false
    }
    if (this.body) return this.continueBody(sequence)
    if (this.armedAt === null) return false
    const armedAt = this.armedAt
    this.armedAt = null
    if (sequence !== '<' || this.now() - armedAt > REST_OF_REPORT_WINDOW_MS) {
      return false
    }
    this.body = { field: 0, digits: false }
    return true
  }

  private continueBody(sequence: string): boolean {
    const body = this.body!
    if (sequence.length === 1 && sequence >= '0' && sequence <= '9') {
      body.digits = true
      return true
    }
    if (sequence === ';' && body.digits && body.field < 2) {
      this.body = { field: body.field + 1, digits: false }
      return true
    }
    this.body = null
    // The final byte ends the report; anything else is not a report, so it is typed.
    return (sequence === 'M' || sequence === 'm') && body.digits && body.field === 2
  }
}

/** OpenTUI's stdin parser, whose flush timeout is not a renderer option. */
type RendererWithStdinParser = { stdinParser?: { timeoutMs?: unknown } | null }

/**
 * Give split sequences longer to arrive whole before the parser flushes them,
 * and swallow the remains of a split mouse report it flushed anyway.
 * Returns the uninstaller.
 */
export function installSplitMouseReportGuard(
  renderer: GuardRenderer,
): () => void {
  const parser = (renderer as unknown as RendererWithStdinParser).stdinParser
  if (parser && typeof parser.timeoutMs === 'number') {
    parser.timeoutMs = Math.max(parser.timeoutMs, STDIN_PARSER_TIMEOUT_MS)
  }
  const guard = new SplitMouseReportGuard()
  renderer.prependInputHandler(guard.handleInput)
  return () => renderer.removeInputHandler(guard.handleInput)
}
