/**
 * What a hosted turn fails with when Cloud's own machinery stopped it rather
 * than anything about the turn: its runner restarted or lost the chat, or the
 * database dropped out. The worker hands such a turn on to the next runner
 * wherever the turn's saved state or transcript says where it stood
 * (web/src/server/desktop-cloud/worker.ts); only the rest end with one of these.
 * Whatever broke them is not true of the next message, so the hosted window's
 * queue goes on past one instead of pausing (freebuff/web queue.ts). Recognised
 * by equality, and counted by these exact words (system-failed-sessions.ts):
 * change every side together.
 */
export const CLOUD_RUNNER_RESTARTED =
  'Cloud runner restarted. Completed steps are saved; send a message to continue.'
export const CLOUD_RUNNER_LOST_CHAT =
  'The cloud runner lost track of this chat. Completed steps are saved; send a message to continue.'
export const CLOUD_DATABASE_UNAVAILABLE =
  'Cloud lost its database connection during this turn. Completed steps are saved; send a message to continue.'

const INFRASTRUCTURE_FAILURES: ReadonlySet<string> = new Set([
  CLOUD_RUNNER_RESTARTED,
  CLOUD_RUNNER_LOST_CHAT,
  CLOUD_DATABASE_UNAVAILABLE,
])

/** Whether a failed run's error is one of Cloud's own interruptions, not the turn's. */
export function isCloudInfrastructureFailure(
  error: string | null | undefined,
): boolean {
  return typeof error === 'string' && INFRASTRUCTURE_FAILURES.has(error)
}
