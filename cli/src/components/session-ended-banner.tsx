import type { FreebuffModelOption } from '@codebuff/common/constants/freebuff-models'
import { getRateLimitsByModel } from '@codebuff/common/types/freebuff-session'
import { getFreebuffSharedPoolQuota } from '@codebuff/common/util/freebuff-session-pools'
import { TextAttributes } from '@opentui/core'
import { useKeyboard } from '@opentui/react'
import React, { useCallback, useState } from 'react'

import { Button } from './button'
import {
  refreshFreebuffSession,
  returnToFreebuffLanding,
} from '../hooks/use-freebuff-session'
import { useTheme } from '../hooks/use-theme'
import { useFreebuffModelDirectory } from '../state/freebuff-catalog-store'
import { useFreebuffModelStore } from '../state/freebuff-model-store'
import { useFreebuffSessionStore } from '../state/freebuff-session-store'
import {
  FREEBUCKS_LABEL,
  formatFreebucks,
  freebucksOf,
} from '../utils/freebucks'
import { formatSessionUnits } from '../utils/format-session-units'
import { isPlainEnterKey } from '../utils/terminal-enter-detection'
import { BORDER_CHARS } from '../utils/ui-constants'

import type { KeyEvent } from '@opentui/core'

interface SessionEndedBannerProps {
  /** True while an agent request is still streaming under the server-side
   *  grace window. Swaps the Enter-to-rejoin affordance for a "let it
   *  finish" hint so the user doesn't abort their in-flight work. */
  isStreaming: boolean
}

/**
 * Replaces the chat input when the freebuff session has ended. Captures
 * Enter to start a new same-chat session. Esc returns to model selection
 * once no in-flight work needs the global stream-interrupt handler.
 */
