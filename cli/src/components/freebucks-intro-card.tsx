import { TextAttributes } from '@opentui/core'
import { useKeyboard } from '@opentui/react'
import { useCallback, useEffect, useState } from 'react'

import { FREEBUCKS_INTRO } from '../utils/freebucks'
import { hasSeenFreebucksIntro, markFreebucksIntroSeen } from '../utils/settings'
import { useTheme } from '../hooks/use-theme'

/**
 * Whether the one-time Freebucks introduction is on screen, and how to retire it.
 *
 * Shown the FIRST launch on which the account is METERED — the caller passes
 * `metered`, read off the session's `freebucks` block like every other
 * surface — and never again. The seen mark is written the moment it becomes
 * visible, not on dismissal: a launch that ends before the user presses
 * anything must not be shown it twice.
 *
 * THE VISIBILITY LIVES IN THE PARENT, not inside the card, because the picker
 * below has to know about it. The card says "press any key to continue" and
 * the picker commits its focused row on Enter or Space; the two are
 * independent `useKeyboard` subscriptions, so the dismissal key ALSO started a
 * session on whichever row the cursor happened to be on — the cheapest one,
 * since a metered list is sorted by price. A charge the user never asked for,
 * on a model they did not choose, and the most reported Freebucks bug
 * (2026-09-08).
 *
 * The landing screen suspends the picker's keyboard while this is true, and
 * the card stops the dismissal key propagating. EITHER guard alone would fix
 * it, and neither is enough on its own to rely on: which handler runs first is
 * an artifact of effect registration order (children before parents, siblings
 * in tree order), which no one should have to reason about to know whether a
 * keypress spends money.
 */
export function useFreebucksIntro(metered: boolean): {
  visible: boolean
  dismiss: () => void
} {
  const [visible, setVisible] = useState<boolean>(
    () => metered && !hasSeenFreebucksIntro(),
  )
  useEffect(() => {
    if (!metered) return
    if (hasSeenFreebucksIntro()) return
    markFreebucksIntroSeen()
    setVisible(true)
  }, [metered])
  const dismiss = useCallback(() => setVisible(false), [])
  return { visible, dismiss }
}

/**
 * The card itself, above the picker on the landing. Rendered only while
 * `useFreebucksIntro` says its state is visible; it is a card and not a modal
 * because the CLI landing has no modal layer.
 *
 * It owns the dismissal key and consumes it — see the hook above for why that
 * is one of two guards rather than the only one.
 */
export function FreebucksIntroCard({
  width,
  onDismiss,
}: {
  width: number
  onDismiss: () => void
}) {
  const theme = useTheme()
  useKeyboard((key) => {
    key.stopPropagation?.()
    key.preventDefault?.()
    onDismiss()
  })
  return (
    <box
      style={{
        flexDirection: 'column',
        width: Math.max(24, width),
        border: true,
        borderStyle: 'rounded',
        borderColor: theme.secondary,
        paddingLeft: 1,
        paddingRight: 1,
        marginBottom: 1,
        flexShrink: 0,
      }}
    >
      <text style={{ fg: theme.foreground }} attributes={TextAttributes.BOLD}>
        ★ {FREEBUCKS_INTRO.title}
      </text>
      <text style={{ fg: theme.muted, wrapMode: 'word' }}>{FREEBUCKS_INTRO.lead}</text>
      {FREEBUCKS_INTRO.points.map((point) => (
        <text key={point} style={{ fg: theme.foreground, wrapMode: 'word' }}>
          <span fg={theme.secondary}>•</span> {point}
        </text>
      ))}
      <text style={{ fg: theme.muted }}>{FREEBUCKS_INTRO.dismiss}</text>
    </box>
  )
}
