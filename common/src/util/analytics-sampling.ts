import { AnalyticsEvent } from '../constants/analytics-events'

const DEFAULT_SAMPLED_RATE = 0.01

const SAMPLED_EVENT_RATES: Partial<Record<AnalyticsEvent, number>> = {
  [AnalyticsEvent.FEEDBACK_BUTTON_HOVERED]: DEFAULT_SAMPLED_RATE,
  [AnalyticsEvent.FOLLOWUP_CLICKED]: DEFAULT_SAMPLED_RATE,
  [AnalyticsEvent.CLI_INLINE_AD_SLOT_ELIGIBLE]: DEFAULT_SAMPLED_RATE,
  [AnalyticsEvent.SLASH_COMMAND_USED]: DEFAULT_SAMPLED_RATE,
  [AnalyticsEvent.SLASH_MENU_ACTIVATED]: DEFAULT_SAMPLED_RATE,
}

const ALWAYS_TRACK_EVENTS = new Set<AnalyticsEvent>([
  // DAU is measured from MESSAGE_SENT, so it must never be sampled.
  AnalyticsEvent.MESSAGE_SENT,
  // Engaged-time is summed from event counts, so it must never be sampled.
  AnalyticsEvent.PRODUCT_ACTIVE_MINUTE,
  AnalyticsEvent.APP_LAUNCHED,
  AnalyticsEvent.CHANGE_DIRECTORY,
  AnalyticsEvent.FINGERPRINT_GENERATED,
  AnalyticsEvent.INVALID_COMMAND,
  AnalyticsEvent.KNOWLEDGE_FILE_UPDATED,
  AnalyticsEvent.LOGIN,
  AnalyticsEvent.LOGIN_STARTED,
  AnalyticsEvent.LOGIN_FAILED,
  AnalyticsEvent.LOGIN_TIMEOUT,
  AnalyticsEvent.LOGIN_ABORTED,
  // Desktop surface events are low-volume; keep them whole so the app's launch /
  // login / activity funnels aren't decimated by the 1% default sample.
  AnalyticsEvent.DESKTOP_APP_LAUNCHED,
  // Both halves of the sign-in funnel, or its conversion rate is a ratio of two
  // differently-sampled numbers.
  AnalyticsEvent.DESKTOP_LOGIN_STARTED,
  AnalyticsEvent.DESKTOP_LOGIN,
  // Rare, and the only evidence a sign-in failed at all — a sampled one is a
  // support ticket with nothing behind it.
  AnalyticsEvent.DESKTOP_LOGIN_FAILED,
  AnalyticsEvent.DESKTOP_LOGOUT,
  AnalyticsEvent.DESKTOP_THREAD_CREATED,
  AnalyticsEvent.DESKTOP_PROJECT_OPENED,
  AnalyticsEvent.DESKTOP_TURN_COMPLETED,
  // Low-volume recovery funnel. Sampling any stage independently would make
  // creation-to-success and repeated-failure rates impossible to measure.
  AnalyticsEvent.DESKTOP_FAILED_TURN_RECOVERY,
  // Rare reliability signal — every stalled turn must be counted, never sampled.
  AnalyticsEvent.DESKTOP_TURN_STALLED,
  // Its counterpart (an explained silence). Same reasoning: rare, and only
  // useful if every one is counted.
  AnalyticsEvent.DESKTOP_TURN_BACKGROUND_WAIT,
  // Feature adoption is measured as UNIQUE USERS per feature. At desktop's
  // ~1-2k DAU a 1% sample would leave a feature used by 2% of users with
  // roughly zero sampled users — the number is unrecoverable from a sample, so
  // this one is never sampled. Volume is controlled at the emit site instead
  // (intent-only actions + per-session dedupe), not by throwing away users.
  AnalyticsEvent.DESKTOP_FEATURE_USED,
  AnalyticsEvent.DESKTOP_HARNESS_CHANGED,
  AnalyticsEvent.DESKTOP_MODEL_CHANGED,
  AnalyticsEvent.DESKTOP_SKILL_RUN,
  AnalyticsEvent.DESKTOP_CODEX_RESOLUTION,
  // Rare operational signal. Sampling would make per-version failure rates
  // misleading precisely when a Windows-only regression affects few installs.
  AnalyticsEvent.TERMINAL_BROKER_SPAWN_FAILED,
  AnalyticsEvent.TERMINAL_WATCHDOG_FAILED,
  AnalyticsEvent.TERMINAL_COMMAND_COMPLETED,
  // Rare by construction (rate-limited per kind per install) and only useful
  // if every affected install is counted.
  AnalyticsEvent.CLI_HELPER_PROCESS_FLOOD,
  AnalyticsEvent.CLI_HELPER_OUTLIVED_PARENT,
  AnalyticsEvent.DESKTOP_HELPER_PROCESS_FLOOD,
  AnalyticsEvent.UPDATE_CODEBUFF_FAILED,
])

