import React from 'react'

import { useTheme } from '../hooks/use-theme'

import type { FreebuffSessionResponse } from '../types/freebuff-session'

/** Shown when the user launched with `-c` / `--continue` but the probe found
 *  no active session to resume (no seat, expired, or explicitly ended). */
export const NOTHING_TO_CONTINUE_MESSAGE =
  "There's nothing to continue — no active session was found. Pick a model below to start a new one."

/** The notice must only ever appear when the user asked to resume a live
 *  session AND no session is actually resumed. A successful resume either
 *  lands outside this surface entirely or surfaces a `status: 'active'` /
 *  takeover session, never a `status: 'none'` one, so gating on that status
 *  is what makes the notice mean "nothing was resumed". Exported so the
 *  invariant is testable without mounting the whole chat surface. */
export const shouldShowContinueNotice = (
  continueRequested: boolean,
  session: FreebuffSessionResponse | null,
): boolean => continueRequested && session?.status === 'none'

interface FreebuffNothingToContinueNoticeProps {
  /** The raw `-c` / `--continue` flag, before history-pick resume folds in. */
  continueRequested: boolean
  session: FreebuffSessionResponse | null
}

/**
 * Says the launch-time request to resume a live session found nothing, rather
 * than behaving like a plain first launch. Renders nothing unless a continue
 * was requested and no session was resumed.
 */
export const FreebuffNothingToContinueNotice: React.FC<
  FreebuffNothingToContinueNoticeProps
> = ({ continueRequested, session }) => {
  const theme = useTheme()
  if (!shouldShowContinueNotice(continueRequested, session)) return null
  return (
    <text style={{ fg: theme.secondary, wrapMode: 'word', marginTop: 1 }}>
      {NOTHING_TO_CONTINUE_MESSAGE}
    </text>
  )
}
