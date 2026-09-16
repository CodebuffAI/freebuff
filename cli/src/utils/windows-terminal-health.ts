import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'

import { getCliEnv } from './env'

import type { LogRecordInput } from '@codebuff/common/schemas/logs'

type WindowsTerminalFailureEvent =
  | AnalyticsEvent.TERMINAL_BROKER_SPAWN_FAILED
  | AnalyticsEvent.TERMINAL_WATCHDOG_FAILED

export type WindowsTerminalFailure = {
  stage: 'spawn' | 'stdio' | 'completion' | 'bootstrap' | 'arming'
  failureCode:
    | 'failed_to_connect'
    | 'enoent'
    | 'eacces'
    | 'eperm'
    | 'epipe'
    | 'invalid_response'
    | 'protocol_missing'
    | 'protocol_write_failed'
    | 'response_too_large'
    | 'exit_nonzero'
    | 'terminated'
    | 'timeout'
    | 'unknown'
}

type WindowsTerminalFailureProperties = WindowsTerminalFailure & {
  version: string
  platform: 'win32'
}

export type WindowsTerminalHealthDeliveryDeps = {
  trackEvent?: (
    event: WindowsTerminalFailureEvent,
    properties: WindowsTerminalFailureProperties,
  ) => boolean | void
  getAnonymousId: () => string
  enqueueClientLog: (record: LogRecordInput) => void
  drainClientLogs: () => Promise<void>
}

export function sanitizeWindowsCliVersion(version: string): string {
  return /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/.test(version)
    ? version
    : 'unknown'
}

/**
 * Preserve the normal PostHog + Axiom mirror path when analytics is available.
 * If analytics was not initialized, queue the same bounded event directly in
 * the Axiom shipper before draining it.
 */
export async function deliverWindowsTerminalFailure(
  event: WindowsTerminalFailureEvent,
  properties: WindowsTerminalFailureProperties,
  deps: WindowsTerminalHealthDeliveryDeps,
): Promise<void> {
  let queuedByAnalytics = false
  if (deps.trackEvent) {
    try {
      queuedByAnalytics = deps.trackEvent(event, properties) !== false
    } catch {
      // Analytics initialization is best-effort; Axiom delivery is independent.
    }
  }

  if (!queuedByAnalytics) {
    try {
      deps.enqueueClientLog({
        level: 'info',
        event,
        message: event,
        client_session_id: deps.getAnonymousId(),
        data: properties,
      })
    } catch {
      // Terminal-health reporting must never affect terminal behavior.
    }
  }

  try {
    await deps.drainClientLogs()
  } catch {
    // The shipper is best-effort and owns retry/drop behavior.
  }
}

/**
 * Emit a bounded Windows terminal-health failure and start its Axiom mirror
 * immediately. Both terminal components use this path so their platform gate,
 * version handling, privacy envelope, and delivery behavior cannot drift.
 */
export function reportWindowsTerminalFailure(
  event: WindowsTerminalFailureEvent,
  failure: WindowsTerminalFailure,
): void {
  const env = getCliEnv()
  if (process.platform !== 'win32' || env.FREEBUFF_MODE !== 'true') return

  const properties: WindowsTerminalFailureProperties = {
    version: sanitizeWindowsCliVersion(env.CODEBUFF_CLI_VERSION ?? ''),
    platform: 'win32',
    stage: failure.stage,
    failureCode: failure.failureCode,
  }

  void Promise.all([
    import('./analytics').catch(() => null),
    import('./anonymous-id'),
    import('./log-shipper'),
  ])
    .then(([analytics, { getOrCreatePersistentAnonymousId }, logShipper]) => {
      return deliverWindowsTerminalFailure(event, properties, {
        trackEvent: analytics?.trackEvent,
        getAnonymousId: getOrCreatePersistentAnonymousId,
        enqueueClientLog: logShipper.enqueueClientLog,
        drainClientLogs: logShipper.drainClientLogs,
      })
    })
    .catch(() => {
      // Telemetry is best-effort and must never affect terminal behavior.
    })
}
