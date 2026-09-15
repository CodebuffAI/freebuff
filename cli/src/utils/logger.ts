import { appendFileSync, existsSync, mkdirSync, unlinkSync } from 'fs'
import path, { dirname } from 'path'
import { format as stringFormat } from 'util'

import { env, IS_DEV, IS_TEST, IS_CI } from '@codebuff/common/env'
import { createAnalyticsDispatcher } from '@codebuff/common/util/analytics-dispatcher'
import { getAnalyticsEventId } from '@codebuff/common/util/analytics-log'
import { getAxiomOnlyLogEvent } from '@codebuff/common/util/axiom-only-log'
import {
  isFullTelemetryEnabled,
  summarizeAnalyticsValue,
} from '@codebuff/common/util/analytics-sampling'
import { pino } from 'pino'

import {
  flushAnalytics,
  logError,
  setAnalyticsErrorLogger,
  trackEvent,
} from './analytics'
import { enqueueClientLog } from './log-shipper'
import { getCurrentChatDir, getProjectRoot } from '../project-files'

import type { LogRecordInput } from '@codebuff/common/schemas/logs'

/** Name of the per-chat debug log file written in production builds */
export const CHAT_LOG_FILENAME = 'log.jsonl'

export interface LoggerContext {
  userId?: string
  userEmail?: string
  clientSessionId?: string
  fingerprintId?: string
  clientRequestId?: string
  [key: string]: any // Allow for future extensions
}

export const loggerContext: LoggerContext = {}

let logPath: string | undefined = undefined
let pinoLogger: any = undefined

const loggingLevels = ['info', 'debug', 'warn', 'error', 'fatal'] as const
type LogLevel = (typeof loggingLevels)[number]
const analyticsDispatcher = createAnalyticsDispatcher({
  envName: env.NEXT_PUBLIC_CB_ENVIRONMENT,
  bufferWhenNoUser: true,
})

/**
 * Safely stringify an object, handling circular references.
 * Replaces circular references with '[Circular]' placeholder.
 */
function safeStringify(obj: unknown): string {
  const seen = new WeakSet()
  return JSON.stringify(obj, (_key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]'
      }
      seen.add(value)
    }
    return value
  })
}

function isEmptyObject(value: any): boolean {
  return (
    value != null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  )
}

function setLogPath(p: string): void {
  if (p === logPath) return // nothing to do

  logPath = p
  mkdirSync(dirname(p), { recursive: true })

  // ──────────────────────────────────────────────────────────────
  //  pino.destination(..) → SonicBoom stream, no worker thread
  // ──────────────────────────────────────────────────────────────
  const fileStream = pino.destination({
    dest: p, // absolute or relative file path
    mkdir: true, // create parent dirs if they don’t exist
    sync: true, // set true if you *must* block on every write
  })

  pinoLogger = pino(
    {
      level: 'debug',
      formatters: {
        level: (label) => ({ level: label.toUpperCase() }),
      },
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    },
    fileStream, // <-- no worker thread involved
  )
}

/**
 * Resolve the per-run log destination without allowing filesystem failures to
 * take down the CLI during startup.
 *
 * In production, resolving the destination creates the current chat
 * directory. That directory may be unavailable (for example, when the
 * config directory is read-only), so callers must treat an absent destination
 * as "continue without file logging".
 */
export function resolveLogTarget(params: {
  projectRoot: string
  isDev: boolean
  getCurrentChatDir: () => string
}): string | undefined {
  try {
    return params.isDev
      ? path.join(params.projectRoot, 'debug', 'cli.jsonl')
      : path.join(params.getCurrentChatDir(), CHAT_LOG_FILENAME)
  } catch {
    return undefined
  }
}

function trySetLogPath(projectRoot: string): void {
  const logTarget = resolveLogTarget({
    projectRoot,
    isDev: IS_DEV,
    getCurrentChatDir,
  })
  if (!logTarget) return

  try {
    setLogPath(logTarget)
  } catch {
    // File logging is best-effort and must never prevent the CLI from
    // starting when the config or chat directory cannot be written. Keep this
    // silent: writing to stderr during startup can corrupt the interactive UI.
  }
}

export function clearLogFile(): void {
  const projectRoot = getProjectRoot()
  const debugDir = path.join(projectRoot, 'debug')
  const targets = new Set<string>()

  if (logPath) {
    targets.add(logPath)
  }
  targets.add(path.join(debugDir, 'cli.jsonl'))
  targets.add(path.join(debugDir, 'trace.jsonl'))

  for (const target of targets) {
    try {
      if (existsSync(target)) {
        unlinkSync(target)
      }
    } catch {
      // Ignore errors when clearing logs
    }
  }

  logPath = undefined
  pinoLogger = undefined
}

