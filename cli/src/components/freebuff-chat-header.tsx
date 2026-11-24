import { FREEBUFF_AI_TRAINING_NOTICE } from '@codebuff/common/constants/freebuff-data-use'
import { FREEBUFF_ENABLE_STREAK_IN_UI } from '@codebuff/common/constants/freebuff-models'
import {
  dailyMeterQuiet,
  getReferralInfo,
  getGlmPromo,
  getSubscriptionInfo,
  getFreeWindowsInfo,
} from '@codebuff/common/types/freebuff-session'
import {
  freebuffPlanSummary,
  freebuffFreeWindowsSummary,
  formatPlanWindows,
} from '@codebuff/common/util/freebuff-plan-summary'

import {
  DisplayAdSplash,
  displayAdSplashVariant,
} from './display-ad-splash'
import {
  FreebuffPausedPlanNotice,
  freebuffPausedPlanMessage,
} from './freebuff-paused-plan-notice'
import { FreebuffReferralBanner } from './freebuff-referral-banner'
import {
  FREEBUFF_WORDMARK,
  FREEBUFF_WORDMARK_COMPACT,
} from '../utils/freebuff-wordmark'
import { CLI_DISPLAY_AD_PLACEMENT_IDS } from '../ads/display-ads'
import { useTheme } from '../hooks/use-theme'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { useFreebuffStreakQuery } from '../hooks/use-freebuff-streak-query'
import { useFreebuffModelDirectory } from '../state/freebuff-catalog-store'
import { useFreebuffModelStore } from '../state/freebuff-model-store'
import { useFreebuffChatStore } from '../state/freebuff-chat-store'
import { formatHours } from '@codebuff/common/util/freebuff-hours'
import { freebucksOf, freebucksRefundLine } from '../utils/freebucks'
import { getFreebuffStreakBonusNoteForLayout } from '../utils/freebuff-streak-line'
import { getFreebuffSessionModelAvailabilityNotice } from '@codebuff/common/util/freebuff-model-availability'
import type { FreebuffSessionResponse } from '../types/freebuff-session'

const ignoreFocusTargets = () => {}

const wordmarkVariants = [FREEBUFF_WORDMARK, FREEBUFF_WORDMARK_COMPACT].map(
  (text) => ({
    text,
    width: Math.max(...text.split('\n').map((line) => line.length)),
  }),
)