export const SessionEndedBanner: React.FC<SessionEndedBannerProps> = ({
  isStreaming,
}) => {
  const theme = useTheme()
  const [pendingAction, setPendingAction] = useState<
    'landing' | 'same-chat' | null
  >(null)

  // The premium pool this banner is reporting on. Reading the first entry
  // assumed one pool covered every row, which stopped being true once a model
  // could carry its own ceiling or a subscription-backed allowance — the
  // banner would then announce a count the user cannot spend on the model
  // they were just using.
  const directory = useFreebuffModelDirectory()
  const premiumQuota = useFreebuffSessionStore(
    (s) =>
      getFreebuffSharedPoolQuota(
        getRateLimitsByModel(s.session),
        directory.isPremium,
      ) ?? null,
  )
  const isQuotaExhausted = premiumQuota
    ? premiumQuota.recentCount >= premiumQuota.limit
    : false
  const freebucks = useFreebuffSessionStore((s) => freebucksOf(s.session))
  const accessTier = useFreebuffSessionStore((s) =>
    s.session && 'accessTier' in s.session ? s.session.accessTier : 'full',
  )
  const quotaLabel = accessTier === 'limited' ? 'sessions' : 'premium sessions'
  // On the meter the pool count is the wrong number twice over: the session
  // that just ended was charged to Freebucks, not to that pool, and the pool
  // is not what decides whether another one can start. Report the balance the
  // next session will actually be bought with.
  const bannerTitle = freebucks
    ? `Session ended  ·  ${formatFreebucks(freebucks.balance)} ${FREEBUCKS_LABEL} left`
    : premiumQuota
      ? `Session ended  ·  ${formatSessionUnits(premiumQuota.recentCount)} of ${premiumQuota.limit} ${quotaLabel} used today`
      : 'Session ended'
  const landingButtonLabel = 'Change model'
  const landingPendingLabel = 'Opening model selection…'

  // With the shared premium pool spent, rejoining on the still-selected
  // premium model would be rejected server-side and dead-end on the terminal
  // rate-limited screen. Continue on the unlimited fallback (DeepSeek V4
  // Flash) instead — the same flip the landing picker's recommendation makes.
  // Limited tier is excluded: its models all share the one exhausted pool, so
  // there is nothing to flip to.
  const selectedModel = useFreebuffModelStore((s) => s.selectedModel)
  const continueOnFallback =
    isQuotaExhausted &&
    accessTier !== 'limited' &&
    directory.isPremium(selectedModel)
  const fallbackModel: FreebuffModelOption | undefined = directory.get(
    directory.fallbackModelId,
  )
  const fallbackModelName = fallbackModel?.displayName ?? 'DeepSeek V4.1 Flash'
  // Remind the user of the fallback's data-collection policy before they
  // continue on it — the landing picker shows this caveat on the model row,
  // but this banner is a one-keypress continue, so surface it here too.
  const fallbackWarning = fallbackModel?.warning

  // While a request is still streaming, restart is disabled: it would
  // unmount <Chat> and abort the in-flight agent run. The promise is "we
  // let the agent finish" — honoring that means Enter does nothing until
  // the stream ends or the user hits Esc.
  const canRestart = !isStreaming && pendingAction === null
  const pickNewModel = useCallback(() => {
    if (!canRestart) return
    setPendingAction('landing')
    // Drop back to the landing picker (status: 'none') so the user picks a
    // model and hits Enter again to commit, instead of silently starting a
    // new session. app.tsx swaps us into <FreebuffLandingScreen> on the
    // transition, unmounting this banner — no need to clear the pending state on
    // success.
    returnToFreebuffLanding({ resetChat: true }).catch(() =>
      setPendingAction(null),
    )
  }, [canRestart])

  const startSameChatSession = useCallback(() => {
    if (!canRestart) return
    setPendingAction('same-chat')
    if (continueOnFallback) {
      // In-memory flip only (like the server-driven model flips): today's
      // exhausted pool must not overwrite the user's saved preference. The
      // rejoin POST reads the store at tick time, so it picks this up.
      useFreebuffModelStore
        .getState()
        .setSelectedModel(directory.fallbackModelId)
    }
    // Re-POST with the currently selected model and keep the chat/run state
    // intact so the next prompt continues the same conversation.
    refreshFreebuffSession().catch(() => setPendingAction(null))
  }, [canRestart, continueOnFallback, directory])

  useKeyboard(
    useCallback(
      (key: KeyEvent) => {
        if (!canRestart) return
        if (isPlainEnterKey(key)) {
          key.preventDefault?.()
          startSameChatSession()
          return
        }
        if (key.name === 'escape') {
          key.preventDefault?.()
          pickNewModel()
        }
      },
      [startSameChatSession, pickNewModel, canRestart],
    ),
  )

  return (
    <box
      title={bannerTitle}
      titleAlignment="center"
      style={{
        width: '100%',
        borderStyle: 'single',
        // Amber border doubles as the "you've hit the cap" signal now that
        // the quota count lives in the title (which can't carry per-char
        // color); muted otherwise.
        borderColor: isQuotaExhausted ? theme.secondary : theme.muted,
        customBorderChars: BORDER_CHARS,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0,
        flexDirection: 'column',
        gap: 0,
      }}
    >
      {isStreaming ? (
        <text style={{ fg: theme.muted, wrapMode: 'word' }}>
          Agent is wrapping up. Rejoin the wait room after it's finished.
        </text>
      ) : (
        <box
          style={{
            width: '100%',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 2,
          }}
        >
          <Button onClick={startSameChatSession}>
            <text
              style={{
                fg:
                  pendingAction === 'same-chat'
                    ? theme.muted
                    : theme.foreground,
              }}
              attributes={TextAttributes.BOLD}
            >
              {pendingAction === 'same-chat'
                ? 'Starting…'
                : continueOnFallback
                  ? `Press Enter to continue with ${fallbackModelName}`
                  : 'Press Enter to continue in a new session'}
            </text>
          </Button>
          <box style={{ flexGrow: 1 }} />
          <Button
            onClick={pickNewModel}
            style={{
              borderStyle: 'single',
              borderColor:
                pendingAction === 'landing' ? theme.muted : theme.border,
              customBorderChars: BORDER_CHARS,
              paddingLeft: 1,
              paddingRight: 1,
            }}
            border={['top', 'bottom', 'left', 'right']}
          >
            <text
              style={{
                fg:
                  pendingAction === 'landing'
                    ? theme.muted
                    : theme.foreground,
              }}
            >
              {pendingAction === 'landing' ? (
                landingPendingLabel
              ) : (
                <>
                  {landingButtonLabel}
                  <span fg={theme.muted}>{'   Esc'}</span>
                </>
              )}
            </text>
          </Button>
        </box>
      )}
      {!isStreaming && continueOnFallback && fallbackWarning && (
        <text style={{ fg: theme.secondary, wrapMode: 'word' }}>
          {`${fallbackModelName} ${fallbackWarning.toLowerCase()}.`}
        </text>
      )}
    </box>
  )
}
