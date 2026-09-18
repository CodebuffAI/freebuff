import { useRenderer } from '@opentui/react'
import { useEffect, useRef, useState } from 'react'

import {
  copyTextToClipboard,
  registerClipboardRenderer,
  subscribeClipboardMessages,
  unregisterClipboardRenderer,
} from '../utils/clipboard'

function formatDefaultClipboardMessage(text: string): string | null {
  const preview = text.replace(/\s+/g, ' ').trim()
  if (!preview) {
    return null
  }
  const truncated = preview.length > 40 ? `${preview.slice(0, 37)}…` : preview
  return `Copied: "${truncated}"`
}

export const useClipboard = () => {
  const renderer = useRenderer()
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [hasSelection, setHasSelection] = useState(false)
  const pendingCopyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const pendingSelectionRef = useRef<string | null>(null)
  const lastCopiedRef = useRef<string | null>(null)
  const activeCopyControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return subscribeClipboardMessages(setStatusMessage)
  }, [])

  // Register the renderer globally so all copyTextToClipboard callers
  // can use the renderer's OSC 52 method when available.
  useEffect(() => {
    if (renderer) {
      registerClipboardRenderer(renderer as unknown as Record<string, unknown>)
      return () => {
        unregisterClipboardRenderer()
      }
    }
    return undefined
  }, [renderer])

  useEffect(() => {
    const handleSelection = (selectionEvent: any) => {
      const selectionObj = selectionEvent ?? (renderer as any)?.getSelection?.()
      const rawText: string | null = selectionObj?.getSelectedText
        ? selectionObj.getSelectedText()
        : typeof selectionObj === 'string'
          ? selectionObj
          : null

      const cleanedText = rawText

      if (!cleanedText || cleanedText.trim().length === 0) {
        pendingSelectionRef.current = null
        activeCopyControllerRef.current?.abort()
        activeCopyControllerRef.current = null
        setHasSelection(false)
        if (pendingCopyTimeoutRef.current) {
          clearTimeout(pendingCopyTimeoutRef.current)
          pendingCopyTimeoutRef.current = null
        }
        return
      }

      if (cleanedText === pendingSelectionRef.current) {
        return
      }

      // A prior selection may still be waiting on a clipboard backend. Stop it
      // immediately so it cannot finish after this newer selection and restore
      // stale clipboard contents.
      activeCopyControllerRef.current?.abort()
      const controller = new AbortController()
      activeCopyControllerRef.current = controller

      // Track that there's an active selection for visual feedback
      setHasSelection(true)

      pendingSelectionRef.current = cleanedText

      if (pendingCopyTimeoutRef.current) {
        clearTimeout(pendingCopyTimeoutRef.current)
      }

      pendingCopyTimeoutRef.current = setTimeout(() => {
        pendingCopyTimeoutRef.current = null
        const pending = pendingSelectionRef.current
        if (!pending || pending === lastCopiedRef.current) {
          if (activeCopyControllerRef.current === controller) {
            activeCopyControllerRef.current = null
          }
          return
        }

        const successMessage = formatDefaultClipboardMessage(pending)
        void copyTextToClipboard(pending, {
          successMessage,
          durationMs: 3000,
          signal: controller.signal,
        })
          .then(() => {
            if (activeCopyControllerRef.current === controller) {
              lastCopiedRef.current = pending
              // Clear selection visual state after successful copy
              setHasSelection(false)
            }
          })
          .catch(() => {
            // Errors are logged within copyTextToClipboard
          })
          .finally(() => {
            if (activeCopyControllerRef.current === controller) {
              activeCopyControllerRef.current = null
            }
          })
      }, 250)
    }

    if (renderer?.on) {
      renderer.on('selection', handleSelection)
      return () => {
        renderer.off?.('selection', handleSelection)
      }
    }
    return undefined
  }, [renderer])

  useEffect(() => {
    return () => {
      if (pendingCopyTimeoutRef.current) {
        clearTimeout(pendingCopyTimeoutRef.current)
        pendingCopyTimeoutRef.current = null
      }
      activeCopyControllerRef.current?.abort()
      activeCopyControllerRef.current = null
    }
  }, [])

  return {
    statusMessage,
    hasSelection,
  }
}
