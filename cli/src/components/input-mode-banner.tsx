import React from 'react'
import { IS_FREEBUFF } from '../utils/constants'

import { PendingAttachmentsBanner } from './pending-attachments-banner'
import { SubscriptionLimitBanner } from './subscription-limit-banner'
import { UsageBanner } from './usage-banner'
import { useChatStore } from '../state/chat-store'

/**
 * Registry mapping input modes to their banner components.
 *
 * To add a new banner:
 * 1. Create the banner component using BottomBanner
 * 2. Add an entry here mapping the input mode to a render function
 *
 * Render functions receive context (like showTime) and return the component.
 */
const BANNER_REGISTRY: Record<
  string,
  (ctx: { showTime: number }) => React.ReactNode
> = {
  default: () => <PendingAttachmentsBanner />,
  image: () => <PendingAttachmentsBanner />,
  ...(IS_FREEBUFF ? {} : { usage: ({ showTime }: { showTime: number }) => <UsageBanner showTime={showTime} /> }),
  ...(IS_FREEBUFF ? {} : { subscriptionLimit: () => <SubscriptionLimitBanner /> }),
}

/**
 * Banner component that shows contextual information below the input box.
 * Shows mode-specific banners based on the current input mode.
 *
 * Uses a registry pattern for easy extensibility - add new banners by
 * updating BANNER_REGISTRY above.
 */
export const InputModeBanner = () => {
  const inputMode = useChatStore((state) => state.inputMode)

  const [usageBannerShowTime, setUsageBannerShowTime] = React.useState(() =>
    Date.now(),
  )

  React.useEffect(() => {
    if (inputMode === 'usage') {
      setUsageBannerShowTime(Date.now())
    }
  }, [inputMode])

  const renderBanner = BANNER_REGISTRY[inputMode]

  if (!renderBanner) {
    return null
  }

  return <>{renderBanner({ showTime: usageBannerShowTime })}</>
}
