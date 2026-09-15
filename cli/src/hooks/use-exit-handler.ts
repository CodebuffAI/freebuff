import path from 'path'

import { useCallback, useEffect, useState } from 'react'

import { getCurrentChatId, getProjectDataDir } from '../project-files'
import { IS_FREEBUFF } from '../utils/constants'
import {
  buildExitBanner,
  exitBannerSupportsColor,
  frameExitBanner,
} from '../utils/exit-banner'
import { exitCliCleanly } from '../utils/exit-cleanly'
import { sessionForExit } from '../utils/exit-session'

import type { InputValue } from '../types/store'

interface UseExitHandlerOptions {
  inputValue: string
  setInputValue: (value: InputValue) => void
}

let exitHandlerRegistered = false

/** Where this project's chats live, so the banner can read the one in progress. */
function currentSessionForExit() {
  const chatId = getCurrentChatId()
  if (!chatId) return null

  return sessionForExit({
    chatId,
    chatDir: path.join(getProjectDataDir(), 'chats', chatId),
  })
}

function setupExitMessageHandler() {
  if (exitHandlerRegistered) return
  exitHandlerRegistered = true

  process.on('exit', () => {
    try {
      // This runs synchronously during the exit phase
      // OpenTUI has already cleaned up by this point
      const session = currentSessionForExit()
      if (!session) return

      const banner = buildExitBanner({
        cliName: IS_FREEBUFF ? 'freebuff' : 'codebuff',
        chatId: session.chatId,
        sessionLabel: session.sessionLabel,
        terminalWidth: process.stdout.columns ?? 80,
        color: exitBannerSupportsColor({
          env: process.env,
          isTty: Boolean(process.stdout.isTTY),
        }),
      })
      if (banner) {
        process.stdout.write(frameExitBanner(banner))
      }
    } catch {
      // Silent fail - don't block exit
    }
  })
}

export const useExitHandler = ({
  inputValue,
  setInputValue,
}: UseExitHandlerOptions) => {
  const [nextCtrlCWillExit, setNextCtrlCWillExit] = useState(false)

  useEffect(() => {
    setupExitMessageHandler()
  }, [])

  const handleCtrlC = useCallback(() => {
    if (inputValue) {
      setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
      return true
    }

    if (!nextCtrlCWillExit) {
      setNextCtrlCWillExit(true)
      setTimeout(() => {
        setNextCtrlCWillExit(false)
      }, 2000)
      return true
    }

    void exitCliCleanly()
    return true
  }, [inputValue, setInputValue, nextCtrlCWillExit])

  return { handleCtrlC, nextCtrlCWillExit }
}
