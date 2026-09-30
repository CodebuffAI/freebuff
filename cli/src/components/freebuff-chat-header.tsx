import { FREEBUFF_ENABLE_STREAK_IN_UI } from '@codebuff/common/constants/freebuff-models'
import {
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

import { FreebuffReferralBanner } from './freebuff-referral-banner'
import {
  FREEBUFF_WORDMARK,
  FREEBUFF_WORDMARK_COMPACT,
} from '../utils/freebuff-wordmark'
import { useTheme } from '../hooks/use-theme'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { useFreebuffStreakQuery } from '../hooks/use-freebuff-streak-query'
import { useFreebuffModelDirectory } from '../state/freebuff-catalog-store'
import { useFreebuffModelStore } from '../state/freebuff-model-store'
import {
  useFreebuffChatStore,
  selectFreebuffChatModel,
} from '../state/freebuff-chat-store'
import { freebucksOf, formatFreebucks } from '../utils/freebucks'
import {
  getFreebuffStreakBonusNoteForLayout,
  getFreebuffStreakBonusStatusForLayout,
} from '../utils/freebuff-streak-line'
import { getFreebuffModelAvailabilityNotice } from '@codebuff/common/util/freebuff-model-availability'
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
}: {
  projectRoot: string
  session: FreebuffSessionResponse | null
}) {
  const theme = useTheme()
  const { terminalWidth, terminalHeight } = useTerminalDimensions()
  const selected = useFreebuffModelStore((s) => s.selectedModel)
  const nextModel = useFreebuffChatStore((s) => s.nextModel)
  const directory = useFreebuffModelDirectory()
  const model = directory.get(nextModel ?? selected)
  const freebucks = freebucksOf(session)
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
  const availability =
    freebucks === undefined
      ? getFreebuffModelAvailabilityNotice(
          session && 'countryBlockReason' in session ? session : null,
        )
      : ''
  const streakBonus = getFreebuffStreakBonusNoteForLayout({
    streak: streak.data?.streak ?? 0,
    accessTier: tier,
    freebucksDailyBonus: streak.data?.freebucksDailyBonus,
    terminalHeight,
    availableWidth: width - 4,
  })
  const streakBonusStatus = getFreebuffStreakBonusStatusForLayout({
    note: streakBonus,
    streak: streak.data,
    availableWidth: width - 4,
  })
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
        {model.warning && (
          <text style={{ fg: theme.secondary, wrapMode: 'word' }}>
            {model.warning}
          </text>
        )}
        <text style={{ fg: theme.muted, wrapMode: 'word' }}>
          {session?.status === 'active'
            ? session.model === model.id
              ? 'Session active'
              : `Next message switches from ${directory.get(session.model).displayName}.`
            : 'Your first message starts the session.'}
        </text>
        {freebucks && (
          <text style={{ fg: theme.foreground, wrapMode: 'word' }}>
            {`${formatFreebucks(freebucks.daily.remaining)}/${formatFreebucks(freebucks.daily.limit)} Freebucks remaining`}
          </text>
        )}
        {freebucks === null && (
          <text style={{ fg: theme.secondary }}>Balance unavailable</text>
        )}
        {plan && (
          <text style={{ fg: theme.muted, wrapMode: 'word' }}>
            {freebucks === undefined
              ? `${plan.tierName} plan · ${formatPlanWindows(plan)}`
              : `${plan.tierName} plan`}
          </text>
        )}
        {freebucks === undefined && windows && (
          <text style={{ fg: theme.muted, wrapMode: 'word' }}>
            {windows.windows
              .map((w) => `${w.label} ${w.used} of ${w.limit}`)
              .join(' · ')}
          </text>
        )}
        {availability && (
          <text style={{ fg: theme.muted, wrapMode: 'word' }}>
            {availability}
          </text>
        )}
        {FREEBUFF_ENABLE_STREAK_IN_UI && Boolean(streak.data?.streak) && (
          <text
            style={{ fg: theme.primary }}
          >{`${streak.data!.streak} day streak`}</text>
        )}
        {streakBonus && (
          <text style={{ fg: theme.muted, wrapMode: 'word' }}>
            {streakBonus}
          </text>
        )}
        {streakBonusStatus && (
          <text style={{ fg: theme.muted, wrapMode: 'word' }}>
            {streakBonusStatus}
          </text>
        )}
        {referral && (
          <FreebuffReferralBanner
            width={width - 4}
            referral={referral}
            glmPromo={getGlmPromo(session)}
            accessTier={tier}
            metered={freebucks !== undefined}
            focusedId=""
            onFocusTargetsChange={ignoreFocusTargets}
            onSelectModel={selectFreebuffChatModel}
          />
        )}
      </box>
    </box>
  )
}
