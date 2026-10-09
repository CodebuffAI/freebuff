import { z } from 'zod'

import {
  sponsoredRuntimeSchema,
  type SponsoredRuntime,
} from './sponsored-capability'

/**
 * THE SOFT ENVIRONMENT WARNING (COD-829): an agentic offer whose campaign
 * declared an OS or runtime this machine does not match is still SERVED, and
 * its card says "May not work on your machine" beside an Accept that still
 * works. Owen's call (2026-10-09): no hard gating on environment, warn instead.
 *
 * The server decides it (it holds the campaign's declarations) and sends it
 * on the agentic offer response; the client only renders `message`. The same
 * `reasons` go on the `proposal_offered` funnel row, which is how the run
 * grader files a warned run that then failed for that reason as
 * `environment_limited` rather than as our failure.
 */
export const SPONSORED_ENVIRONMENT_WARNING_REASONS = ['os', 'runtime'] as const
export type SponsoredEnvironmentWarningReason =
  (typeof SPONSORED_ENVIRONMENT_WARNING_REASONS)[number]

export const sponsoredEnvironmentWarningSchema = z.object({
  reasons: z.array(z.enum(SPONSORED_ENVIRONMENT_WARNING_REASONS)).min(1),
  /** One line for the card, written by the server. */
  message: z.string().min(1).max(200),
  missingRuntimes: z.array(sponsoredRuntimeSchema).optional(),
})

export type SponsoredEnvironmentWarning = z.infer<
  typeof sponsoredEnvironmentWarningSchema
>

export type SponsoredEnvironmentOs = 'macos' | 'windows' | 'linux'

const OS_LABELS: Record<SponsoredEnvironmentOs, string> = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
}

const RUNTIME_LABELS: Record<SponsoredRuntime, string> = {
  node: 'Node.js',
  npx: 'npx',
  bun: 'Bun',
  python: 'Python',
}

function listed(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/**
 * The warning for one machine against one campaign's declarations, or null.
 *
 * Only a KNOWN mismatch warns: an unknown OS, or a client that reported no
 * runtime list, says nothing, because a false "may not work" costs an Accept.
 */
export function sponsoredEnvironmentWarning(input: {
  supportedOs?: readonly SponsoredEnvironmentOs[]
  requiredRuntimes?: readonly SponsoredRuntime[]
  reportedOs: SponsoredEnvironmentOs | null
  availableRuntimes?: readonly SponsoredRuntime[]
}): SponsoredEnvironmentWarning | null {
  const reasons: SponsoredEnvironmentWarningReason[] = []
  const clauses: string[] = []
  const os = input.reportedOs
  if (input.supportedOs?.length && os && !input.supportedOs.includes(os)) {
    reasons.push('os')
    clauses.push(
      `built for ${listed(input.supportedOs.map((item) => OS_LABELS[item]))}, not ${OS_LABELS[os]}`,
    )
  }
  const available = input.availableRuntimes
  const missingRuntimes =
    available && input.requiredRuntimes
      ? input.requiredRuntimes.filter((runtime) => !available.includes(runtime))
      : []
  if (missingRuntimes.length > 0) {
    reasons.push('runtime')
    clauses.push(
      `${listed(missingRuntimes.map((runtime) => RUNTIME_LABELS[runtime]))} ${missingRuntimes.length === 1 ? 'was' : 'were'} not found`,
    )
  }
  if (reasons.length === 0) return null
  return {
    reasons,
    message: `May not work on your machine: ${clauses.join(', and ')}.`,
    ...(missingRuntimes.length > 0 ? { missingRuntimes } : {}),
  }
}
