import {
  SPONSORED_FRICTION_MAX_PER_RUN,
  SPONSORED_FRICTION_TOOL_DESCRIPTION,
  SPONSORED_FRICTION_TOOL_LIMIT_RESULT,
  SPONSORED_FRICTION_TOOL_NAME,
  SPONSORED_FRICTION_TOOL_RESULT,
  sponsoredFrictionInputSchema,
} from '@codebuff/common/ads/sponsored-run-friction'
import { getCustomToolDefinition } from '@codebuff/sdk'

import type { SponsoredFrictionInput } from '@codebuff/common/ads/sponsored-run-friction'
import type { CustomToolDefinition } from '@codebuff/sdk'

/**
 * `report_friction` for a CLI sponsored run, the same tool Desktop
 * registers (`freebuff-desktop/src/server/harness/sponsored-friction-tool.ts`):
 * a blocker or friction the agent hit. It answers at once and `onReport`
 * posts in the background, so the run never waits on telemetry. One tool per
 * run, so its own count is the run's cap.
 *
 * The ONLY custom tool a sponsored run is handed. The SDK dispatches a
 * registered custom tool by name ahead of every builtin, so this list is the
 * whole of what a run can call beyond the contained overrides; this one
 * touches no path, process or network of the user's.
 */
export function sponsoredFrictionTool(
  onReport: (report: SponsoredFrictionInput) => void,
): CustomToolDefinition {
  let sent = 0
  return getCustomToolDefinition({
    toolName: SPONSORED_FRICTION_TOOL_NAME,
    inputSchema: sponsoredFrictionInputSchema,
    description: SPONSORED_FRICTION_TOOL_DESCRIPTION,
    endsAgentStep: false,
    exampleInputs: [
      {
        blocking: true,
        category: 'needs_login',
        step: 3,
        detail: 'Step 3 runs the CLI login, which needs the user in a browser.',
      },
    ],
    execute: (report) => {
      if (sent >= SPONSORED_FRICTION_MAX_PER_RUN)
        return [{ type: 'json', value: SPONSORED_FRICTION_TOOL_LIMIT_RESULT }]
      sent += 1
      onReport(report)
      return [{ type: 'json', value: SPONSORED_FRICTION_TOOL_RESULT }]
    },
  })
}
