import { TextAttributes } from '@opentui/core'
import { useKeyboard, useRenderer } from '@opentui/react'
import React, { useCallback, useEffect, useRef, useState } from 'react'

import {
  FREEBUCKS_LABEL,
  FREEBUCKS_PICKER_NOTICE,
  formatAllowanceUsd,
  formatFreebucks,
  freebucksOf,
  freebucksPriceLabel,
} from '../utils/freebucks'
import { Button } from './button'
import { ChoiceAdBanner, AD_CARD_HEIGHT } from './ad-banner'
import { visibleWaitingRoomPlacementIds } from '@codebuff/common/ads/waiting-room-placements'
import { FreebucksIntroCard, useFreebucksIntro } from './freebucks-intro-card'
import { FreebuffModelSelector } from './freebuff-model-selector'
import { ShimmerText } from './shimmer-text'
import {
  refreshFreebuffLandingMetadata,
  takeOverFreebuffSession,
} from '../hooks/use-freebuff-session'
import { useFreebuffCtrlCExit } from '../hooks/use-freebuff-ctrl-c-exit'
import { useFreebuffStreakQuery } from '../hooks/use-freebuff-streak-query'
import { useGravityAd } from '../hooks/use-gravity-ad'
import { useLogo } from '../hooks/use-logo'
import { useNow } from '../hooks/use-now'
import { useSheenAnimation } from '../hooks/use-sheen-animation'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { useTheme } from '../hooks/use-theme'
import { exitCliCleanly } from '../utils/exit-cleanly'
import {
  formatFreebuffPremiumResetCountdown,
  getFreebuffPremiumResetAt,
} from '../utils/freebuff-premium-reset'
import {
  FREEBUFF_STREAK_INLINE_GAP,
  FREEBUFF_STREAK_LABEL_GAP,
  fitsFreebuffStreakOnHeadingRow,
  getFreebuffStreakBonusNoteForLayout,
  getFreebuffStreakLine,
} from '../utils/freebuff-streak-line'
import { formatSessionUnits } from '../utils/format-session-units'
import { isPlainEnterKey } from '../utils/terminal-enter-detection'
import { getLogoAccentColor, getLogoBlockColor } from '../utils/theme-system'
import { INVERTED_CTA_FG } from '../utils/ui-constants'
import {
  FREEBUFF_ENABLE_STREAK_IN_UI,
  FREEBUFF_LIMITED_SESSION_LIMIT,
  FREEBUFF_PREMIUM_SESSION_LIMIT,
} from '@codebuff/common/constants/freebuff-models'
import {
  getRateLimitsByModel,
  getReferralInfo,
} from '@codebuff/common/types/freebuff-session'
import {
  FREEBUFF_TIER_CHANGE_NOTICE,
  getFreebuffModelAvailabilityNotice,
} from '@codebuff/common/util/freebuff-model-availability'
import { formatFreebuffHardBlockedPrivacySignals } from '@codebuff/common/util/freebuff-privacy'

import type { FreebuffStreakLine } from '../utils/freebuff-streak-line'
import type { FreebuffSessionFailure } from '../state/freebuff-session-store'
import type { FreebuffSessionResponse } from '../types/freebuff-session'
import type { KeyEvent } from '@opentui/core'

interface FreebuffLandingScreenProps {
  session: FreebuffSessionResponse | null
  failure: FreebuffSessionFailure | null
  lastRefund: number | null
  refundPending: boolean
}

/** Landing-screen heading. Referenced both as rendered text and by the
 *  picker's height-budget math (wrappedRows), so it lives in one place to keep
 *  the two from drifting. */
const LANDING_HEADING = 'Start coding for free'
const COLLAPSED_LOGO_MIN_HEIGHT = 26

/** "in ~3h 20m" / "in ~45 min" / "in under a minute". Used on the
 *  rate-limited screen so users know when they can try again. */
