import {
  FREEBUFF_EARN_PATH,
  FREEBUFF_EARN_PROMPT_SHORT,
} from '@codebuff/common/constants/freebuff-earn'
import { TextAttributes } from '@opentui/core'
import React, { useCallback, useEffect, useState } from 'react'

import { Button } from './button'
import { useCopyToClipboard } from './copy-button'
import { FREEBUFF_REWARD_MAX_DAILY_SESSIONS } from '@codebuff/common/constants/freebuff-models'
import { REFERRAL_CLI_DAILY_SESSION_BONUS_CAP } from '@codebuff/common/constants/freebuff-referral-tiers'
import { pluralize } from '@codebuff/common/util/string'

import { useNow } from '../hooks/use-now'
import { useTheme } from '../hooks/use-theme'
import { LOGIN_WEBSITE_URL } from '../login/constants'
import { formatFreebuffPremiumResetCountdown } from '../utils/freebuff-premium-reset'
import { safeOpen } from '../utils/open-url'
import { BORDER_CHARS } from '../utils/ui-constants'

import type { FreebuffAccessTier } from '@codebuff/common/constants/freebuff-models'
import type {
  FreebuffGlmPromo,
  FreebuffReferralInfo,
} from '@codebuff/common/types/freebuff-session'

/** Build a friend's share link from the referral code. Points at the
 *  /get-started page (CLI install walkthrough + hero + FAQs) rather than the
 *  bare landing page; the `?ref=` code is still captured into the attribution
 *  cookie there via the root layout's ReferralCodeCapture. When we know the
 *  inviter's name we pass `?referrer=` too so the page greets the friend with
 *  "X invited you to try Freebuff!". */
function referralLink(code: string, referrerName: string | null): string {
  const params = new URLSearchParams({ ref: code })
  if (referrerName) params.set('referrer', referrerName)
  return `${LOGIN_WEBSITE_URL}/get-started?${params.toString()}`
}

/**
 * The Earn page, on the tab that pays TODAY.
 *
 * Was `/earn?tab=referrals#referral-status`, which sent a rate-limited user to
 * the slowest of the three ways to earn — a referral pays when somebody else
 * signs up and sticks around. `/earn/trust` is the engagement feed, which pays
 * within a minute. `FREEBUFF_EARN_PATH` is shared so the CLI, Desktop and the
 * browser all point at the same place.
 */
const EARN_URL = `${LOGIN_WEBSITE_URL}${FREEBUFF_EARN_PATH}`
const DASHBOARD_LABEL = `${FREEBUFF_EARN_PROMPT_SHORT} ↵`
/** Link to details about earning hours. */
const METERED_DASHBOARD_LABEL = 'Learn More ↵'
// Two columns of leading space separate the label from the copy control beside
// it (the row itself has no gap), and they stay put in every state so keyboard
// navigation never shifts the rest of the action row.
const DASHBOARD_GUTTER = '  '
const DASHBOARD_BUTTON_WIDTH = DASHBOARD_LABEL.length + DASHBOARD_GUTTER.length

/** The temporary promo still needs its deadline even though the standing
 * bounty pitch is already covered elsewhere in the picker and Earn page. */
function BountyPromoLine({
  theme,
  promo,
}: {
  theme: ReturnType<typeof useTheme>
  promo?: FreebuffGlmPromo
}) {
  if (!promo) return null
  return (
    <text style={{ wrapMode: 'word' }}>
      <span fg={theme.success ?? theme.foreground}>
        ✦ Promo: earn a bounty, spend up to {promo.dailySessions} a day
      </span>
      <span fg={theme.muted}> (ends {formatPromoEnd(promo.endsAt)})</span>
    </text>
  )
}

function DashboardButton({
  theme,
  focused,
  onOpen,
  label = DASHBOARD_LABEL,
}: {
  theme: ReturnType<typeof useTheme>
  focused: boolean
  onOpen: () => void
  label?: string
}) {
  // Focus is shown by the accent color alone, like the inline copy control it
  // sits next to. A leading marker would have to eat the gutter that keeps the
  // two labels apart, so a focused dashboard link ran flush into "Copy invite
  // link" and read as overlapping it.
  return (
    <Button onClick={onOpen}>
      <text style={{ wrapMode: 'word' }}>
        <span
          fg={focused ? theme.primary : theme.secondary}
          attributes={focused ? TextAttributes.BOLD : TextAttributes.NONE}
        >
          {DASHBOARD_GUTTER}
          {label}
        </span>
      </text>
    </Button>
  )
}

/** Short, local date for the promo's end. The server sends the instant; every
 * surface formats it, so none of them can drift from the real window. */
