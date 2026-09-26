import { createCliRenderer } from '@opentui/core'
import { createRoot } from '@opentui/react'
import { writeFileSync } from 'fs'
import React from 'react'

import { exitCliCleanly } from '../../utils/exit-cleanly'
import {
  CLI_RENDERER_EXIT_SIGNALS,
  installProcessCleanupHandlers,
} from '../../utils/renderer-cleanup'
import { writeFileDescriptorSync } from '../../utils/terminal-io'

const mode = process.argv[2]
const cleanExitMarkerPath = process.argv[3]
const rendererReadyMarkerPath = process.argv[4]
if (
  mode !== 'clean' &&
  mode !== 'fatal' &&
  mode !== 'rejection' &&
  mode !== 'unprintable-rejection' &&
  mode !== 'launcher-disconnect' &&
  mode !== 'sigint' &&
  mode !== 'sigterm' &&
  mode !== 'sighup' &&
  mode !== 'sigquit' &&
  mode !== 'sigpipe'
) {
  console.error(
    'usage: renderer-cleanup-fixture.tsx <clean|fatal|rejection|unprintable-rejection|launcher-disconnect|sigint|sigterm|sighup|sigquit|sigpipe>',
  )
  process.exit(2)
}

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  exitSignals: CLI_RENDERER_EXIT_SIGNALS,
  screenMode: 'alternate-screen',
})
installProcessCleanupHandlers(renderer)

let exitScheduled = false
// Written after the alternate screen is gone, so the test can read it.
let sigpipeVerdict = ''
renderer.setFrameCallback(async () => {
  if (exitScheduled) return
  exitScheduled = true
  setTimeout(() => {
    if (mode === 'fatal') {
      throw new Error('fatal-cleanup-fixture')
    }
    if (mode === 'rejection') {
      void Promise.reject(new Error('rejection-cleanup-fixture'))
      return
    }
    if (mode === 'unprintable-rejection') {
      void Promise.reject(Object.create(null))
      return
    }
    if (mode === 'launcher-disconnect') {
      if (rendererReadyMarkerPath) {
        writeFileSync(rendererReadyMarkerPath, 'renderer-ready')
      }
      return
    }
    if (mode === 'sigpipe') {
      // A write to a pipe whose reader is gone. It must not tear the UI down
      // (nor, a moment later, kill the process with no cleanup).
      process.kill(process.pid, 'SIGPIPE')
      setTimeout(() => {
        process.kill(process.pid, 'SIGPIPE')
        setTimeout(() => {
          sigpipeVerdict = renderer.isDestroyed
            ? 'RENDERER_DESTROYED_BY_SIGPIPE\n'
            : 'RENDERER_SURVIVED_SIGPIPE\n'
          void exitCliCleanly()
        }, 100)
      }, 100)
      return
    }
    if (mode === 'clean') {
      void exitCliCleanly()
    } else {
      const signal =
        mode === 'sigint'
          ? 'SIGINT'
          : mode === 'sigterm'
            ? 'SIGTERM'
            : mode === 'sigquit'
              ? 'SIGQUIT'
              : 'SIGHUP'
      process.kill(process.pid, signal)
    }
  }, 10)

  // Keep a frame active until the exit begins, forcing OpenTUI's deferred
  // destroy path rather than its simpler synchronous finalization path.
  await Bun.sleep(500)
})

if (
  mode !== 'fatal' &&
  mode !== 'rejection' &&
  mode !== 'unprintable-rejection'
) {
  process.on('exit', () => {
    if (mode === 'launcher-disconnect' && cleanExitMarkerPath) {
      try {
        writeFileSync(cleanExitMarkerPath, 'CLEAN_EXIT_VISIBLE')
      } catch {}
    } else {
      writeFileDescriptorSync(
        process.stdout.fd,
        `${sigpipeVerdict}CLEAN_EXIT_VISIBLE\n`,
      )
    }
  })
}

createRoot(renderer).render(
  <text>ALTERNATE_SCREEN_CONTENT_SHOULD_NOT_SURVIVE</text>,
)
