import { TextAttributes } from '@opentui/core'
import { useKeyboard, useRenderer } from '@opentui/react'
import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { Button } from './button'
import { ChoiceAdBanner, CHOICE_AD_BANNER_HEIGHT } from './choice-ad-banner'
import { FreebuffModelSelector } from './freebuff-model-selector'
import { LimitedLandingPanel } from './limited-landing-panel'
import { ShimmerText } from './shimmer-text'
import {
  refreshFreebuffLandingMetadata,
  takeOverFreebuffSession,
} from '../hooks/use-freebuff-session'
import { useFreebuffCtrlCExit } from '../hooks/use-freebuff-ctrl-c-exit'
import { useGravityAd } from '../hooks/use-gravity-ad'
import { useLogo } from '../hooks/use-logo'
import { useNow } from '../hooks/use-now'
import { useSheenAnimation } from '../hooks/use-sheen-animation'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { useTheme } from '../hooks/use-theme'
import { exitFreebuffCleanly } from '../utils/freebuff-exit'
import {
  formatFreebuffPremiumResetCountdown,
  getFreebuffPremiumResetAt,
} from '../utils/freebuff-premium-reset'
import { formatSessionUnits } from '../utils/format-session-units'
import { getLogoAccentColor, getLogoBlockColor } from '../utils/theme-system'
import {
  FREEBUFF_LIMITED_SESSION_LIMIT,
  FREEBUFF_PREMIUM_SESSION_LIMIT,
} from '@codebuff/common/constants/freebuff-models'
import { getRateLimitsByModel } from '@codebuff/common/types/freebuff-session'

import type { FreebuffSessionResponse } from '../types/freebuff-session'
import type { FreebuffIpPrivacySignal } from '@codebuff/common/types/freebuff-session'
import type { KeyEvent } from '@opentui/core'

interface WaitingRoomScreenProps {
  session: FreebuffSessionResponse | null
  error: string | null
}

const formatWait = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return 'any moment now'
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `~${totalSeconds}s`
  const minutes = Math.round(totalSeconds / 60)
  if (minutes < 60) return `~${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rem = minutes % 60
  return rem === 0 ? `~${hours}h` : `~${hours}h ${rem}m`
}

const formatElapsed = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds}s`
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`
}

/** "in ~3h 20m" / "in ~45 min" / "in under a minute". Used on the
 *  rate-limited screen so users know when they can try again. */
const formatRetryAfter = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return 'any moment now'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rem = minutes % 60
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`
}

const PRIVACY_SIGNAL_LABELS: Partial<Record<FreebuffIpPrivacySignal, string>> =
  {
    anonymous: 'anonymized network',
    proxy: 'proxy',
    relay: 'relay',
    res_proxy: 'residential proxy',
    tor: 'Tor',
    vpn: 'VPN',
  }