function formatPromoEnd(endsAt: string): string {
  const at = new Date(endsAt)
  return Number.isNaN(at.getTime())
    ? 'soon'
    : at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// Navigation ids for the banner's keyboard-focusable buttons. The model
// selector owns the landing keyboard handler and appends these after its rows.
const COPY_FOCUS_ID = '__freebuff_referral_copy__'
/** Opens the Earn page — bounties to claim, referrals to track, balance to
 *  read. The CLI can open a browser (`safeOpen`), so this is a real button
 *  rather than a URL the user has to select and paste. */
const DASHBOARD_FOCUS_ID = '__freebuff_referral_dashboard__'

export interface FreebuffReferralFocusTarget {
  id: string
  activate: () => void
}

const firstLabelThatFits = (
  availableWidth: number,
  labels: readonly string[],
): string =>
  labels.find((label) => label.length <= availableWidth) ?? labels.at(-1)!

/**
 * The "copy invite link" control. Flips to an accent "✔ Copied!" confirmation
 * for a couple seconds after a successful copy. Presentational: the copy action
 * and copied flag are owned by the banner so the same action can be fired by
 * keyboard navigation from the model picker.
 *
 * No box; focus/hover shown by color alone, exactly like the picker's "See all
 * N models" toggle. It renders on the landing screen directly under the
 * recommended card: a second bordered box there competes with the hero for the
 * eye, and the hero is what Enter actually does. Sits one row down (like the
 * toggle) so whitespace, not a border, separates it from the pitch above — and
 * rests at `foreground` rather than `muted`, since unlike the toggle it is
 * adjacent to muted body copy it must not blend into.
 */
const CopyInviteLinkButton: React.FC<{
  isCopied: boolean
  focused: boolean
  onCopy: () => void
  availableWidth: number
}> = ({ isCopied, focused, onCopy, availableWidth }) => {
  const theme = useTheme()
  const [isHovered, setIsHovered] = useState(false)
  const label = firstLabelThatFits(availableWidth, [
    '⎘ Copy invite link',
    '⎘ Copy link',
    '⎘ Copy',
  ])
  const copiedLabel = firstLabelThatFits(availableWidth, ['✔ Copied!', '✔'])
  const highlighted = isCopied || focused || isHovered

  return (
    <Button
      id={COPY_FOCUS_ID}
      onClick={onCopy}
      onMouseOver={() => setIsHovered(true)}
      onMouseOut={() => setIsHovered(false)}
      style={{ flexShrink: 0 }}
    >
      <text style={{ wrapMode: 'none' }}>
        <span
          fg={highlighted ? theme.primary : theme.foreground}
          attributes={
            isCopied || focused ? TextAttributes.BOLD : TextAttributes.NONE
          }
        >
          {isCopied ? copiedLabel : label}
        </span>
      </text>
    </Button>
  )
}

/**
 * Advertises the "invite friends" reward on the landing model screen. The
 * reward — and the copy — depends on the account:
 *
 *   - ON THE METER (every account since the audience went to `all`):
 *     referrals pay hours into the wallet, spendable on any model.
 *   - LIMITED tier, off the meter: a daily free-session bonus.
 *   - FULL tier, off the meter: one extra premium session a day.
 *
 * Each is one quiet muted line + the inline copy control, so it advertises the
 * perk without crowding the picker; the hero card stays the only bordered
 * element on the landing screen. There is no "use your reward" button: no
 * reward unlocks a model any more (it used to start a GLM session).
 *
 * Every pitch is sized to fit its tier's card width on ONE line
 * (the banner wraps at `buttonOuterWidth`, not the terminal width) and ends
 * in a colon that hands off to the inline copy control below it. Now that the
 * control is borderless it no longer announces itself as a button, so the
 * colon is what carries the eye down to it. The one exception is the
 * limited-tier at-cap line: referring more earns nothing there, so it ends
 * flat rather than pointing at an action that would not pay off.
 *
 * Renders nothing unless the server attached a `referral` block, so
 * pre-referral-code users never see it.
 */
interface FreebuffReferralBannerProps {
  width: number
  referral: FreebuffReferralInfo
  /** A live GLM promo, or undefined. Undefined is the ordinary state. */
  glmPromo?: FreebuffGlmPromo
  accessTier: FreebuffAccessTier
  /** The account is on the Freebucks meter: referrals pay hours, and
   *  nothing here may count sessions. */
  metered?: boolean
  focusedId: string
  onFocusTargetsChange: (targets: FreebuffReferralFocusTarget[]) => void
}

export const FreebuffReferralBanner: React.FC<FreebuffReferralBannerProps> = ({
  width,
  referral,
  glmPromo,
  accessTier,
  metered = false,
  focusedId,
  onFocusTargetsChange,
}) => {
  const theme = useTheme()
  const now = useNow(60_000)
  const copyFocused = focusedId === COPY_FOCUS_ID
  const dashboardFocused = focusedId === DASHBOARD_FOCUS_ID

  const link = referralLink(referral.code, referral.referrerName)
  const { isCopied, copy } = useCopyToClipboard(link)

  const openDashboard = useCallback(() => {
    void safeOpen(EARN_URL)
  }, [])
  const referralActions = (
    <box
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 0,
        marginTop: 1,
        flexShrink: 0,
      }}
    >
      <CopyInviteLinkButton
        isCopied={isCopied}
        focused={copyFocused}
        onCopy={copy}
        availableWidth={Math.max(
          0,
          width -
            (metered
              ? METERED_DASHBOARD_LABEL.length + DASHBOARD_GUTTER.length
              : DASHBOARD_BUTTON_WIDTH),
        )}
      />
      <DashboardButton
        theme={theme}
        focused={dashboardFocused}
        onOpen={openDashboard}
        label={metered ? METERED_DASHBOARD_LABEL : undefined}
      />
    </box>
  )

  // Register this banner's buttons as keyboard focus targets so the model
  // selector's arrow navigation flows from "see all models" into them (and
  // wraps back up): copy, then dashboard.
  useEffect(() => {
    onFocusTargetsChange([
      { id: COPY_FOCUS_ID, activate: copy },
      { id: DASHBOARD_FOCUS_ID, activate: openDashboard },
    ])
    return () => onFocusTargetsChange([])
  }, [copy, openDashboard, onFocusTargetsChange])

  const { qualifiedCount } = referral

  // ON THE METER: one quiet line. Referrals pay hours (claimed on the
  // Earn page), and every other variant here counts sessions per day, which
  // is a meter this account is no longer on.
  if (metered) {
    return (
      <box style={{ flexDirection: 'column', width, marginTop: 1, flexShrink: 0 }}>
        <text style={{ wrapMode: 'word' }}>
          <span fg={theme.muted}>✦ Refer friends → </span>
          <span fg={theme.foreground}>earn hours</span>
          <span fg={theme.muted}>:</span>
        </text>
        {referralActions}
      </box>
    )
  }
  // LIMITED tier: referrals earn a daily free-session bonus. `qualifiedCount`
  // is the capped bonus sessions/day already earned, shown as progress.
  if (accessTier === 'limited') {
    const atCap = qualifiedCount >= REFERRAL_CLI_DAILY_SESSION_BONUS_CAP
    return (
      <box
        style={{
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 0,
          marginTop: 1,
          // Never let a height-starved landing column squash the banner — that
          // would draw the copy control on top of the pitch line above it.
          flexShrink: 0,
        }}
      >
        <text style={{ wrapMode: 'word' }}>
          <span fg={theme.muted}>✦ </span>
          {qualifiedCount > 0 ? (
            <>
              <span fg={theme.foreground}>
                +{pluralize(qualifiedCount, 'session')}/day
              </span>
              <span fg={theme.muted}>
                {' '}
                from referrals
                {atCap
                  ? ''
                  : ` · refer more (${qualifiedCount}/${REFERRAL_CLI_DAILY_SESSION_BONUS_CAP}):`}
              </span>
            </>
          ) : (
            <span fg={theme.muted}>
              Refer friends to unlock more free sessions per day:
            </span>
          )}
        </text>
        {referralActions}
        <BountyPromoLine theme={theme} promo={glmPromo} />
      </box>
    )
  }

  // The reward's reset. Always present on a full-tier block from the server;
  // default defensively for the wire type.
  const resetsIn = formatFreebuffPremiumResetCountdown(
    referral.resetAt ? new Date(referral.resetAt) : new Date(now),
    now,
    {
      withDays: true,
    },
  )

  // FULL tier: one EXTRA session in the daily premium pool, which the model
  // picker already meters and displays, so this is a quiet line too.
  return (
    <box
      style={{
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 0,
        marginTop: 1,
        // Never let a height-starved landing column squash the banner — that
        // would draw the copy control on top of the pitch line above it.
        flexShrink: 0,
      }}
    >
      <text style={{ wrapMode: 'word' }}>
        <span fg={theme.muted}>✦ </span>
        {qualifiedCount > 0 ? (
          <>
            <span fg={theme.foreground}>
              +{pluralize(qualifiedCount, 'premium session')}/day
            </span>
            <span fg={theme.muted}>
              {' '}
              from referrals · refills in {resetsIn}
              {qualifiedCount >= FREEBUFF_REWARD_MAX_DAILY_SESSIONS
                ? ''
                : ` · refer more (${qualifiedCount}/${FREEBUFF_REWARD_MAX_DAILY_SESSIONS}):`}
            </span>
          </>
        ) : (
          <>
            <span fg={theme.muted}>Refer friends → </span>
            <span fg={theme.foreground}>+1 premium session/day</span>
            <span fg={theme.muted}>:</span>
          </>
        )}
      </text>
      {referralActions}
      <BountyPromoLine theme={theme} promo={glmPromo} />
    </box>
  )
}
