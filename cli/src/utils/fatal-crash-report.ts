import fs from 'fs'
import path from 'path'

import { getConfigDir } from './config-dir'
import { getCliEnv } from './env'

/**
 * A fatal exit (uncaught exception / unhandled rejection) used to leave no
 * trace outside the user's terminal: `exitCliWithFatalError` wrote the stack
 * to stderr and called `process.exit(1)`, so nothing reached Axiom and crash
 * reports could only be triaged from screenshots. The process cannot wait for
 * a network flush on the way down, so the crash is written synchronously to a
 * small file instead, and the NEXT launch ships it as `cli.fatal_crash`.
 *
 * The payload is bounded: the error's name, the first 300 characters of its
 * message and its first 20 stack frames, plus version/platform/uptime.
 */

const REPORT_FILE = 'last-fatal-crash.json'
const MAX_MESSAGE_CHARS = 300
const MAX_STACK_FRAMES = 20
const MAX_STACK_CHARS = 4_000
/** A report older than this is stale evidence; drop it instead of shipping. */
const MAX_REPORT_AGE_MS = 7 * 24 * 60 * 60 * 1000

export type FatalCrashReport = {
  label: string
  errorName?: string
  errorMessage: string
  stack?: string
  crashedVersion: string
  platform: string
  arch: string
  uptimeSeconds: number
  crashedAt: string
  /** Whether a Freebuff hour was live, i.e. resumable by the next launch. */
  heldFreebuffSession: boolean
}

function reportPath(dir: string): string {
  return path.join(dir, REPORT_FILE)
}

function safeString(read: () => unknown): string | undefined {
  try {
    const value = read()
    return value === undefined || value === null ? undefined : String(value)
  } catch {
    return undefined
  }
}

export function buildFatalCrashReport(
  label: string,
  error: unknown,
  context: {
    heldFreebuffSession: boolean
    version?: string
    now?: number
    uptimeSeconds?: number
  },
): FatalCrashReport {
  const isError = error instanceof Error
  const message =
    (isError ? safeString(() => error.message) : safeString(() => error)) ??
    '<unprintable error>'
  const stack = isError ? safeString(() => error.stack) : undefined
  return {
    label,
    errorName: isError ? safeString(() => error.name) : typeof error,
    errorMessage: message.slice(0, MAX_MESSAGE_CHARS),
    stack: stack
      ?.split('\n')
      .slice(0, MAX_STACK_FRAMES + 1)
      .join('\n')
      .slice(0, MAX_STACK_CHARS),
    crashedVersion:
      context.version ?? getCliEnv().CODEBUFF_CLI_VERSION ?? 'dev',
    platform: process.platform,
    arch: process.arch,
    uptimeSeconds: Math.round(context.uptimeSeconds ?? process.uptime()),
    crashedAt: new Date(context.now ?? Date.now()).toISOString(),
    heldFreebuffSession: context.heldFreebuffSession,
  }
}

/** Synchronous and never throws: runs on the way down from a fatal error. */
export function recordFatalCrashSync(
  label: string,
  error: unknown,
  context: { heldFreebuffSession: boolean },
  dir?: string,
): void {
  try {
    const target = dir ?? getConfigDir()
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(
      reportPath(target),
      JSON.stringify(buildFatalCrashReport(label, error, context)),
      { mode: 0o600 },
    )
  } catch {
    // Best effort: the stderr report is still printed by the caller.
  }
}

/** Read and delete the previous launch's crash report, if any. */
export function takePreviousFatalCrash(
  dir?: string,
  now = Date.now(),
): FatalCrashReport | undefined {
  let file: string
  try {
    file = reportPath(dir ?? getConfigDir())
  } catch {
    return undefined
  }
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  try {
    fs.unlinkSync(file)
  } catch {
    // Unremovable: report it anyway, at worst once per launch.
  }
  try {
    const value = JSON.parse(raw) as Partial<FatalCrashReport>
    const crashedAt = Date.parse(String(value.crashedAt))
    if (
      typeof value.label !== 'string' ||
      typeof value.errorMessage !== 'string' ||
      !Number.isFinite(crashedAt) ||
      now - crashedAt > MAX_REPORT_AGE_MS
    )
      return undefined
    return value as FatalCrashReport
  } catch {
    return undefined
  }
}
