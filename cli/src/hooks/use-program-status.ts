/**
 * Reports the CLI's lifecycle to terminals that understand OSC 7501.
 *
 * `isChainInProgress` covers a whole turn (including subagents and queued
 * follow-ups); `askUserState` overrides it while Freebuff waits for an answer.
 */

import { useEffect, useRef } from 'react'

import { useChatStore } from '../state/chat-store'
import {
  nextProgramStatusUpdate,
  reportBlocked,
  reportDone,
  reportIdle,
  reportWorking,
} from '../utils/program-status'

export function useProgramStatus(): void {
  const isChainInProgress = useChatStore((state) => state.isChainInProgress)
  const isAsking = useChatStore((state) => state.askUserState !== null)
  const wasWorkingRef = useRef(false)

  useEffect(() => {
    const next = nextProgramStatusUpdate({
      isChainInProgress,
      isAsking,
      wasWorking: wasWorkingRef.current,
    })
    wasWorkingRef.current = next.wasWorking

    switch (next.update.state) {
      case 'blocked':
        reportBlocked(next.update.kind)
        break
      case 'working':
        reportWorking()
        break
      case 'done':
        reportDone()
        break
      case 'idle':
        reportIdle()
        break
    }
  }, [isAsking, isChainInProgress])
}
