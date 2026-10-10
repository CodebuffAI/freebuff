/**
 * `report_friction`: the sponsored run's own account of what got in its way,
 * whether it stopped (a blocker) or got past it (friction).
 *
 * Before this, the only record of why a run stopped short was the client's
 * end-of-turn `diagnostic_reason` (what ENDED the turn: an error, a stop, a
 * quit) and the model's narration in BigQuery, which the run grader reads and
 * a person reads on the agentic runs page. Neither says, in the agent's own
 * words and in a countable shape, "I stopped at step 3 because the CLI needs a
 * browser login", and nothing at all records the friction a FINISHED run hit
 * ("step 2's command was wrong for this version; I used the new flag"). This
 * tool does: the agent calls it when it hits either, the client posts it to
 * `POST /api/v1/ads/proposal/{id}/friction`, and it lands in
 * `ad_agentic_run_friction`, one row per report.
 *
 * TELEMETRY, NEVER MONEY. Nothing reads it to bill, refund, settle or serve.
 * The grader shows it to its model as one more piece of evidence and keeps it
 * in `metrics`; the runs page prints it on the run view.
 *
 * The detail is the model's free text, so it is scrubbed here
 * ({@link scrubSponsoredFrictionDetail}) by the server before it is stored:
 * URLs, emails, paths and long tokens are replaced, the same way the funnel's
 * diagnostic is (`scrubSponsoredDiagnostic`), but numbers are kept ("needs
 * Node 20") and the cap is longer, because this text is the whole point.
 */

import { z } from 'zod'

export const SPONSORED_FRICTION_TOOL_NAME = 'report_friction'

/**
 * What got in the way. APPEND-ONLY: a stored row keeps the word it was
 * written with. The first four mirror the grader's own cause keys
 * (`agentic-run-grade/contract.ts`) so the two can be read side by side.
 */
export const SPONSORED_FRICTION_CATEGORIES = [
  /** A step needs the user to sign up, log in or approve in a browser. */
  'needs_login',
  /** A step needs an API key, token or other secret the run does not have. */
  'needs_api_key',
  /** Some other step only a human can do (payment, email confirmation, a dashboard setting). */
  'needs_human_action',
  /** A required tool is missing or too old (Node, a package manager, a CLI). */
  'missing_toolchain',
  /** A command or file the procedure needs was refused here (sandbox, permissions, no installs). */
  'command_refused',
  /** A command failed and needed a retry, a different flag or a workaround. */
  'command_failed',
  /** The procedure does not fit this project (framework, language, layout). */
  'project_mismatch',
  /** An instruction was ambiguous or underspecified and the agent had to guess. */
  'unclear_instruction',
  /** The procedure itself is wrong: a broken command, a missing package, an impossible instruction. */
  'procedure_error',
  /** A network call the procedure needs failed or was slow. */
  'network_error',
  'other',
] as const

export type SponsoredFrictionCategory =
  (typeof SPONSORED_FRICTION_CATEGORIES)[number]

export const SPONSORED_FRICTION_DETAIL_MAX = 500

/** Reports one run may record; past this the tool answers without posting. */
export const SPONSORED_FRICTION_MAX_PER_RUN = 10

export const SPONSORED_FRICTION_TOOL_DESCRIPTION =
  'Record friction or a blocker you hit while carrying out the approved procedure, so Freebuff can fix it. Call it each time something got in the way: set blocking true for a step you could not do (call it before you stop with steps undone), and false for one you got past only with a retry, a workaround, a different command or a guess about an unclear instruction. Do not call it for things that went fine. Pick the category that best names the problem and say in one or two plain sentences which step it was, what happened and what you did about it (no file paths, URLs, keys or the user’s code). It only records the report; it does not end the run or change what you should do next.'

/** The tool's input, as both clients register it. */
export const sponsoredFrictionInputShape = {
  blocking: z
    .boolean()
    .describe(
      'true when this stopped a step from being done; false when you got past it.',
    ),
  category: z
    .enum(SPONSORED_FRICTION_CATEGORIES)
    .describe('What got in the way.'),
  detail: z
    .string()
    .min(1)
    .max(2_000)
    .describe(
      'One or two sentences: which step, what happened, and what you did about it. No paths, URLs, keys or user code.',
    ),
  step: z
    .number()
    .int()
    .min(1)
    .max(1_000)
    .optional()
    .describe('The number of the procedure step, when it has one.'),
}

export const sponsoredFrictionInputSchema = z.object(
  sponsoredFrictionInputShape,
)

export type SponsoredFrictionInput = z.infer<
  typeof sponsoredFrictionInputSchema
>

/**
 * The tool's answer to the model. The report is posted in the background and
 * the run must not wait on, or change course because of, our telemetry.
 */
export const SPONSORED_FRICTION_TOOL_RESULT = {
  status: 'recorded',
  note: 'Recorded. Carry on; if you stop with steps undone, tell the user what was done and what remains.',
} as const

/** The answer once a run has used its {@link SPONSORED_FRICTION_MAX_PER_RUN}. */
export const SPONSORED_FRICTION_TOOL_LIMIT_RESULT = {
  status: 'limit_reached',
  note: 'Enough reports for this run; do not call this again.',
} as const

/**
 * The scrubbed, capped detail as stored: first paragraph only, control
 * characters dropped, URLs, emails, paths and long tokens replaced by a
 * placeholder naming what was removed. `null` when nothing is left.
 */
export function scrubSponsoredFrictionDetail(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null
  let text = raw.split(/\r?\n\s*\r?\n/, 1)[0] ?? ''
  text = text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
    .replace(/\b[a-z]:[\\/][^\s;,)]*/gi, '<path>')
    .replace(/\\\\[^\s;,)]+/g, '<path>')
    // A sentence's closing full stop is not part of the path.
    .replace(
      /(^|[\s(=:`'"])~?\/(?!dev\/null\b)[^\s;,)`'"]*[^\s;,.)`'"]/g,
      '$1<path>',
    )
    .replace(/\b[\w.-]+(?:\/[\w.-]+)+\.[a-z0-9]{1,8}\b/gi, '<path>')
    .replace(/\b[a-f0-9]{16,}\b/gi, '<hex>')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<token>')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null
  return text.length > SPONSORED_FRICTION_DETAIL_MAX
    ? `${text.slice(0, SPONSORED_FRICTION_DETAIL_MAX - 1)}…`
    : text
}

/**
 * A category from the wire. A word this build does not know is `other`, so a
 * newer client talking to an older server still records its report.
 */
export function sponsoredFrictionCategory(
  value: unknown,
): SponsoredFrictionCategory | null {
  if (typeof value !== 'string' || !value) return null
  return (SPONSORED_FRICTION_CATEGORIES as readonly string[]).includes(value)
    ? (value as SponsoredFrictionCategory)
    : 'other'
}

/** One line for a person or a grader: `blocker needs_login (step 3): <detail>`. */
export function formatSponsoredFrictionReport(report: {
  blocking: boolean
  category: string
  step?: number | null
  detail: string | null
}): string {
  const step = report.step ? ` (step ${report.step})` : ''
  return `${report.blocking ? 'blocker' : 'friction'} ${report.category}${step}${
    report.detail ? `: ${report.detail}` : ''
  }`
}
