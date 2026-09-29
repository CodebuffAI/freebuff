/**
 * The CLI's per-project private state files: one JSON file per project root,
 * owner-only, replaced atomically.
 *
 * Its own module so the sponsored run's outbox and last-run pointer
 * (`sponsored-run.ts`) and its in-flight record (`sponsored-run-inflight.ts`)
 * share one implementation, and the in-flight module never has to reach into
 * the run -- which pulls in the SDK's tool implementations -- for it.
 */
import {
  mkdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'path'

/**
 * Where a project's file lives under `directory`: keyed by the SHA-256 of the
 * CANONICAL root, so a symlinked path and its target share one file and the
 * file name says nothing about the folder.
 */
export function privateStateFile(
  directory: string,
  projectRoot: string,
): { directory: string; key: string; target: string } {
  const canonicalRoot = realpathSync(projectRoot)
  const key = createHash('sha256').update(canonicalRoot).digest('hex')
  return {
    directory,
    key,
    target: path.join(directory, `${key}.json`),
  }
}

/**
 * Write `value` to `target` all at once: a private temporary file in the same
 * directory, renamed over the target, so a reader sees the old file or the
 * new one and never half of either.
 */
export function atomicPrivateWrite(
  directory: string,
  key: string,
  target: string,
  value: string,
): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = path.join(directory, `.${key}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, value, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    renameSync(temporary, target)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {}
    throw error
  }
}
