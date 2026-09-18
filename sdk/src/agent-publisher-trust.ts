/**
 * Publisher trust for REMOTE agent templates.
 *
 * A template fetched from the public agent registry is executable code: its
 * `handleSteps` is a generator-function SOURCE STRING that
 * `packages/agent-runtime/src/run-programmatic-step.ts` turns into a live
 * function with `eval`, with no isolation, in the process that runs the agent
 * (the user's machine on the CLI and Desktop). The registry GET is public, any
 * account can create a publisher and publish without review, and `latest` is
 * unpinned, so before this gate `--agent anyone/anything` was remote code
 * execution by design.
 *
 * Local `.agents` files and the SDK's `agentDefinitions` are NOT gated: they
 * are code the user already chose to run. Only a template that arrived over
 * the network is checked, and only when it carries executable `handleSteps`;
 * a data-only remote template (prompts, tool lists, spawnable agents) loads as
 * before.
 *
 * Trusted publishers are the union of:
 * - `codebuff`, our own publisher, whose agents also ship bundled with the CLI;
 * - the comma-separated `CODEBUFF_TRUSTED_AGENT_PUBLISHERS` env var;
 * - the `trustedAgentPublishers` option on `CodebuffClient` / `run()`.
 *
 * Deliberately NOT here: sandboxing the eval, signing templates, or pinning
 * `latest`. Each is its own change; this gate is the floor under all of them.
 */

import type { AgentTemplate } from '@codebuff/common/types/agent-template'

export const TRUSTED_AGENT_PUBLISHERS_ENV_VAR =
  'CODEBUFF_TRUSTED_AGENT_PUBLISHERS'

/** Publishers whose executable templates load without any configuration. */
export const ALWAYS_TRUSTED_AGENT_PUBLISHERS: readonly string[] = ['codebuff']

/** Splits the env var's comma-separated list; blanks are dropped. */
export function parseTrustedAgentPublishers(
  raw: string | undefined | null,
): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * The complete trusted set for one run. Publisher ids are compared exactly as
 * the registry spells them: a publisher id is a slug the server assigned, and
 * a looser comparison here would widen trust to ids the operator never named.
 */
export function resolveTrustedAgentPublishers(params: {
  /** `CodebuffClientOptions.trustedAgentPublishers` */
  trustedAgentPublishers?: readonly string[]
  /** the raw `CODEBUFF_TRUSTED_AGENT_PUBLISHERS` value */
  envValue?: string | undefined
}): ReadonlySet<string> {
  const { trustedAgentPublishers, envValue } = params
  return new Set<string>([
    ...ALWAYS_TRUSTED_AGENT_PUBLISHERS,
    ...parseTrustedAgentPublishers(envValue),
    ...(trustedAgentPublishers ?? [])
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  ])
}

/**
 * A remote template carries executable code when its `handleSteps` is a
 * source string. A local template holds a real function (never a string once
 * loaded), and a data-only template has none.
 */
export function hasExecutableHandleSteps(
  template: Pick<AgentTemplate, 'handleSteps'>,
): boolean {
  return typeof template.handleSteps === 'string'
}

/**
 * Thrown by the SDK's `fetchAgentFromDatabase` instead of returning the
 * template. It propagates through `getAgentTemplate` to whoever asked for the
 * agent: for the main agent that is the run's error output, which every host
 * shows verbatim, so the operator sees the exact knob to set rather than an
 * "invalid agent id".
 */
export class UntrustedAgentPublisherError extends Error {
  override readonly name = 'UntrustedAgentPublisherError'
  readonly publisherId: string
  readonly agentId: string
  readonly version: string

  constructor(params: {
    publisherId: string
    agentId: string
    version: string
  }) {
    const { publisherId, agentId, version } = params
    super(
      `Agent ${publisherId}/${agentId}@${version} contains executable handleSteps ` +
        `from an untrusted publisher and was not loaded. Registry agents run their ` +
        `handleSteps as code on this machine, so a publisher must be trusted ` +
        `before its programmatic agents can run. To run it, set ` +
        `${TRUSTED_AGENT_PUBLISHERS_ENV_VAR}=${publisherId} (comma-separated for ` +
        `more than one) or pass trustedAgentPublishers: ['${publisherId}'] to ` +
        `the SDK client.`,
    )
    this.publisherId = publisherId
    this.agentId = agentId
    this.version = version
  }
}

export function isUntrustedAgentPublisherError(
  error: unknown,
): error is UntrustedAgentPublisherError {
  return (
    error instanceof UntrustedAgentPublisherError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'UntrustedAgentPublisherError')
  )
}

/**
 * Decides whether a validated REMOTE template may be handed to the runtime.
 * Returns `null` when it may, or the error to raise when it may not.
 */
export function checkRemoteAgentTemplateTrust(params: {
  template: Pick<AgentTemplate, 'handleSteps'>
  publisherId: string
  agentId: string
  version: string
  trustedPublishers: ReadonlySet<string>
}): UntrustedAgentPublisherError | null {
  const { template, publisherId, agentId, version, trustedPublishers } = params
  if (!hasExecutableHandleSteps(template)) return null
  if (trustedPublishers.has(publisherId)) return null
  return new UntrustedAgentPublisherError({ publisherId, agentId, version })
}