const formatPrivacySignalList = (
  signals: FreebuffIpPrivacySignal[] | undefined,
): string => {
  const labels = Array.from(
    new Set(
      signals
        ?.map((signal) => PRIVACY_SIGNAL_LABELS[signal])
        .filter((label): label is string => Boolean(label)) ?? [],
    ),
  )

  if (labels.length === 0) {
    return 'VPN, Tor, proxy, relay, or anonymized network'
  }
  if (labels.length === 1) return labels[0]
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`
  return `${labels.slice(0, -1).join(', ')}, or ${labels[labels.length - 1]}`
}

const TakeoverPrompt: React.FC = () => {
  const theme = useTheme()
  const [pending, setPending] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState(0) // 0 = Take over, 1 = Exit

  const handleTakeover = useCallback(() => {
    if (pending) return
    setPending(true)
    takeOverFreebuffSession().finally(() => setPending(false))
  }, [pending])

  useKeyboard(
    useCallback(
      (key: KeyEvent) => {
        const name = key.name ?? ''
        const isConfirm = name === 'return' || name === 'enter'
        const isExit = name === 'escape' || name === 'esc'
        const isTab = name === 'tab'
        const isShiftTab = key.shift === true && isTab
        const isRight = name === 'right'
        const isLeft = name === 'left'

        if (isExit) {
          key.preventDefault?.()
          exitFreebuffCleanly()
          return
        }

        if (isConfirm) {
          key.preventDefault?.()
          if (focusedIndex === 0) {
            handleTakeover()
          } else {
            exitFreebuffCleanly()
          }
          return
        }

        if (isRight || isTab) {
          key.preventDefault?.()
          setFocusedIndex((prev) => (prev + 1) % 2)
          return
        }

        if (isLeft || isShiftTab) {
          key.preventDefault?.()
          setFocusedIndex((prev) => (prev - 1 + 2) % 2)
          return
        }
      },
      [focusedIndex, handleTakeover],
    ),
  )

  const isTakeoverFocused = focusedIndex === 0
  const isExitFocused = focusedIndex === 1

  return (
    <box
      style={{
        flexDirection: 'column',
        alignItems: 'center',
        gap: 1,
        width: '100%',
      }}
    >
      <text style={{ fg: theme.foreground }} attributes={TextAttributes.BOLD}>
        Freebuff is already running
      </text>

      <text style={{ fg: theme.muted }}>
        Only one freebuff instance is allowed at a time.
      </text>

      <box style={{ flexDirection: 'row', gap: 2, marginTop: 1 }}>
        <Button
          onClick={handleTakeover}
          onMouseOver={() => setFocusedIndex(0)}
          style={{ paddingLeft: 1, paddingRight: 1 }}
          border={['top', 'bottom', 'left', 'right']}
          borderStyle="single"
          borderColor={theme.primary}
        >
          <text
            style={{
              fg: isTakeoverFocused ? theme.background : theme.foreground,
              bg: isTakeoverFocused ? theme.primary : undefined,
            }}
            attributes={TextAttributes.BOLD}
          >
            {pending ? 'Taking over...' : 'Take over'}
          </text>
        </Button>
        <Button
          onClick={exitFreebuffCleanly}
          onMouseOver={() => setFocusedIndex(1)}
          style={{ paddingLeft: 1, paddingRight: 1 }}
          border={['top', 'bottom', 'left', 'right']}
          borderStyle="single"
          borderColor={isExitFocused ? theme.foreground : theme.muted}
        >
          <text
            style={{ fg: isExitFocused ? theme.foreground : theme.muted }}
            attributes={
              isExitFocused ? TextAttributes.BOLD : TextAttributes.NONE
            }
          >
            Exit
          </text>
        </Button>
      </box>
    </box>
  )
}

export const WaitingRoomScreen: React.FC<WaitingRoomScreenProps> = ({
  session,
  error,
}) => {
  const theme = useTheme()
  const renderer = useRenderer()
  const { terminalWidth, contentMaxWidth } = useTerminalDimensions()

  const [sheenPosition, setSheenPosition] = useState(0)
  const blockColor = getLogoBlockColor(theme.name)
  const accentColor = getLogoAccentColor(theme.name)
  const { applySheenToChar } = useSheenAnimation({
    logoColor: theme.foreground,
    accentColor,
    blockColor,
    terminalWidth: renderer?.width ?? terminalWidth,
    sheenPosition,
    setSheenPosition,
  })
  const { component: logoComponent } = useLogo({
    availableWidth: contentMaxWidth,
    accentColor,
    blockColor,
    applySheenToChar,
  })

  // Always enable ads in the waiting room — this is where monetization lives.
  // forceStart bypasses the "wait for first user message" gate inside the hook,
  // which would otherwise block ads here since no conversation exists yet.
  // Try Gravity first, then fall back to ZeroClick when Gravity doesn't fill.
  const { ads, recordImpression } = useGravityAd({
    enabled: true,
    forceStart: true,
    provider: 'gravity',
    fallbackProvider: 'zeroclick',
    surface: 'waiting_room',
  })

  useFreebuffCtrlCExit()

  const [exitHover, setExitHover] = useState(false)

  const isQueued = session?.status === 'queued'
  const accessTier =
    session && 'accessTier' in session ? session.accessTier : 'full'
  // 'none' = user hasn't joined any queue yet. We're in the pre-chat landing
  // state: show the picker with live N-in-line hints and a prompt. Picking a
  // model triggers joinFreebuffQueue, which POSTs and transitions us to
  // 'queued' (waiting room) or straight to 'active' (chat) if no wait.
  const isLanding = session?.status === 'none'
  // Elapsed-in-queue timer. Starts from `queuedAt` so it keeps ticking even if
  // the user wanders away and comes back. On the landing picker we tick once a
  // minute so the premium reset countdown stays fresh.
  const queuedAtMs = useMemo(() => {
    if (session?.status === 'queued') return Date.parse(session.queuedAt)
    return null
  }, [session])
  const now = useNow(isQueued ? 1000 : 60_000, isQueued || isLanding)
  const elapsedMs = queuedAtMs ? now - queuedAtMs : 0

  // Premium quota counter for the title line. All premium models share one
  // pool; the server replicates the same snapshot under each premium model
  // id, so any entry has the right count. Renders amber when exhausted so
  // the limit reads as "you've hit it" rather than just another count.
  const rateLimitsByModel = getRateLimitsByModel(session)
  const premiumRateLimit = rateLimitsByModel
    ? Object.values(rateLimitsByModel)[0]
    : undefined
  const sharedPremiumUsed = premiumRateLimit?.recentCount ?? 0
  const isPremiumExhausted =
    sharedPremiumUsed >=
    (accessTier === 'limited'
      ? FREEBUFF_LIMITED_SESSION_LIMIT
      : FREEBUFF_PREMIUM_SESSION_LIMIT)
  const premiumUsedColor = isPremiumExhausted ? theme.secondary : theme.muted
  // Pad the used count so the title's centered container doesn't shift width
  // as the count ticks from "0" → "1.3" → "2" while loading.
  const sessionLimit =
    accessTier === 'limited'
      ? FREEBUFF_LIMITED_SESSION_LIMIT
      : FREEBUFF_PREMIUM_SESSION_LIMIT
  // Limited-tier users don't see any premium models, so calling these "limited
  // sessions" leaks the tier name without informing the user — just "sessions"
  // reads naturally next to the count and reset countdown.
  const sessionLabel =
    accessTier === 'limited' ? 'sessions' : 'premium sessions'
  const sessionUnitWidth = String(sessionLimit).length + 2
  const formattedSharedPremiumUsed =
    formatSessionUnits(sharedPremiumUsed).padStart(sessionUnitWidth)
  const premiumResetAt = getFreebuffPremiumResetAt({
    rateLimitsByModel,
    nowMs: now,
  })
  const premiumResetAtMs = premiumResetAt.getTime()
  const premiumResetCountdown = formatFreebuffPremiumResetCountdown(
    premiumResetAt,
    now,
  )

  useEffect(() => {
    if (!isLanding || !premiumRateLimit) return

    const delayMs = Math.max(0, premiumResetAtMs - Date.now() + 1_000)
    const timer = setTimeout(() => {
      refreshFreebuffLandingMetadata().catch(() => {})
    }, delayMs)

    return () => clearTimeout(timer)
  }, [isLanding, premiumRateLimit, premiumResetAtMs])

  return (
    <box
      style={{
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        backgroundColor: theme.background,
      }}
    >
      {/* Top-right exit affordance so mouse users have a clear way out even
          when they don't know Ctrl+C works. width: '100%' is required for
          justifyContent: 'flex-end' to actually push the X to the right. */}
      <box
        style={{
          width: '100%',
          flexDirection: 'row',
          justifyContent: 'flex-end',
          paddingTop: 1,
          paddingRight: 2,
          flexShrink: 0,
        }}
      >
        <Button
          onClick={exitFreebuffCleanly}
          onMouseOver={() => setExitHover(true)}
          onMouseOut={() => setExitHover(false)}
          style={{ paddingLeft: 1, paddingRight: 1 }}
        >
          <text
            style={{ fg: exitHover ? theme.foreground : theme.muted }}
            attributes={TextAttributes.BOLD}
          >
            ✕
          </text>
        </Button>
      </box>

      <box
        style={{
          flexGrow: 1,
          flexDirection: 'column',
          alignItems: 'center',
          // flex-end so the logo + title + info clump sits just above the ad,
          // matching how chat anchors its header/messages to the input bar.
          justifyContent: 'flex-end',
          paddingLeft: 2,
          paddingRight: 2,
          paddingBottom: 1,
          gap: 1,
        }}
      >
        <box style={{ marginBottom: 1 }}>{logoComponent}</box>

        <box
          style={{
            flexDirection: 'column',
            alignItems: 'center',
            gap: 0,
            maxWidth: contentMaxWidth,
          }}
        >
          {error && (!session || session.status === 'none') && (
            <text style={{ fg: theme.secondary, wrapMode: 'word' }}>
              ⚠ {error}
            </text>
          )}

          {!session && !error && (
            <text style={{ fg: theme.muted }}>
              <ShimmerText text="Connecting…" />
            </text>
          )}

          {isLanding && accessTier === 'limited' && (
            <LimitedLandingPanel
              isQuotaExhausted={isPremiumExhausted}
              sessionCounter={
                <>
                  <span fg={premiumUsedColor}>
                    {formattedSharedPremiumUsed} of {sessionLimit}{' '}
                    {sessionLabel} used
                  </span>
                  <span fg={theme.muted}>
                    {'  ·  '}
                    resets in {premiumResetCountdown}
                  </span>
                </>
              }
            />
          )}

          {isLanding && accessTier !== 'limited' && (
            <box
              style={{
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 0,
              }}
            >
              <text style={{ marginBottom: 1, wrapMode: 'word' }}>
                <span fg={theme.foreground} attributes={TextAttributes.BOLD}>
                  Pick a model to start
                </span>
              </text>
              <text
                style={{ fg: theme.muted, marginBottom: 1, wrapMode: 'word' }}
              >
                <span fg={premiumUsedColor}>
                  {formattedSharedPremiumUsed} of {sessionLimit} {sessionLabel}{' '}
                  used
                </span>
                <span fg={theme.muted}>
                  {'  ·  '}
                  resets in {premiumResetCountdown}
                </span>
              </text>
              <FreebuffModelSelector />
            </box>
          )}

          {session?.status === 'takeover_prompt' && <TakeoverPrompt />}

          {isQueued && session && (
            <box
              style={{
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 0,
              }}
            >
              <text
                style={{ fg: theme.foreground, marginBottom: 1 }}
                attributes={TextAttributes.BOLD}
              >
                {session.position === 1
                  ? "You're next in line"
                  : "You're in the waiting room"}
              </text>

              <FreebuffModelSelector />

              <box
                style={{
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 0,
                  marginTop: 1,
                }}
              >
                <text style={{ fg: theme.foreground, alignSelf: 'flex-start' }}>
                  <span fg={theme.muted}>Position </span>
                  <span fg={theme.primary} attributes={TextAttributes.BOLD}>
                    {session.position}
                  </span>
                  <span fg={theme.muted}> / {session.queueDepth}</span>
                </text>
                <text style={{ fg: theme.muted, alignSelf: 'flex-start' }}>
                  <span>Wait </span>
                  {session.position === 1
                    ? 'any moment now'
                    : formatWait(session.estimatedWaitMs)}
                </text>
                <text style={{ fg: theme.muted, alignSelf: 'flex-start' }}>
                  <span>Elapsed </span>
                  {formatElapsed(elapsedMs)}
                </text>
              </box>
            </box>
          )}

          {/* Compatibility fallback for older servers without the session
              endpoint. This should not normally render because App.tsx treats
              it as admitted. */}
          {session?.status === 'disabled' && (
            <text style={{ fg: theme.muted }}>Session gate unavailable.</text>
          )}

          {/* Country outside the free-mode allowlist. Terminal — polling has
              stopped. Tell the user up front rather than letting them wait in
              the queue only to be rejected at the chat/completions gate. */}
          {session?.status === 'country_blocked' && (
            <>
              <text style={{ fg: theme.secondary, marginBottom: 1 }}>
                ⚠ Free mode isn't available in your region
              </text>
              <text style={{ fg: theme.muted, wrapMode: 'word' }}>
                {session.countryBlockReason === 'anonymous_network' ? (
                  <>
                    We detected{' '}
                    {formatPrivacySignalList(session.ipPrivacySignals)} traffic
                    {session.countryCode === 'UNKNOWN' ? (
                      ''
                    ) : (
                      <>
                        {' '}
                        from{' '}
                        <span fg={theme.foreground}>{session.countryCode}</span>
                      </>
                    )}
                    . Freebuff can't be used from anonymized networks. Press
                    Ctrl+C to exit.
                  </>
                ) : session.countryCode === 'UNKNOWN' ? (
                  <>
                    We couldn't verify an eligible location for this request.
                    VPN, Tor, proxy, or unknown-location traffic can't use
                    freebuff. Press Ctrl+C to exit.
                  </>
                ) : (
                  <>
                    We detected your location as{' '}
                    <span fg={theme.foreground}>{session.countryCode}</span>,
                    which is outside the countries where freebuff is currently
                    offered. Press Ctrl+C to exit.
                  </>
                )}
              </text>
            </>
          )}

          {/* Account banned. Terminal — polling has stopped. Blocking here
              stops banned bots from re-entering the queue every few seconds
              and inflating queueDepth between admission-tick sweeps. */}
          {session?.status === 'banned' && (
            <>
              <text style={{ fg: theme.secondary, marginBottom: 1 }}>
                ⚠ Account unavailable
              </text>
              <text style={{ fg: theme.muted, wrapMode: 'word' }}>
                This account has been suspended and can't use freebuff. If you
                think this is a mistake, contact support@codebuff.com. Press
                Ctrl+C to exit.
              </text>
            </>
          )}

          {/* Shared premium-session quota exhausted. Terminal for this run —
              the user can exit and come
              back once the daily Pacific reset passes. */}
          {session?.status === 'rate_limited' && (
            <>
              <text style={{ fg: theme.secondary, marginBottom: 1 }}>
                ⚠ Session limit reached
              </text>
              <text style={{ fg: theme.muted, wrapMode: 'word' }}>
                You've used{' '}
                <span fg={theme.foreground}>
                  {formatSessionUnits(session.recentCount)} of {session.limit}
                </span>{' '}
                {session.accessTier === 'limited'
                  ? 'sessions'
                  : 'premium sessions'}{' '}
                today. Try again in{' '}
                <span fg={theme.foreground}>
                  {formatRetryAfter(session.retryAfterMs)}
                </span>
                . Press Ctrl+C to exit.
              </text>
            </>
          )}
        </box>
      </box>

      {/* Reserve the ad banner slot before the async ad fetch resolves so the
          waiting-room content does not jump when the banner fills. */}
      <box
        style={{
          width: '100%',
          flexShrink: 0,
          height: CHOICE_AD_BANNER_HEIGHT,
        }}
      >
        {ads ? (
          <ChoiceAdBanner ads={ads} onImpression={recordImpression} />
        ) : (
          <text style={{ fg: theme.muted }}>{'─'.repeat(terminalWidth)}</text>
        )}
      </box>
    </box>
  )
}