function sendAnalyticsAndLog(
  level: LogLevel,
  data: any,
  msg?: string,
  ...args: any[]
): void {
  if (!IS_CI && !IS_TEST) {
    let projectRoot: string | undefined
    try {
      projectRoot = getProjectRoot()
    } catch {
      projectRoot = undefined
    }
    if (projectRoot) {
      trySetLogPath(projectRoot)
    }
  }

  const isStringOnly = typeof data === 'string' && msg === undefined
  const normalizedData = isStringOnly ? undefined : data
  const normalizedMsg = isStringOnly ? (data as string) : msg
  const includeData = normalizedData != null && !isEmptyObject(normalizedData)
  const axiomOnlyLogEvent = getAxiomOnlyLogEvent(normalizedData)

  const toTrack = {
    ...(includeData ? { data: normalizedData } : {}),
    level,
    loggerContext,
    msg: stringFormat(normalizedMsg, ...args),
  }

  logAsErrorIfNeeded(toTrack)

  if (!IS_DEV && includeData && typeof normalizedData === 'object') {
    const analyticsPayloads = analyticsDispatcher.process({
      data: normalizedData,
      level,
      msg: stringFormat(normalizedMsg ?? '', ...args),
      fallbackUserId: loggerContext.userId,
    })

    analyticsPayloads.forEach((payload) => {
      trackEvent(payload.event, payload.properties)
    })
  }

  // Mirror the log/event into the server-side Axiom logs sink via /api/logs
  // (in addition to PostHog). Best-effort and batched; skip noisy debug logs
  // and anything before we know who the user is.
  if (
    !IS_DEV &&
    !IS_TEST &&
    !IS_CI &&
    loggerContext.userId &&
    level !== 'debug'
  ) {
    const analyticsEventId =
      includeData && typeof normalizedData === 'object'
        ? getAnalyticsEventId(normalizedData)
        : null
    // Mirror the PostHog path's redaction: only ship raw payloads for errors or
    // when full telemetry is enabled; otherwise ship a summary. Keeps PII/data
    // volume symmetric across the two sinks.
    const includeRawData =
      isFullTelemetryEnabled({
        distinctId: loggerContext.userId,
        properties: loggerContext,
      }) ||
      level === 'error' ||
      level === 'fatal'
    const shipData = axiomOnlyLogEvent
      ? axiomOnlyLogEvent.data
      : includeData
        ? includeRawData
          ? normalizedData
          : summarizeAnalyticsValue(normalizedData)
        : undefined
    const record: LogRecordInput = {
      timestamp: new Date().toISOString(),
      level,
      event:
        axiomOnlyLogEvent?.event ??
        (analyticsEventId ? String(analyticsEventId) : undefined),
      message: stringFormat(normalizedMsg ?? '', ...args),
      client_session_id:
        (axiomOnlyLogEvent?.data.client_session_id as string | undefined) ??
        loggerContext.clientSessionId,
      client_request_id:
        (axiomOnlyLogEvent?.data.client_request_id as string | undefined) ??
        loggerContext.clientRequestId,
      fingerprint_id: loggerContext.fingerprintId,
      data: shipData,
    }
    enqueueClientLog(record)
  }

  // In dev mode, use appendFileSync for real-time logging (Bun has issues with pino sync)
  // In prod mode, use pino for better performance
  if (IS_DEV && logPath) {
    const logEntry = safeStringify({
      level: level.toUpperCase(),
      timestamp: new Date().toISOString(),
      ...loggerContext,
      ...(includeData ? { data: normalizedData } : {}),
      msg: stringFormat(normalizedMsg ?? '', ...args),
    })
    try {
      appendFileSync(logPath, logEntry + '\n')
    } catch {
      // Ignore write errors
    }
  } else if (pinoLogger !== undefined) {
    const base = { ...loggerContext }
    const obj = includeData ? { ...base, data: normalizedData } : base
    pinoLogger[level](obj, normalizedMsg as any, ...args)
  }
}

function logAsErrorIfNeeded(toTrack: {
  data?: any
  level: LogLevel
  loggerContext: LoggerContext
  msg: string
}) {
  if (toTrack.level === 'error' || toTrack.level === 'fatal') {
    logError(
      new Error(toTrack.msg),
      toTrack.loggerContext.userId ?? 'unknown',
      { ...(toTrack.data ?? {}), context: toTrack.loggerContext },
    )
    flushAnalytics()
  }
}

/**
 * Wrapper around Pino logger.
 *
 * To also send to Posthog, set data.eventId to type AnalyticsEvent
 *
 * e.g. logger.info({eventId: AnalyticsEvent.SOME_EVENT, field: value}, 'some message')
 */
export const logger: Record<LogLevel, pino.LogFn> = Object.fromEntries(
  loggingLevels.map((level) => {
    return [
      level,
      (data: any, msg?: string, ...args: any[]) =>
        sendAnalyticsAndLog(level, data, msg, ...args),
    ]
  }),
) as Record<LogLevel, pino.LogFn>

setAnalyticsErrorLogger((error, context) => {
  const err =
    error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Unknown analytics error')

  logger.warn(
    {
      analyticsError: true,
      error: {
        name: err.name,
        message: err.message,
        stack: err.stack,
      },
      context,
    },
    '[analytics] error',
  )
})