export function FreebuffChatHeader({
  session,
  lastRefund = null,
  refundPending = false,
}: {
  projectRoot: string
  session: FreebuffSessionResponse | null
  /** The ended hour's receipt, from `useFreebuffSession`. */
  lastRefund?: number | null
  refundPending?: boolean
}) {
  const theme = useTheme()
  const { terminalWidth, terminalHeight } = useTerminalDimensions()
  const selected = useFreebuffModelStore((s) => s.selectedModel)
  const nextModel = useFreebuffChatStore((s) => s.nextModel)
  const directory = useFreebuffModelDirectory()
  const model = directory.get(nextModel ?? selected)
  const freebucks = freebucksOf(session)
  // The session store clears the receipt the moment a new session goes
  // active, so this only ever describes the hour just finished.
  const refund = freebucksRefundLine(lastRefund, refundPending)
  const plan = freebuffPlanSummary(getSubscriptionInfo(session))
  const windows = freebuffFreeWindowsSummary(getFreeWindowsInfo(session))
  const streak = useFreebuffStreakQuery({
    enabled: FREEBUFF_ENABLE_STREAK_IN_UI,
  })
  const width = Math.max(16, Math.min(68, terminalWidth - 5))
  // Use the panel's padded width budget so the wordmark stays whole on resize.
  const wordmark =
    wordmarkVariants.find((variant) => variant.width <= width)?.text ?? 'Freebuff'
  const tier =
    session && 'accessTier' in session ? (session.accessTier ?? 'full') : 'full'
  const referral = getReferralInfo(session)
  // Limited access without a plan only, as on Desktop: before the session
  // loads, on a refusal, at full access or on a paid plan there is nothing to
  // explain, and the fallback told those users "on this connection".
  const availability =
    freebucks === undefined
      ? getFreebuffSessionModelAvailabilityNotice(session)
      : null
  const streakBonus = getFreebuffStreakBonusNoteForLayout({
    streak: streak.data?.streak ?? 0,
    accessTier: tier,
    freebucksDailyBonus: streak.data?.freebucksDailyBonus,
    terminalHeight,
    availableWidth: width - 4,
  })
  // The model's data-use line (as on web's picker): quiet, after the status
  // lines and before the referral pitch.
  const dataUse =
    model.warning ??
    (model.dataUse === 'training' ? FREEBUFF_AI_TRAINING_NOTICE : undefined)
  const lines = [
    freebuffPausedPlanMessage(session) && (
      <FreebuffPausedPlanNotice key="paused" session={session} />
    ),
    session?.status === 'active' && (
      <text key="session" style={{ fg: theme.muted, wrapMode: 'word' }}>
        {session.model === model.id
          ? 'Session active'
          : `Next message switches from ${directory.get(session.model).displayName}.`}
      </text>
    ),
    freebucks && !dailyMeterQuiet(freebucks) && (
      <text key="meter" style={{ fg: theme.foreground, wrapMode: 'word' }}>
        {`${formatHours(freebucks.daily.remaining)}/${formatHours(freebucks.daily.limit)} hours remaining`}
      </text>
    ),
    // The server's reason the pool is smaller than the account's own (a
    // device's shared allowance, the VPN pool). Without it a shared pool reads
    // "0/0 hours remaining" and looks like a broken account.
    freebucks && !dailyMeterQuiet(freebucks) && freebucks.daily.note && (
      <text key="note" style={{ fg: theme.muted, wrapMode: 'word' }}>
        {freebucks.daily.note}
      </text>
    ),
    freebucks === null && (
      <text key="balance" style={{ fg: theme.secondary }}>
        Balance unavailable
      </text>
    ),
    refund && (
      <text key="refund" style={{ fg: theme.secondary, wrapMode: 'word' }}>
        {refund}
      </text>
    ),
    plan && (
      <text key="plan" style={{ fg: theme.muted, wrapMode: 'word' }}>
        {freebucks === undefined
          ? `${plan.tierName} plan · ${formatPlanWindows(plan)}`
          : `${plan.tierName} plan`}
      </text>
    ),
    freebucks === undefined && windows && (
      <text key="windows" style={{ fg: theme.muted, wrapMode: 'word' }}>
        {windows.windows
          .map((w) => `${w.label} ${w.used} of ${w.limit}`)
          .join(' · ')}
      </text>
    ),
    availability && (
      <text key="availability" style={{ fg: theme.muted, wrapMode: 'word' }}>
        {availability}
      </text>
    ),
    FREEBUFF_ENABLE_STREAK_IN_UI && Boolean(streak.data?.streak) && (
      <text key="streak" style={{ fg: theme.primary }}>
        {`${streak.data!.streak} day streak`}
      </text>
    ),
    streakBonus && (
      <text key="bonus" style={{ fg: theme.muted, wrapMode: 'word' }}>
        {streakBonus}
      </text>
    ),
    dataUse && (
      <text key="data-use" style={{ fg: theme.muted, wrapMode: 'word' }}>
        {dataUse}
      </text>
    ),
  ].filter(Boolean)
  if (referral) {
    lines.push(
      <FreebuffReferralBanner
        key="referral"
        width={width - 4}
        referral={referral}
        glmPromo={getGlmPromo(session)}
        accessTier={tier}
        metered={freebucks !== undefined}
        flush={lines.length === 0}
        focusedId=""
        onFocusTargetsChange={ignoreFocusTargets}
      />,
    )
  }
  return (
    <box
      style={{
        flexDirection: 'column',
        alignItems: 'flex-start',
        width: '100%',
        marginBottom: 1,
      }}
    >
      <text style={{ fg: theme.foreground, wrapMode: 'none', marginBottom: 1 }}>
        {wordmark}
      </text>
      {/* Before the session loads, or with nothing to report, no empty frame. */}
      {lines.length > 0 && (
        <box
          style={{
            width,
            border: true,
            borderColor: theme.border,
            paddingLeft: 1,
            paddingRight: 1,
            flexDirection: 'column',
          }}
        >
          {lines}
        </box>
      )}
      <DisplayAdSplash
        width={width}
        variant={displayAdSplashVariant(terminalHeight)}
        placementId={CLI_DISPLAY_AD_PLACEMENT_IDS.cliSplash}
      />
    </box>
  )
}
