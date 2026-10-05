import { freebuffSubscriptionTier } from '@codebuff/common/constants/freebuff-subscriptions'
import { getSubscriptionInfo } from '@codebuff/common/types/freebuff-session'

import { TerminalLink } from './terminal-link'
import { useTheme } from '../hooks/use-theme'
import { safeOpen } from '../utils/open-url'

import type { FreebuffSessionResponse } from '../types/freebuff-session'

/** The account page's subscription tab, where Pay now settles the open invoice. */
export const FREEBUFF_SUBSCRIPTION_ACCOUNT_URL =
  'https://freebuff.com/account?tab=subscription'

/**
 * The sentence for a plan the server paused because its renewal payment
 * failed, or null when nothing is paused. Absent `paymentFailedTierId` (paid,
 * cancelled, or a server older than the field) means no notice.
 */
export function freebuffPausedPlanMessage(
  session: FreebuffSessionResponse | null,
): string | null {
  const tierId = getSubscriptionInfo(session)?.paymentFailedTierId
  if (!tierId) return null
  const name = freebuffSubscriptionTier(tierId)?.displayName ?? tierId
  return `Your ${name} plan is paused: the renewal payment failed.`
}

/**
 * Shown in the launch panel on every launch while the plan stays paused, and
 * deliberately not dismissible: it goes away once the invoice is paid.
 */
export function FreebuffPausedPlanNotice({
  session,
}: {
  session: FreebuffSessionResponse | null
}) {
  const theme = useTheme()
  const message = freebuffPausedPlanMessage(session)
  if (!message) return null
  return (
    <box style={{ flexDirection: 'column' }}>
      <text style={{ fg: theme.warning, wrapMode: 'word' }}>{message}</text>
      <box style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        <text style={{ fg: theme.foreground }}>Update your card at </text>
        <TerminalLink
          text={FREEBUFF_SUBSCRIPTION_ACCOUNT_URL}
          onActivate={() => safeOpen(FREEBUFF_SUBSCRIPTION_ACCOUNT_URL)}
          underlineOnHover={true}
          lineWrap={true}
          containerStyle={{ width: 'auto', flexShrink: 1 }}
        />
      </box>
    </box>
  )
}
