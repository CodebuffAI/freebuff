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
import {
  clipErrorLogString,
  sanitizeErrorLogData,
} from './error-log-redaction'
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
      const logTarget =
        IS_DEV
          ? path.join(projectRoot, 'debug', 'cli.jsonl')
          : path.join(getCurrentChatDir(), CHAT_LOG_FILENAME)

      setLogPath(logTarget)
    }
  }

  const isStringOnly = typeof data === 'string' && msg === undefined
  const normalizedData = isStringOnly ? undefined : data
  const normalizedMsg = isStringOnly ? (data as string) : msg
  const includeData = normalizedData != null && !isEmptyObject(normalizedData)
  const axiomOnlyLogEvent = getAxiomOnlyLogEvent(normalizedData)
  const { data: remoteData, msg: remoteMsg } = remoteLogPayload({
    level,
    data: includeData ? normalizedData : undefined,
    msg: stringFormat(normalizedMsg ?? '', ...args),
  })

  const toTrack = {
    ...(includeData ? { data: remoteData } : {}),
    level,
    loggerContext,
    msg: remoteMsg,
  }

  logAsErrorIfNeeded(toTrack)

  if (!IS_DEV && includeData && typeof normalizedData === 'object') {
    const analyticsPayloads = analyticsDispatcher.process({
      data: remoteData,
      level,
      msg: remoteMsg,
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
    const shipData = axiomOnlyLogEvent
      ? axiomOnlyLogEvent.data
      : includeData
        ? selectAxiomLogData({
            level,
            data: normalizedData,
            sanitizedErrorData: remoteData,
            fullTelemetry: isFullTelemetryEnabled({
              distinctId: loggerContext.userId,
              properties: loggerContext,
            }),
          })
        : undefined
    const record: LogRecordInput = {
      timestamp: new Date().toISOString(),
      level,
      event:
        axiomOnlyLogEvent?.event ??
        (analyticsEventId ? String(analyticsEventId) : undefined),
      message: remoteMsg,
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

/**
 * What a record sends off the machine to both PostHog paths (error tracking
 * and the analytics event) and the Axiom mirror: for error and fatal records,
 * never the conversation, file contents or bulk data they may carry.
 */
export function remoteLogPayload(params: {
  level: LogLevel
  data: unknown
  msg: string
}): { data: unknown; msg: string } {
  const { level, data, msg } = params
  if (level !== 'error' && level !== 'fatal') return { data, msg }
  return {
    data: data === undefined ? undefined : sanitizeErrorLogData(data),
    msg: clipErrorLogString(msg),
  }
}

/**
 * The `data` an Axiom mirror record carries. Error and fatal records ship the
 * sanitized payload whatever the telemetry setting, so a failure never mirrors
 * the conversation. Other levels ship raw only under full telemetry, otherwise
 * a summary, matching the PostHog path.
 */
export function selectAxiomLogData(params: {
  level: LogLevel
  data: unknown
  fullTelemetry: boolean
  sanitizedErrorData?: unknown
}): unknown {
  const { level, data, fullTelemetry } = params
  if (level === 'error' || level === 'fatal') {
    return params.sanitizedErrorData ?? sanitizeErrorLogData(data)
  }
  return fullTelemetry ? data : summarizeAnalyticsValue(data)
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
