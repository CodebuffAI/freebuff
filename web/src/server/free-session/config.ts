import {
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
  FREEBUFF_KIMI_MODEL_ID,
  FREEBUFF_MINIMAX_MODEL_ID,
} from '@codebuff/common/constants/freebuff-models'
import { env } from '@codebuff/internal/env'

/**
 * Advisory lock ID claimed by the admission tick so only one pod admits
 * users at a time. Unique magic number — keep in sync with
 * packages/internal/src/db/advisory-lock.ts if centralising later.
 */
export const FREEBUFF_ADMISSION_LOCK_ID = 573924815

/** Admission tick cadence. Each tick admits at most one user, so this is the
 *  drip rate: staggering admissions keeps newly-admitted CLIs from all hitting
 *  Fireworks simultaneously even when a large block of sessions expires at once. */
export const ADMISSION_TICK_MS = 15_000
export const SESSION_GRACE_MS = 30 * 60 * 1000

export function getSessionLengthMs(): number {
  return env.FREEBUFF_SESSION_LENGTH_MS
}

/** Drain window after a session's `expires_at`. During this window the gate
 *  still admits requests so an in-flight agent run can finish, but the CLI is
 *  expected to stop accepting new user prompts. Hard cutoff at
 *  `expires_at + grace`; past that the gate returns `session_expired`. */
export function getSessionGraceMs(): number {
  return SESSION_GRACE_MS
}

/**
 * Per-model instant-admit capacity: how many concurrent active sessions a
 * deployment can hold before new joiners fall back to the FIFO queue + tick.
 * Deployment-sizing knob — kept server-side so we can tune without bumping
 * the shared `common` package that the CLI consumes. Unknown ids → 0 (always
 * queue).
 */
const INSTANT_ADMIT_CAPACITY: Record<string, number> = {
  [FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID]: 1000,
  [FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID]: 1000,
  [FREEBUFF_KIMI_MODEL_ID]: 1000,
  [FREEBUFF_MINIMAX_MODEL_ID]: 1000,
}

export function getInstantAdmitCapacity(id: string): number {
  return INSTANT_ADMIT_CAPACITY[id] ?? 0
}
