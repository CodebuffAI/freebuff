/**
 * The agent core's backend switch (COD-742 roadmap §6 F2,
 * docs/convex-agent-core-mirror.md), as a leaf the browser can import.
 *
 * `packages/internal/src/agent-core/backend.ts` reads it and owns what each
 * mode means for the mirror; it lives here so the web's backend map
 * (`freebuff/web/src/lib/fn-registry/backend-map.ts`) can route the agent
 * core's reactive reads off the same constant, without bundling
 * `@codebuff/internal` into the client. One constant, so the mirror and the
 * UI can only flip together. A reviewed diff, never an env var.
 */
export type AgentCoreBackend = 'convex' | 'shadow' | 'postgres'

// `postgres` (Owen, 2026-10-19): the UI reads the agent core from Postgres and
// Postgres writes it (AGENT_CORE_WRITER); the projection drains, then fences
// (docs/convex-agent-core-writes.md, "The flip runbook").
export const AGENT_CORE_BACKEND: AgentCoreBackend = 'postgres'

/** Whether the web UI reads the agent core from Postgres (`/api/fn` + live topics). */
export function agentCoreUiReadsFromPostgres(
  backend: AgentCoreBackend = AGENT_CORE_BACKEND,
): boolean {
  return backend === 'postgres'
}
