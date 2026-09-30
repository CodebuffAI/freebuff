import { randomUUID } from 'node:crypto'

import {
  FREEBUFF_CLIENT_ENV_METADATA_KEY,
  FREEBUFF_INPUT_PROFILE_METADATA_KEY,
} from '@codebuff/common/constants/freebuff-client-descriptor'
import { FREEBUFF_CLI_CLAIM_PREFIX } from '@codebuff/common/constants/freebuff-desktop-sessions'

import { getClientEnvironmentDescriptor } from './client-environment'
import { takeInputProfile } from './input-profile'

// A new identity for each CLI purchase, never shared through settings or cwd.
// The prefix also lets delayed DELETE/refund requests retain their protocol
// after the picker has switched models (limited offers use the legacy path),
// and tells the server this claim may resume a legacy CLI hour.
const CLI_MULTI_SESSION_PREFIX = FREEBUFF_CLI_CLAIM_PREFIX

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

/**
 * The client descriptors for a run: this process's environment summary and,
 * when the prompt came from the composer, its input counts.
 */
export function clientDescriptorMetadata(
  promptText: string,
): Record<string, string> {
  const inputProfile = takeInputProfile(promptText)
  return {
    [FREEBUFF_CLIENT_ENV_METADATA_KEY]: getClientEnvironmentDescriptor(),
    ...(inputProfile
      ? { [FREEBUFF_INPUT_PROFILE_METADATA_KEY]: inputProfile }
      : {}),
  }
}
