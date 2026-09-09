import type { ScrollAcceleration } from '@opentui/core'

/**
 * Lines the transcript moves per mouse wheel notch, matching what terminals
 * and desktop apps do by default.
 */
export const WHEEL_SCROLL_LINES = 3

/**
 * OpenTUI's ScrollBox multiplies each wheel event's notch delta by whatever
 * its ScrollAcceleration returns, and defaults to LinearScrollAccel, whose
 * tick() returns 1. A terminal reports one notch as a delta of 1, so the
 * transcript crawls a single line at a time (#1268).
 *
 * Neither shipped accelerator gives a flat multiplier: LinearScrollAccel is
 * fixed at 1, and MacOSScrollAccel ramps with scroll velocity, which would
 * make a fast flick jump much further than the three lines we want. Hence
 * this one, which is stateless -- there is nothing to accumulate or reset,
 * so a single shared instance serves every scrollbox that opts in.
 */
class ConstantScrollAccel implements ScrollAcceleration {
  constructor(private readonly lines: number) {}

  tick(_now?: number): number {
    return this.lines
  }

  reset(): void {
    // Stateless: nothing accumulates between notches.
  }
}

export const wheelScrollAcceleration = new ConstantScrollAccel(
  WHEEL_SCROLL_LINES,
)