const formatRetryAfter = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return 'any moment now'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  // The monthly allowance resets on the 1st: "622h 18m" is a number nobody
  // converts, "26 days" is a date.
  if (hours >= 48) return `${Math.round(hours / 24)} days`
  const rem = minutes % 60
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`
}

// Rendered directly under the model list — that's where "why these models?"
// gets asked. The copy itself is shared with Freebuff Desktop's model menu; see
// `getFreebuffModelAvailabilityNotice` for the tone rules it follows.
const getLimitedModeNotice = (
  session: FreebuffSessionResponse | null,
): string =>
  getFreebuffModelAvailabilityNotice(
    session && 'countryBlockReason' in session ? session : null,
  )

function getTakeoverErrorMessage(failure: FreebuffSessionFailure): string {
  if (failure.type === 'http' && failure.statusCode === 503) {
    return "Freebuff is busy and couldn't complete the takeover yet."
  }
  if (failure.type === 'timeout') {
    return failure.outcomeUnknown
      ? 'The takeover request timed out and may have succeeded. Check the warning, then retry if you still want to take over.'
      : failure.retry
        ? 'The takeover request timed out while Freebuff was busy.'
        : 'The takeover request timed out.'
  }
  if (failure.outcomeUnknown) {
    return "Freebuff couldn't confirm whether the takeover succeeded. Check the warning, then retry if you still want to take over."
  }
  return failure.message.trim()
    ? `Takeover failed: ${failure.message}`
    : 'The takeover failed unexpectedly.'
}

export const TakeoverPrompt: React.FC<{
  failure: FreebuffSessionFailure | null
  onTakeOver?: () => Promise<void>
}> = ({ failure, onTakeOver = takeOverFreebuffSession }) => {
  const theme = useTheme()
  const [pending, setPending] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState(0) // 0 = Take over, 1 = Exit
  const takeoverInFlightRef = useRef(false)
  const retry = failure?.retry ?? null
  const retryTick = useNow(1_000, retry !== null)
  // `useNow` freezes while disabled. Use the current time when a retry first
  // appears so a long-open prompt cannot render a stale countdown for a frame.
  const retryNow = retry ? Math.max(retryTick, Date.now()) : retryTick
  const retrySeconds = retry
    ? Math.max(0, Math.ceil((retry.retryAtMs - retryNow) / 1_000))
    : 0
  const outcomeUnknown = failure?.outcomeUnknown ?? false
  const blocked = pending
  const displayError = failure ? getTakeoverErrorMessage(failure) : null

  const handleTakeover = useCallback(async () => {
    // `pending` updates on the next render. The ref closes the gap where two
    // keyboard/mouse events arrive in the same frame and would both POST.
    if (takeoverInFlightRef.current) return
    takeoverInFlightRef.current = true
    setPending(true)
    try {
      await onTakeOver()
    } finally {
      takeoverInFlightRef.current = false
      setPending(false)
    }
  }, [onTakeOver])

  useKeyboard(
    useCallback(
      (key: KeyEvent) => {
        const name = key.name ?? ''
        const isConfirm = isPlainEnterKey(key)
        const isExit = name === 'escape' || name === 'esc'
        const isTab = name === 'tab'
        const isShiftTab = key.shift === true && isTab
        const isRight = name === 'right'
        const isLeft = name === 'left'

        if (isExit) {
          key.preventDefault?.()
          void exitCliCleanly()
          return
        }

        if (isConfirm) {
          key.preventDefault?.()
          if (focusedIndex === 0) {
            void handleTakeover()
          } else {
            void exitCliCleanly()
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
  const takeoverLabel = pending
    ? 'Taking over...'
    : outcomeUnknown
      ? 'Try takeover again'
      : retry
        ? 'Retry now'
        : 'Take over'
  const takeoverForeground = blocked
    ? theme.muted
    : isTakeoverFocused
      ? INVERTED_CTA_FG
      : theme.foreground

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

      {displayError && (
        <text style={{ fg: theme.secondary, wrapMode: 'word' }}>
          ⚠ {displayError}
        </text>
      )}

      {retry && (
        <text style={{ fg: theme.muted }}>
          {retrySeconds > 0
            ? `Retrying automatically in ${retrySeconds}s (attempt ${retry.attempt}).`
            : `Retrying automatically now (attempt ${retry.attempt}).`}
        </text>
      )}

      <box style={{ flexDirection: 'row', gap: 2, marginTop: 1 }}>
        <Button
          onClick={blocked ? undefined : handleTakeover}
          onMouseOver={() => setFocusedIndex(0)}
          style={{ paddingLeft: 1, paddingRight: 1 }}
          border={['top', 'bottom', 'left', 'right']}
          borderStyle="single"
          borderColor={blocked ? theme.muted : theme.primary}
        >
          <text
            style={{
              // theme.background is 'transparent' and can't serve as inverted
              // text — on the green fill it renders the label invisible.
              fg: takeoverForeground,
              bg: isTakeoverFocused && !blocked ? theme.primary : undefined,
            }}
            attributes={TextAttributes.BOLD}
          >
            {takeoverLabel}
          </text>
        </Button>
        <Button
          onClick={() => exitCliCleanly()}
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

/** "N day streak" then its progress dots, as spans so both placements (beside
 *  the heading, or its own line under it) draw the streak identically. */
const streakSpans = (
  line: FreebuffStreakLine,
  theme: ReturnType<typeof useTheme>,
) => [
  <span key="label" fg={theme.foreground}>
    {line.label}
  </span>,
  <span key="dots" fg={theme.primary}>
    {`${' '.repeat(FREEBUFF_STREAK_LABEL_GAP)}${line.dots}`}
  </span>,
]

/** Streak on its own line under the heading, for terminals too narrow to
 *  share the row. For streak === 0 the line is rendered blank so new / lapsed
 *  users are nudged to start using the product rather than shown an empty
 *  streak (and so the picker doesn't jump once they earn their first day). */
const StreakInlineLine: React.FC<{
  line: FreebuffStreakLine | null
}> = ({ line }) => {
  const theme = useTheme()

  if (!line) {
    return <text style={{ flexShrink: 0 }}> </text>
  }

  return (
    <text style={{ flexShrink: 0, wrapMode: 'none' }}>
      {streakSpans(line, theme)}
    </text>
  )
}

/** Heading row: the title, with the streak beside it when the caller passes
 *  one (only when it fits — see fitsFreebuffStreakOnHeadingRow).
 *
 *  Deliberately ONE text rather than a space-between flex row. The row this
 *  replaces put the two in a stretched row inside a shrink-to-fit column,
 *  which had two problems: with nothing wider on screen there was no free
 *  space to distribute, so the two rendered flush ("Start coding for
 *  free18 day streak"), and a space-between row whose content overflows its
 *  container segfaults the renderer — reachable by dragging the terminal
 *  narrower, since the native layout runs against the old tree before React
 *  re-renders. A single text just wraps, and the gap is explicit.
 *
 *  Exported for the layout test. */
export const LandingHeadingRow: React.FC<{
  streakLine: FreebuffStreakLine | null
  marginBottom: number
}> = ({ streakLine, marginBottom }) => {
  const theme = useTheme()

  return (
    <text style={{ marginBottom, wrapMode: 'word' }}>
      <span fg={theme.foreground} attributes={TextAttributes.BOLD}>
        {LANDING_HEADING}
      </span>
      {streakLine && [
        <span key="gap">{' '.repeat(FREEBUFF_STREAK_INLINE_GAP)}</span>,
        ...streakSpans(streakLine, theme),
      ]}
    </text>
  )
}

export const FreebuffLandingScreen: React.FC<FreebuffLandingScreenProps> = ({
  session,
  failure,
  lastRefund,
  refundPending,
}) => {
  const theme = useTheme()
  const renderer = useRenderer()
  const { terminalWidth, terminalHeight, contentMaxWidth } =
    useTerminalDimensions()

  // Progressive disclosure as the terminal gets shorter. The picker is the
  // only thing the user must be able to reach, so chrome is shed first:
  //   tall   (>=40): full 6-line ASCII logo + roomy spacing, content anchored low
  //   shorter      : no logo — the heading already identifies the experience
  //   tiny   (<18) : also drop the ad banner
  // The big logo is reserved for genuinely tall windows; at the common ~30-row
  // height we hide the branding so more models fit without scrolling.
  // Section headers always show — the picker scrolls within whatever rows
  // remain (see selectorMaxHeight below), so there's no need to hide them.
  //
  // Exception: when the picker is collapsed it shrinks to ~5 rows, freeing the
  // ~6 rows the big logo needs. So on a mid-height window with a collapsed,
  // referral-free picker we still show the full ASCII logo — it fills what
  // would otherwise be dead space above the card. A referral card or expanded
  // list gives those rows back to the scrollable menu. 26 is the smallest
  // window where the logo block,
  // heading, collapsed picker, streak, and ad all coexist without scrolling.
  //
  // The picker (rendered below) owns this and reports it via onExpandedChange;
  // we default to collapsed so the first paint reserves logo space correctly.
  const [selectorExpanded, setSelectorExpanded] = useState(false)
  const hasReferralMenu =
    session?.status === 'none' && Boolean(getReferralInfo(session))
  const logoHeightFits =
    terminalHeight >= 40 ||
    (!selectorExpanded &&
      !hasReferralMenu &&
      terminalHeight >= COLLAPSED_LOGO_MIN_HEIGHT)
  const compact = terminalHeight < 22
  const showAds = terminalHeight >= 18
  const textMarginBottom = 1

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
  const { component: logoComponent, textBlock: logoTextBlock } = useLogo({
    availableWidth: contentMaxWidth,
    accentColor,
    blockColor,
    applySheenToChar,
  })
  // useLogo falls back to a one-line brand label when the ASCII variants do
  // not fit horizontally. This landing screen intentionally hides that label.
  const showFullLogo = logoHeightFits && logoTextBlock.length > 0

  // Always enable ads on the landing screen — this is where monetization lives.
  // forceStart bypasses the "wait for first user message" gate inside the hook,
  // which would otherwise block ads here since no conversation exists yet.
  // The server tries Gravity first, then falls back to ZeroClick and Carbon.
  const waitingRoomPlacementIds = visibleWaitingRoomPlacementIds(terminalWidth)
  const { ads, recordClick, recordImpression } = useGravityAd({
    enabled: true,
    forceStart: true,
    provider: 'gravity',
    // Legacy wire name for this surface — the ads API maps it to placements,
    // so it must not change with the component rename.
    surface: 'waiting_room',
    placementIds: waitingRoomPlacementIds,
  })

  useFreebuffCtrlCExit()

  const [exitHover, setExitHover] = useState(false)

  const accessTier =
    session && 'accessTier' in session ? session.accessTier : 'full'
  // Answers "why these models?". The two tiers ask different versions of it:
  // limited asks why the catalog is small; full asks which rows are metered.
  //
  // Never both — a limited-tier user has no premium pool, so the full-tier line
  // would describe an account they do not have.
  //
  // Hidden in compact terminals either way: nice-to-have context, and below 22
  // rows every line competes with the picker itself.
  // On the meter the tier notices describe pools that no longer gate ("your
  // shared premium allowance"), so the line says how sessions are priced
  // instead.
  const belowPickerNotices = compact
    ? []
    : freebucksOf(session)
      ? [FREEBUCKS_PICKER_NOTICE]
      : accessTier === 'limited'
        ? [getLimitedModeNotice(session)]
        : [FREEBUFF_TIER_CHANGE_NOTICE]
  // 'none' = user hasn't started a session yet. We're in the pre-chat landing
  // state: show the picker with a prompt. Picking a model triggers
  // startFreebuffSession, which POSTs and transitions straight to 'active' (chat).
  const isLanding = session?.status === 'none'
  // The one-time Freebucks introduction, only where the picker itself is on
  // screen and only where it fits: on a short terminal it would push the
  // picker off the bottom, and an unseen card is shown on the next launch
  // instead (it is marked seen only when it becomes visible, so a launch that
  // lands on a wall instead of the picker must not consume it). Held here
  // rather than inside the card so the picker below can be told to ignore the
  // key that dismisses it — see `useFreebucksIntro`.
  const freebucksIntro = useFreebucksIntro(
    isLanding && terminalHeight >= 30 && freebucksOf(session) !== undefined,
  )
  // On the meter, nothing below counts sessions.
  const metered = freebucksOf(session) !== undefined
  const streakQuery = useFreebuffStreakQuery({
    enabled: FREEBUFF_ENABLE_STREAK_IN_UI && isLanding,
  })
  const streak = streakQuery.data?.streak ?? 0
  // The indicator normally shares the heading row, so keep its slot even in
  // compact-height terminals. It renders blank space until a streak is active.
  const showStreakIndicator = FREEBUFF_ENABLE_STREAK_IN_UI && isLanding
  // Once a full week is earned, explain the recurring perk under the picker so
  // the streak reads as worth keeping. Pre-milestone countdown copy stays
  // hidden; this dedicated row is only for a bonus the user has already earned.
  const streakBonusNote = showStreakIndicator
    ? getFreebuffStreakBonusNoteForLayout({
        streak,
        accessTier: accessTier === 'limited' ? 'limited' : 'full',
        terminalHeight,
        availableWidth: contentMaxWidth,
      })
    : null
  // On the landing screen the streak rides on the heading row, a fixed gap
  // after the title. Measured against the real strings (the label grows with
  // the day count), so
  // a streak that can't clear the inline gap drops to its own line under the
  // heading instead of colliding with it. With no streak yet, the day-one line
  // stands in, reserving the slot where the streak will land.
  const streakLine = showStreakIndicator ? getFreebuffStreakLine(streak) : null
  const streakOnHeadingRow =
    showStreakIndicator &&
    fitsFreebuffStreakOnHeadingRow({
      line: streakLine,
      headingWidth: LANDING_HEADING.length,
      availableWidth: contentMaxWidth,
    })
  // On the landing picker we tick once a minute so the session reset countdown
  // stays fresh.
  const now = useNow(60_000, isLanding)

  // Free-session quota counter for the title line. All free models share one
  // pool; the server replicates the same snapshot under each free model
  // id, so any entry has the right count. Renders amber when exhausted so
  // the limit reads as "you've hit it" rather than just another count.
  const rateLimitsByModel = getRateLimitsByModel(session)
  const sessionRateLimit = rateLimitsByModel
    ? Object.values(rateLimitsByModel)[0]
    : undefined
  const sharedSessionUsed = sessionRateLimit?.recentCount ?? 0
  // Hide the "0 of N … used" line entirely for a fresh user — a zeroed counter
  // is noise on the landing screen. It appears once any session is consumed.
  //
  // For the regular tiers the PREMIUM section header inside the expanded
  // picker carries this quota inline, so the below-picker line survives for
  // the limited tier (which has no premium section to host it) and for the
  // collapsed picker. When the collapsed recommended hero is a premium model
  // (getRecommendedFreebuffModelId, while the pool has sessions left) the count
  // is exactly what Enter is about to spend.
  const showSessionCounter = sharedSessionUsed > 0 && !metered
  const showBelowPickerCounter =
    showSessionCounter && (accessTier === 'limited' || !selectorExpanded)
  // Prefer the server-sent limit (base + streak/referral bonuses) so the
  // counter and its amber exhausted cue match what admission will enforce;
  // the static constants only cover the pre-snapshot fallback.
  const sessionLimit =
    sessionRateLimit?.limit ??
    (accessTier === 'limited'
      ? FREEBUFF_LIMITED_SESSION_LIMIT
      : FREEBUFF_PREMIUM_SESSION_LIMIT)
  const isSessionExhausted = sharedSessionUsed >= sessionLimit
  const sessionUsedColor = isSessionExhausted ? theme.secondary : theme.muted
  const sessionLabel =
    accessTier === 'limited' ? 'sessions' : 'premium sessions'
  const formattedSharedSessionUsed = formatSessionUnits(sharedSessionUsed)
  const sessionResetAt = getFreebuffPremiumResetAt({
    rateLimitsByModel,
    nowMs: now,
  })
  const sessionResetAtMs = sessionResetAt.getTime()
  const sessionResetCountdown = formatFreebuffPremiumResetCountdown(
    sessionResetAt,
    now,
  )

  // Rows the picker may occupy = terminal height minus the fixed chrome
  // around it. Each term mirrors the real layout exactly (no padded
  // estimate, no blanket safety row) so the scrollbox fills the available
  // space with no dead band below it:
  //   - top bar: paddingTop 1 + the ✕ row = 2
  //   - ad banner: AD_CARD_HEIGHT, only when shown
  //   - main box: paddingBottom 1
  //   - logo block: lines + marginBottom 1 (always, when shown) + gap (full)
  //   - the prompt/counter (landing)
  // Line wrapping is derived from the actual strings vs contentMaxWidth, so
  // a wrapped counter is accounted for precisely instead of guessed at.
  const wrappedRows = (text: string) =>
    Math.max(1, Math.ceil(text.length / contentMaxWidth))
  const logoBlockRows = showFullLogo
    ? 8 /* 6 logo lines + marginBottom + gap */
    : 0
  const adRows = showAds ? AD_CARD_HEIGHT : 0
  // Status lines render below the picker, each with marginTop 1: the
  // limited-mode notice, then the streak. They still eat into the picker's
  // height budget regardless of being above or below it. (The session counter
  // used to sit here too; it now rides inside the selector — see below.)
  // Placement varies: on a wide landing screen the streak shares
  // the heading row (0 extra rows, already counted in landingTextRows); on a
  // narrow landing screen it drops to its own line under the heading (1 row,
  // no top margin).
  const streakRows = !showStreakIndicator ? 0 : streakOnHeadingRow ? 0 : 1
  const noticeRows = belowPickerNotices.reduce(
    (rows, notice) => rows + 1 /* marginTop */ + wrappedRows(notice),
    0,
  )
  // Earned streak perk note: one marginTop row + wrap.
  const streakBonusRows = streakBonusNote
    ? 1 /* marginTop */ + wrappedRows(streakBonusNote)
    : 0
  // The referral/GLM card and the session counter both live inside the model
  // selector's scrollbox now (the counter rides `belowToggle`, between the
  // expand toggle and the referral pitch), so only genuinely fixed status
  // lines below the selector reduce its viewport. Anything inside the
  // scrollbox is measured by the selector itself and must NOT be reserved
  // here as well, or the viewport shrinks while the content grows.
  const belowPickerRows = streakRows + noticeRows + streakBonusRows
  const reservedChrome = 2 + adRows + 1 /* main paddingBottom */ + logoBlockRows
  const landingTextRows =
    wrappedRows(LANDING_HEADING) + textMarginBottom + belowPickerRows
  // Floor = one whole recommended card: 2 border rows + its 2 text lines (name
  // + tagline, then the AI-training warning on its own line). Rows grew from
  // one text line to two when the warning stopped inlining, so the old floor of
  // 3 left the card's bottom border clipped on a very short terminal. (The
  // warning itself stays visible either way — scrollTop starts at 0, so it is
  // the last row that gets cut, not the first.)
  const MIN_SELECTOR_ROWS = 4
  const selectorMaxHeight = Math.max(
    MIN_SELECTOR_ROWS,
    terminalHeight - reservedChrome - landingTextRows,
  )

  useEffect(() => {
    if (!isLanding || !sessionRateLimit) return

    const delayMs = Math.max(0, sessionResetAtMs - Date.now() + 1_000)
    const timer = setTimeout(() => {
      refreshFreebuffLandingMetadata().catch(() => {})
    }, delayMs)

    return () => clearTimeout(timer)
  }, [isLanding, sessionRateLimit, sessionResetAtMs])

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
          justifyContent to actually push the X to the right. */}
      <box
        style={{
          width: '100%',
          flexDirection: 'row',
          justifyContent: 'space-between',
          paddingTop: 1,
          paddingLeft: 2,
          paddingRight: 2,
          flexShrink: 0,
        }}
      >
        {/* Empty spacer: justifyContent space-between needs a left sibling to
            keep the ✕ pushed to the right. */}
        <box />
        <Button
          onClick={() => exitCliCleanly()}
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
          // Full logo: anchor the clump low (flex-end), matching how chat pins
          // its header/messages to the input bar. Without a logo, hug the top
          // so the freed rows remain available to the picker.
          justifyContent: showFullLogo ? 'flex-end' : 'flex-start',
          paddingLeft: 2,
          paddingRight: 2,
          paddingBottom: 1,
          gap: showFullLogo ? 1 : 0,
        }}
      >
        {showFullLogo && (
          <box style={{ marginBottom: 1, flexShrink: 0 }}>{logoComponent}</box>
        )}

        <box
          style={{
            flexDirection: 'column',
            alignItems: 'center',
            gap: 0,
            maxWidth: contentMaxWidth,
          }}
        >
          {failure && (!session || session.status === 'none') && (
            <text style={{ fg: theme.secondary, wrapMode: 'word' }}>
              ⚠ {failure.message}
            </text>
          )}

          {refundPending && (
            <text style={{ fg: theme.secondary, wrapMode: 'word' }}>
              Your refund is awaiting final usage. Once settled, it will appear
              in your wallet.
            </text>
          )}
          {lastRefund !== null && (
            <text style={{ fg: theme.secondary, wrapMode: 'word' }}>
              {lastRefund} {lastRefund === 1 ? 'Freebuck' : FREEBUCKS_LABEL}{' '}
              returned to your wallet.
            </text>
          )}

          {!session && !failure && (
            <text style={{ fg: theme.muted }}>
              <ShimmerText text="Connecting…" />
            </text>
          )}

          {isLanding && (
            <box
              style={{
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 0,
              }}
            >
              {freebucksIntro.visible && (
                <FreebucksIntroCard
                  width={Math.min(contentMaxWidth, 72)}
                  onDismiss={freebucksIntro.dismiss}
                />
              )}
              <LandingHeadingRow
                streakLine={streakOnHeadingRow ? streakLine : null}
                marginBottom={textMarginBottom}
              />
              {showStreakIndicator && !streakOnHeadingRow && (
                <StreakInlineLine line={streakLine} />
              )}
              <FreebuffModelSelector
                maxHeight={selectorMaxHeight}
                onExpandedChange={setSelectorExpanded}
                // The intro card owns the keyboard while it is up: its "press
                // any key" must not also commit the focused row.
                keyboardSuspended={freebucksIntro.visible}
                belowToggle={
                  showBelowPickerCounter ? (
                    <text
                      style={{
                        fg: theme.muted,
                        marginTop: 1,
                        wrapMode: 'word',
                      }}
                    >
                      <span fg={sessionUsedColor}>
                        {formattedSharedSessionUsed} of {sessionLimit}{' '}
                        {sessionLabel} used
                      </span>
                      <span fg={theme.muted}>
                        {', '}
                        resets in {sessionResetCountdown}
                      </span>
                    </text>
                  ) : null
                }
              />
              {/* Muted, never amber: a reduced catalog and a paused model are
                  both things we did, not problems with this user's account. */}
              {belowPickerNotices.map((notice) => (
                <text
                  key={notice}
                  style={{ fg: theme.muted, wrapMode: 'word', marginTop: 1 }}
                >
                  {notice}
                </text>
              ))}
              {streakBonusNote && (
                <text
                  style={{ fg: theme.primary, wrapMode: 'word', marginTop: 1 }}
                >
                  {streakBonusNote}
                </text>
              )}
            </box>
          )}

          {session?.status === 'takeover_prompt' && (
            <TakeoverPrompt failure={failure} />
          )}

          {/* Country outside the free-mode allowlist. Terminal — polling has
              stopped. Tell the user up front rather than letting them send a
              request that the chat/completions gate would reject. */}
          {session?.status === 'country_blocked' && (
            <>
              <text style={{ fg: theme.secondary, marginBottom: 1 }}>
                ⚠ Free mode isn't available in your region
              </text>
              <text style={{ fg: theme.muted, wrapMode: 'word' }}>
                {session.countryBlockReason === 'anonymous_network' ? (
                  <>
                    We detected{' '}
                    {formatFreebuffHardBlockedPrivacySignals(
                      session.ipPrivacySignals,
                    )}{' '}
                    traffic
                    {session.countryCode === 'UNKNOWN' ? (
                      ''
                    ) : (
                      <>
                        {' '}
                        from{' '}
                        <span fg={theme.foreground}>{session.countryCode}</span>
                      </>
                    )}
                    . Freebuff can't be used from VPN, proxy, or Tor traffic.
                    Disable it and restart Freebuff to try again.
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
              stops banned bots from re-entering free mode. */}
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

          {/* Shared free-session quota exhausted. Terminal for this run —
              the user can exit and return after its daily or weekly reset. */}
          {session?.status === 'rate_limited' && (
            <>
              <text style={{ fg: theme.secondary, marginBottom: 1 }}>
                {session.freebucksShortfall
                  ? `⚠ Not enough ${FREEBUCKS_LABEL}`
                  : metered && session.period === 'pacific_month'
                    ? '⚠ Monthly usage limit reached'
                    : '⚠ Session limit reached'}
              </text>
              {/* THE METER'S REFUSAL, when the server sent one.
                  
                  `freebucksShortfall` is what distinguishes "you are out of
                  Freebucks" from "you have used your sessions", and the two
                  want completely different sentences: the counts on this
                  response are shaped like a session pool for older clients,
                  so rendering them here would tell a metered user they had
                  spent N of M sessions — a meter they are no longer on.

                  The monthly wall arrives in the SAME shape with no shortfall
                  attached and `period: 'pacific_month'`, which is why the
                  period copy below still has to be right: telling somebody to
                  come back at midnight for an allowance that returns on the
                  1st sends them back to the same wall in the morning. */}
              {session.freebucksShortfall ? (
                <text style={{ fg: theme.muted, wrapMode: 'word' }}>
                  This model costs{' '}
                  <span fg={theme.foreground}>
                    {freebucksPriceLabel(session.freebucksShortfall.price)}
                  </span>
                  , and you have{' '}
                  <span fg={theme.foreground}>
                    {formatFreebucks(session.freebucksShortfall.balance)}
                  </span>{' '}
                  left. More in{' '}
                  <span fg={theme.foreground}>
                    {formatRetryAfter(session.retryAfterMs)}
                  </span>
                  , or pick a cheaper model. Press Ctrl+C to exit.
                </text>
              ) : metered && session.period === 'pacific_month' ? (
                // The monthly dollar allowance, sent in CENTS in the pool's
                // shape (`limit`/`recentCount`) so older clients still count
                // it — rendered here as the dollars it is.
                <text style={{ fg: theme.muted, wrapMode: 'word' }}>
                  You've used{' '}
                  <span fg={theme.foreground}>
                    {formatAllowanceUsd(session.recentCount / 100)} of{' '}
                    {formatAllowanceUsd(session.limit / 100)}
                  </span>{' '}
                  monthly usage. It resets in{' '}
                  <span fg={theme.foreground}>
                    {formatRetryAfter(session.retryAfterMs)}
                  </span>
                  . Press Ctrl+C to exit.
                </text>
              ) : (
                <text style={{ fg: theme.muted, wrapMode: 'word' }}>
                  You've used{' '}
                  <span fg={theme.foreground}>
                    {formatSessionUnits(session.recentCount)} of {session.limit}
                  </span>{' '}
                  {session.period === 'pacific_month' ? 'this month' : 'sessions'}{' '}
                  {session.period === 'pacific_month'
                    ? ''
                    : session.period === 'pacific_week'
                      ? 'this week'
                      : 'today'}
                  . Try again in{' '}
                  <span fg={theme.foreground}>
                    {formatRetryAfter(session.retryAfterMs)}
                  </span>
                  . Press Ctrl+C to exit.
                </text>
              )}
              {/* The paywall half (2026-09-01): the server's structured hint
                  when it sent one, the plans page otherwise — a quota wall is
                  never a dead end. */}
              <text style={{ fg: theme.muted, wrapMode: 'word', marginTop: 1 }}>
                {'upgrade' in session && session.upgrade
                  ? `${session.upgrade.message} ${session.upgrade.url}`
                  : metered
                    ? 'Get more Freebucks with a plan: https://freebuff.com/plans'
                    : 'Get more sessions with a plan: https://freebuff.com/plans'}
              </text>
            </>
          )}

          {/* Daily provider-spend admission budget reached. Existing sessions
              are never interrupted; this screen only follows a rejected fresh
              admission and gives the user a friendly, concrete return time. */}
          {session?.status === 'spend_limited' && (
            <>
              <text style={{ fg: theme.secondary, marginBottom: 1 }}>
                {metered ? '☕ Daily usage cap reached' : '☕ Daily Freebuff limit reached'}
              </text>
              <text style={{ fg: theme.muted, wrapMode: 'word' }}>
                {session.message} It resets in{' '}
                <span fg={theme.foreground}>
                  {formatRetryAfter(session.retryAfterMs)}
                </span>
                , at midnight Pacific. Press Ctrl+C to exit.
              </text>
              <text style={{ fg: theme.muted, wrapMode: 'word', marginTop: 1 }}>
                {'upgrade' in session && session.upgrade
                  ? `${session.upgrade.message} ${session.upgrade.url}`
                  : metered
                    ? 'A plan raises the daily cap: https://freebuff.com/plans'
                    : 'Get more sessions with a plan: https://freebuff.com/plans'}
              </text>
            </>
          )}

          {/* Too many distinct users hold a free session on this egress IP.
              Unlike the quota screens above there is no reset time — a slot
              frees as soon as any session on the IP ends — so this offers a
              short retry rather than a "come back tomorrow". */}
          {session?.status === 'ip_capped' && (
            <>
              <text style={{ fg: theme.secondary, marginBottom: 1 }}>
                🚦 Too many Freebuff sessions on this network
              </text>
              <text style={{ fg: theme.muted, wrapMode: 'word' }}>
                {session.activeUsersForIp} other people are already using
                Freebuff from your network, which is the most we allow at once.
                Try again in{' '}
                <span fg={theme.foreground}>
                  {formatRetryAfter(session.retryAfterMs)}
                </span>
                {' — '}a slot opens as soon as one of them finishes. Press
                Ctrl+C to exit.
              </text>
            </>
          )}
        </box>
      </box>

      {/* Reserve the ad banner slot before the async ad fetch resolves so the
          landing content does not jump when the banner fills. On very
          short terminals the banner is dropped entirely to give the picker
          back its 5 rows. */}
      {showAds && (
        <box
          style={{
            width: '100%',
            flexShrink: 0,
            height: AD_CARD_HEIGHT,
          }}
        >
          {ads ? (
            <ChoiceAdBanner
              ads={ads}
              placementIds={waitingRoomPlacementIds}
              onClick={recordClick}
              onImpression={recordImpression}
            />
          ) : (
            <text style={{ fg: theme.muted }}>{'─'.repeat(terminalWidth)}</text>
          )}
        </box>
      )}
    </box>
  )
}
