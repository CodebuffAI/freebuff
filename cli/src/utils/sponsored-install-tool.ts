import {
  SPONSORED_INSTALL_TOOL_DESCRIPTION,
  SPONSORED_INSTALL_TOOL_NAME,
  runSponsoredInstallTool,
  sponsoredInstallInputSchema,
  type SponsoredInstallToolDeps,
} from '@codebuff/common/ads/sponsored-install-tool'
import { getCustomToolDefinition } from '@codebuff/sdk'

import type { CustomToolDefinition } from '@codebuff/sdk'

/**
 * Marks a `run_terminal_command` call as `install_package`'s OWN canonical
 * install (COD-965): the sponsored shell then skips its shell-install refusal
 * and keeps every other refusal, the receipts and the sandbox. A symbol, so
 * it can only be set by code in this process: the model's tool input arrives
 * as parsed JSON, which can never carry a symbol key.
 */
export const SPONSORED_INSTALL_TOOL_EXEC: unique symbol = Symbol(
  'sponsored-install-tool-exec',
)

/** The slice of the run's `run_terminal_command` override the tool runs through. */
export type SponsoredInstallTerminal = (input: {
  command: string
  process_type?: 'SYNC' | 'BACKGROUND'
  timeout_seconds?: number
  [SPONSORED_INSTALL_TOOL_EXEC]?: true
}) => Promise<unknown>

/**
 * `install_package`'s exec over the run's own `run_terminal_command` (the
 * redacted, sandboxed override every shell command of the run takes), from
 * the project root, bounded by `timeoutSeconds`. A refusal comes back as
 * `{ errorMessage }`; a finished command as `{ stdout, stderr?, exitCode? }`.
 */
export function sponsoredInstallExec(
  runTerminalCommand: SponsoredInstallTerminal,
): SponsoredInstallToolDeps['exec'] {
  return async (command, timeoutSeconds) => {
    const raw = await runTerminalCommand({
      command,
      process_type: 'SYNC',
      timeout_seconds: timeoutSeconds,
      [SPONSORED_INSTALL_TOOL_EXEC]: true,
    })
    const value = (
      Array.isArray(raw) ? (raw[0] as { value?: unknown })?.value : undefined
    ) as
      | {
          errorMessage?: unknown
          stdout?: unknown
          stderr?: unknown
          message?: unknown
          exitCode?: unknown
        }
      | undefined
    if (!value || typeof value !== 'object') {
      return { exitCode: null, output: 'The install returned no result.' }
    }
    if (typeof value.errorMessage === 'string') {
      return { exitCode: 1, output: value.errorMessage, refused: true }
    }
    const output = [value.stdout, value.stderr, value.message]
      .filter((part): part is string => typeof part === 'string' && part !== '')
      .join('\n')
    return {
      exitCode: typeof value.exitCode === 'number' ? value.exitCode : null,
      output,
    }
  }
}

/**
 * `install_package` for a CLI sponsored run, the tool Desktop registers
 * (`freebuff-desktop/src/server/harness/sponsored-install-tool.ts`). The
 * handler is the shared one (`common/src/ads/sponsored-install-tool.ts`):
 * validate, detect how the project installs, ask the server's resolver, run
 * the canonical scripts-off command. The CLI supplies only the deps: the
 * rooted project probe, the resolver call bound to this run's proposal and
 * run token, and {@link sponsoredInstallExec}.
 */
export function sponsoredInstallTool(
  deps: SponsoredInstallToolDeps,
): CustomToolDefinition {
  return getCustomToolDefinition({
    toolName: SPONSORED_INSTALL_TOOL_NAME,
    inputSchema: sponsoredInstallInputSchema,
    description: SPONSORED_INSTALL_TOOL_DESCRIPTION,
    endsAgentStep: false,
    exampleInputs: [{ ecosystem: 'npm', name: '@acme/sdk', version: '1.2.3' }],
    execute: async (input) => [
      { type: 'json', value: await runSponsoredInstallTool(deps, input) },
    ],
  })
}
