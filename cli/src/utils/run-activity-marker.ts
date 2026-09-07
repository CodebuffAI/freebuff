/**
 * Cross-process "is a turn running" signal for the npm-wrapper launcher.
 *
 * The wrapper (release-core/launcher.js) checks for updates ~100ms after
 * spawning this process and, on finding one, force-restarts it -- with no
 * way to know whether the user is mid-turn, because it only has this
 * process's exit event, not its React state. While this marker file exists,
 * an agent turn is in progress; the wrapper waits for it to clear (bounded)
 * before stopping the process for an update, instead of interrupting a
 * turn that's still running.
 *
 * Named by this process's pid, which the wrapper already has from spawning
 * it -- no handshake needed. Best-effort throughout: a failed write or
 * remove just means the wrapper falls back to today's immediate-restart
 * behavior for this session.
 */
import { rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

import { useChatStore } from '../state/chat-store'

export function runActivityMarkerPath(pid: number = process.pid): string {
  return path.join(os.tmpdir(), `codebuff-run-active-${pid}`)
}

let started = false

/** Call once, before the store can start toggling isChainInProgress. */
export function startRunActivityMarker(): void {
  if (started) return
  started = true

  const filePath = runActivityMarkerPath()

  const clear = () => {
    try {
      rmSync(filePath, { force: true })
    } catch {
      // Best-effort; see module doc.
    }
  }

  useChatStore.subscribe((state, prevState) => {
    if (state.isChainInProgress === prevState.isChainInProgress) return
    if (state.isChainInProgress) {
      try {
        writeFileSync(filePath, '', { flag: 'w' })
      } catch {
        // Best-effort; see module doc.
      }
    } else {
      clear()
    }
  })

  process.on('exit', clear)
}
