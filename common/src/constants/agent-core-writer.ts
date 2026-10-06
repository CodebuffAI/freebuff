/**
 * Convex's copy of the agent core writer switch (COD-742,
 * docs/convex-agent-core-writes.md and docs/agent-core-mobile-writes.md).
 *
 * The switch itself is `AGENT_CORE_WRITER` in
 * `packages/internal/src/agent-core/writer.ts`, which Convex cannot import
 * (only `@codebuff/common` is bundled into the Convex deployment). This leaf
 * mirrors it so the public Convex functions the iOS and Android apps call by
 * name can tell when Postgres has become the writer:
 *
 * - `convex` (today): the Convex functions write as before.
 * - `postgres`: the send, create, archive and unarchive mutations refuse with
 *   an "update the app" answer (a Convex mutation cannot reach Postgres), and
 *   the cancel action forwards to freebuff-web.
 *
 * Until `writer.ts` lands in great-db-merge-v2 (#5306) this is the only copy,
 * and freebuff-web reads it too; then a test holds the two equal, so they can
 * only move together. A flip is a reviewed diff in BOTH files, never an env var.
 */
export type AgentCoreWriterForConvex = 'convex' | 'postgres'

export const AGENT_CORE_WRITER_FOR_CONVEX: AgentCoreWriterForConvex = 'convex'

/** Whether Postgres writes the agent core, so Convex must not. */
export function agentCoreAppWritesOnPostgres(
  writer: AgentCoreWriterForConvex = AGENT_CORE_WRITER_FOR_CONVEX,
): boolean {
  return writer === 'postgres'
}

/**
 * The `kind` a refused send answers with. The apps show a send failure's
 * `message` when it has one (iOS `CodingStore.send`, Android
 * `CodingCopy.sendFailure`), so the kind is only for logs and a later build.
 */
export const AGENT_CORE_APP_UPDATE_REQUIRED_KIND = 'APP_UPDATE_REQUIRED'

/**
 * What an old app build is told once Postgres writes the agent core. Thrown
 * as a `ConvexError` with STRING data: both apps show `errorData` verbatim
 * (iOS `ConvexCallError`, Android `ConvexCallError`).
 */
export const AGENT_CORE_APP_UPDATE_REQUIRED_MESSAGE =
  'This version of Freebuff is out of date. Update the app to keep working on your projects.'
