import { randomUUID } from 'node:crypto'

// A new identity for each CLI purchase, never shared through settings or cwd.
// The prefix also lets delayed DELETE/refund requests retain their protocol
// after the picker has switched models (limited offers use the legacy path).
const CLI_MULTI_SESSION_PREFIX = 'cli:'

export function newFreebuffCliInstanceId(): string {
  return `${CLI_MULTI_SESSION_PREFIX}${randomUUID()}`
}

export function freebuffCliAttemptId(instanceId?: string): string | undefined {
  return instanceId?.startsWith(CLI_MULTI_SESSION_PREFIX)
    ? instanceId.slice(CLI_MULTI_SESSION_PREFIX.length)
    : undefined
}

export function freebuffSessionMetadata(instanceId: string) {
  return {
    freebuff_instance_id: instanceId,
    // Use the existing wire protocol so released servers can serve this CLI.
    // The surface distinguishes native clients now that both use this store.
    ...(freebuffCliAttemptId(instanceId)
      ? { freebuff_multi_session: '1', surface: 'cli' }
      : {}),
  }
}
