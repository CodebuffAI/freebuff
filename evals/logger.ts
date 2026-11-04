import { mkdirSync } from 'fs'
import path, { dirname } from 'path'

import { IS_CI, IS_TEST } from '@codebuff/common/env'
import pino, { type LogFn } from 'pino'

let logPath: string | undefined = undefined
let pinoLogger: any = undefined

const loggingLevels = ['info', 'debug', 'warn', 'error', 'fatal'] as const
type LogLevel = (typeof loggingLevels)[number]

function initPinoLoggerWithPath(path: string): void {
  if (path === logPath) return // nothing to do

  logPath = path
  mkdirSync(dirname(path), { recursive: true })

  // ──────────────────────────────────────────────────────────────
  //  pino.destination(..) → SonicBoom stream, no worker thread
  // ──────────────────────────────────────────────────────────────
  const fileStream = pino.destination({
    dest: path, // absolute or relative file path
    mkdir: true, // create parent dirs if they don’t exist
    sync: false, // set true if you *must* block on every write
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

function log(level: LogLevel, data: any, msg?: string, ...args: any[]): void {
  if (!IS_CI && !IS_TEST) {
    const projectRoot = path.join(__dirname, '..')
    const logTarget = path.join(projectRoot, 'debug', 'evals.log')

    initPinoLoggerWithPath(logTarget)
  }

  if (pinoLogger !== undefined) {
    pinoLogger[level]({ data }, msg, ...args)
  }
}

/**
 * Wrapper around Pino logger.
 *
 * To also send to Posthog, set data.eventId to type AnalyticsEvent
 *
 * e.g. logger.info({eventId: AnalyticsEvent.SOME_EVENT, field: value}, 'some message')
 */
export const logger: Record<LogLevel, LogFn> = Object.fromEntries(
  loggingLevels.map((level) => {
    return [
      level,
      (data: any, msg?: string, ...args: any[]) =>
        log(level, data, msg, ...args),
    ]
  }),
) as Record<LogLevel, LogFn>