type AnalyticsProperties = Record<string, unknown> | undefined

function getStringProperty(
  properties: AnalyticsProperties,
  key: string,
): string | undefined {
  const value = properties?.[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function getPropertyUserId(
  properties: AnalyticsProperties,
): string | undefined {
  const direct =
    getStringProperty(properties, 'userId') ??
    getStringProperty(properties, 'user_id') ??
    getStringProperty(properties, 'distinct_id')
  if (direct) {
    return direct
  }

  const user = properties?.user
  if (user && typeof user === 'object') {
    const id = (user as { id?: unknown }).id
    return typeof id === 'string' && id.trim() ? id : undefined
  }

  return undefined
}

function splitEnvList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  )
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes'
}

export function isFullTelemetryEnabled(params: {
  distinctId?: string
  properties?: AnalyticsProperties
}): boolean {
  if (isTruthyEnv(process.env.CODEBUFF_FULL_TELEMETRY)) {
    return true
  }

  const ids = splitEnvList(
    process.env.CODEBUFF_FULL_TELEMETRY_IDS ??
      process.env.CODEBUFF_FULL_TELEMETRY_USER_IDS,
  )
  if (ids.size === 0) {
    return false
  }

  const candidates = [
    params.distinctId,
    getPropertyUserId(params.properties),
    getStringProperty(params.properties, 'userEmail'),
    getStringProperty(params.properties, 'email'),
  ].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )

  return candidates.some((candidate) => ids.has(candidate))
}

function getEventSampleRate(
  event: AnalyticsEvent,
  properties: AnalyticsProperties,
): number {
  if (ALWAYS_TRACK_EVENTS.has(event)) {
    return 1
  }

  return SAMPLED_EVENT_RATES[event] ?? 1
}

/**
 * Deterministic sampling for high-volume logs/events: hashes a stable key
 * (typically a userId) so the same key is always in or out of the sample and
 * per-key funnels stay coherent. Callers should record the rate on sampled
 * rows (e.g. `sampleRate: 0.02`) so counts can be re-inflated in queries.
 */
export function shouldSampleByKey(key: string, rate: number): boolean {
  if (rate >= 1) return true
  if (rate <= 0) return false
  return hashString(key) / 0xffffffff < rate
}

function hashString(input: string): number {
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function getSamplingKey(params: {
  event: AnalyticsEvent
  distinctId?: string
  properties?: AnalyticsProperties
}): string {
  return (
    params.distinctId ??
    getPropertyUserId(params.properties) ??
    getStringProperty(params.properties, 'clientSessionId') ??
    getStringProperty(params.properties, 'userInputId') ??
    params.event
  )
}

export function shouldTrackAnalyticsEvent(params: {
  event: AnalyticsEvent
  distinctId?: string
  properties?: AnalyticsProperties
}): boolean {
  if (isFullTelemetryEnabled(params)) {
    return true
  }

  const rate = getEventSampleRate(params.event, params.properties)
  if (rate >= 1) {
    return true
  }
  if (rate <= 0) {
    return false
  }

  const bucket =
    hashString(`${params.event}:${getSamplingKey(params)}`) / 0xffffffff
  return bucket < rate
}

function valueKind(value: unknown): string {
  if (Array.isArray(value)) {
    return 'array'
  }
  if (value === null) {
    return 'null'
  }
  return typeof value
}

export function summarizeAnalyticsValue(
  value: unknown,
): Record<string, unknown> {
  if (value === null || value === undefined) {
    return { kind: valueKind(value) }
  }

  if (typeof value === 'string') {
    return { kind: 'string', length: value.length }
  }

  if (Array.isArray(value)) {
    return { kind: 'array', length: value.length }
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    return {
      kind: 'object',
      keyCount: keys.length,
      keys: keys.slice(0, 25),
    }
  }

  return { kind: valueKind(value) }
}
