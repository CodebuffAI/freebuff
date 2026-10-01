import { useCallback, useEffect, useRef, useState } from 'react'

import type { ScrollBoxRenderable } from '@opentui/core'

// Scroll detection threshold - how close to bottom to consider "at bottom"
const SCROLL_NEAR_BOTTOM_THRESHOLD = 1

// Animation constants
const ANIMATION_FRAME_INTERVAL_MS = 16 // ~60fps
const DEFAULT_SCROLL_ANIMATION_DURATION_MS = 200

// Page scroll amount (fraction of viewport height)
const PAGE_SCROLL_FRACTION = 0.8

// Delay before auto-scrolling after content changes
const AUTO_SCROLL_DELAY_MS = 50

const easeOutCubic = (t: number): number => {
  return 1 - Math.pow(1 - t, 3)
}

/**
 * Manages scroll behavior for the chat scrollbox with smooth animations and auto-scroll.
 *
 * @param scrollRef - Reference to the scrollbox component
 * @param messages - Array of chat messages (triggers auto-scroll on change)
 * @param isUserCollapsing - Callback to check if user is actively collapsing/expanding toggles.
 *                          When true, auto-scroll is temporarily suppressed to prevent jarring UX.
 * @returns Scroll management functions and state
 */
export const useChatScrollbox = (
  scrollRef: React.RefObject<ScrollBoxRenderable | null>,
  messages: any[],
  isUserCollapsing: () => boolean,
) => {
  const autoScrollEnabledRef = useRef<boolean>(true)
  const programmaticScrollRef = useRef<boolean>(false)
  const animationFrameRef = useRef<number | null>(null)
  const [isAtBottom, setIsAtBottom] = useState<boolean>(true)

  const cancelAnimation = useCallback(() => {
    if (animationFrameRef.current !== null) {
      clearTimeout(animationFrameRef.current)
      animationFrameRef.current = null
    }
  }, [])

  // OpenTUI emits scroll changes synchronously, and emits nothing for a no-op
  // assignment. Keep the guard scoped to the write so it cannot swallow the
  // user's next wheel event when we were already at the bottom.
  const setScrollTop = useCallback(
    (scrollbox: ScrollBoxRenderable, top: number) => {
      programmaticScrollRef.current = true
      try {
        scrollbox.scrollTop = top
      } finally {
        programmaticScrollRef.current = false
      }
    },
    [],
  )

  const animateScrollTo = useCallback(
    (
      targetScroll: number | 'latest',
      duration = DEFAULT_SCROLL_ANIMATION_DURATION_MS,
    ) => {
      const scrollbox = scrollRef.current
      if (!scrollbox) return

      cancelAnimation()
      autoScrollEnabledRef.current = false

      const startScroll = scrollbox.scrollTop
      const startTime = Date.now()
      const frameInterval = ANIMATION_FRAME_INTERVAL_MS

      const animate = () => {
        const elapsed = Date.now() - startTime
        const progress = Math.min(elapsed / duration, 1)
        const easedProgress = easeOutCubic(progress)
        const target =
          targetScroll === 'latest'
            ? Math.max(0, scrollbox.scrollHeight - scrollbox.viewport.height)
            : targetScroll
        const distance = target - startScroll
        const newScroll = startScroll + distance * easedProgress

        setScrollTop(scrollbox, newScroll)

        if (progress < 1) {
          animationFrameRef.current = setTimeout(animate, frameInterval) as any
        } else {
          animationFrameRef.current = null
          const maxScroll = Math.max(
            0,
            scrollbox.scrollHeight - scrollbox.viewport.height,
          )
          const isNearBottom =
            Math.abs(maxScroll - scrollbox.scrollTop) <=
            SCROLL_NEAR_BOTTOM_THRESHOLD
          autoScrollEnabledRef.current = isNearBottom
          setIsAtBottom(isNearBottom)
        }
      }

      animate()
    },
    [scrollRef, cancelAnimation, setScrollTop],
  )

  const scrollToLatest = useCallback((): void => {
    const scrollbox = scrollRef.current
    if (!scrollbox) return

    animateScrollTo('latest')
  }, [scrollRef, animateScrollTo])

  const scrollUp = useCallback((): void => {
    const scrollbox = scrollRef.current
    if (!scrollbox) return

    const viewportHeight = scrollbox.viewport.height
    const scrollAmount = Math.floor(viewportHeight * PAGE_SCROLL_FRACTION)
    const targetScroll = Math.max(0, scrollbox.scrollTop - scrollAmount)
    animateScrollTo(targetScroll)
  }, [scrollRef, animateScrollTo])

  const scrollDown = useCallback((): void => {
    const scrollbox = scrollRef.current
    if (!scrollbox) return

    const viewportHeight = scrollbox.viewport.height
    const maxScroll = Math.max(0, scrollbox.scrollHeight - viewportHeight)
    const scrollAmount = Math.floor(viewportHeight * PAGE_SCROLL_FRACTION)
    const targetScroll = Math.min(maxScroll, scrollbox.scrollTop + scrollAmount)
    animateScrollTo(targetScroll === maxScroll ? 'latest' : targetScroll)
  }, [scrollRef, animateScrollTo])

  useEffect(() => {
    const scrollbox = scrollRef.current
    if (!scrollbox) return

    const handleScrollChange = () => {
      const maxScroll = Math.max(
        0,
        scrollbox.scrollHeight - scrollbox.viewport.height,
      )
      const current = scrollbox.verticalScrollBar.scrollPosition
      const isNearBottom =
        Math.abs(maxScroll - current) <= SCROLL_NEAR_BOTTOM_THRESHOLD

      if (!programmaticScrollRef.current) {
        cancelAnimation()
        autoScrollEnabledRef.current = isNearBottom
      }

      setIsAtBottom((prev) => (prev === isNearBottom ? prev : isNearBottom))
    }

    scrollbox.verticalScrollBar.on('change', handleScrollChange)

    return () => {
      scrollbox.verticalScrollBar.off('change', handleScrollChange)
    }
  }, [scrollRef, cancelAnimation])

  useEffect(() => {
    const scrollbox = scrollRef.current
    if (scrollbox) {
      const timeoutId = setTimeout(() => {
        const maxScroll = Math.max(
          0,
          scrollbox.scrollHeight - scrollbox.viewport.height,
        )

        if (scrollbox.scrollTop > maxScroll) {
          setScrollTop(scrollbox, maxScroll)
        } else if (
          animationFrameRef.current === null &&
          autoScrollEnabledRef.current &&
          !isUserCollapsing()
        ) {
          setScrollTop(scrollbox, maxScroll)
        }
      }, AUTO_SCROLL_DELAY_MS)

      return () => clearTimeout(timeoutId)
    }
    return undefined
  }, [messages, scrollRef, isUserCollapsing, setScrollTop])

  useEffect(() => {
    return () => {
      cancelAnimation()
    }
  }, [cancelAnimation])

  return {
    scrollToLatest,
    scrollUp,
    scrollDown,
    scrollboxProps: {},
    isAtBottom,
  }
}
