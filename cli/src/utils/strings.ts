import path from 'path'

/** Max number of lines to show in collapsed previews */
export const MAX_COLLAPSED_LINES = 3

/**
 * Truncate text to a maximum number of lines, adding '...' if truncated.
 * Returns the input unchanged if it's null/undefined/empty.
 */
export function truncateToLines(
  text: string | null | undefined,
  maxLines: number,
): string | null | undefined {
  if (!text) return text
  const lines = text.split('\n')
  if (lines.length <= maxLines) {
    return text
  }
  return lines.slice(0, maxLines).join('\n').trimEnd() + '...'
}

import { statSync } from 'fs'

import {
  getFileOrFolderPathFromText,
  getImageFilePathFromText,
  hasClipboardImage,
  readClipboardFilePath,
  readClipboardImageFilePath,
  readClipboardText,
} from './clipboard-image'
import { isImageFile } from './image-handler'

import type { InputValue } from '../types/store'

// Threshold for treating pasted text as an attachment instead of inline insertion
// Text longer than this value (not equal) becomes an attachment
export const LONG_TEXT_THRESHOLD = 2000

/**
 * Insert text at cursor position and return the new text and cursor position.
 */
function insertTextAtCursor(
  text: string,
  cursorPosition: number,
  textToInsert: string,
): { newText: string; newCursor: number } {
  const before = text.slice(0, cursorPosition)
  const after = text.slice(cursorPosition)
  return {
    newText: before + textToInsert + after,
    newCursor: before.length + textToInsert.length,
  }
}

/**
 * Creates a paste handler for text-only inputs (feedback, ask-user, etc.).
 * Reads from clipboard with OpenTUI fallback, then inserts at cursor.
 */
export function createTextPasteHandler(
  text: string,
  cursorPosition: number,
  onChange: (value: InputValue) => void,
): (eventText?: string) => void {
  return (eventText) => {
    const rawPaste = eventText || readClipboardText()
    if (!rawPaste) return
    const pasteText = Bun.stripANSI(rawPaste)
    if (!pasteText) return
    const { newText, newCursor } = insertTextAtCursor(
      text,
      cursorPosition,
      pasteText,
    )
    onChange({
      text: newText,
      cursorPosition: newCursor,
      lastEditDueToNav: false,
    })
  }
}

/**
 * Creates a paste handler that supports both image and text paste.
 *
 * When eventText is provided (from drag-drop or native paste event),
 * it takes priority over the clipboard. This is because:
 * - Drag operations provide file paths directly without updating the clipboard
 * - The clipboard might contain stale data from a previous copy operation
 *
 * Only when NO eventText is provided do we read from the clipboard.
 */
export function createPasteHandler(options: {
  text: string
  cursorPosition: number
  onChange: (value: InputValue) => void
  onPasteImage?: () => void
  onPasteImagePath?: (imagePath: string) => void
  onPasteFilePath?: (filePath: string, isDirectory: boolean) => void
  onPasteLongText?: (text: string) => void
  cwd?: string
}): (eventText?: string) => void {
  const {
    text,
    cursorPosition,
    onChange,
    onPasteImage,
    onPasteImagePath,
    onPasteFilePath,
    onPasteLongText,
    cwd,
  } = options
  return (eventText) => {
    // Strip ANSI escape sequences from pasted text — terminal paste events
    // (bracketed paste) may include ANSI sequences from the source content.
    if (eventText) {
      eventText = Bun.stripANSI(eventText)
    }

    // If we have direct input text from the paste event (e.g., from terminal paste),
    // check if it looks like an image filename and if we can get the full path from clipboard
    if (eventText && onPasteImagePath) {
      // The terminal often only passes the filename when pasting a file copied from Finder.
      // Check if this looks like just a filename (no path separators) that's an image.
      const looksLikeImageFilename =
        isImageFile(eventText) &&
        !eventText.includes('/') &&
        !eventText.includes('\\')

      if (looksLikeImageFilename) {
        // Try to get the full path from the clipboard's file URL
        const clipboardFilePath = readClipboardImageFilePath()
        // Verify the clipboard path's basename matches exactly (not just endsWith)
        if (
          clipboardFilePath &&
          path.basename(clipboardFilePath) === eventText
        ) {
          // The clipboard has the full path to the same file - use it!
          onPasteImagePath(clipboardFilePath)
          return
        }
      }

      // Check if eventText is a full path to an image file
      if (cwd) {
        const imagePath = getImageFilePathFromText(eventText, cwd)
        if (imagePath) {
          onPasteImagePath(imagePath)
          return
        }
      }
    }

    // Check if eventText is a path to a file or folder (drag-and-drop)
    if (eventText && onPasteFilePath && cwd) {
      const fileInfo = getFileOrFolderPathFromText(eventText, cwd)
      if (fileInfo) {
        onPasteFilePath(fileInfo.path, fileInfo.isDirectory)
        return
      }
    }

    // eventText provided but not an image - check if it's long text
    if (eventText) {
      // If text is long, treat it as an attachment
      if (onPasteLongText && eventText.length > LONG_TEXT_THRESHOLD) {
        onPasteLongText(eventText)
        return
      }

      // Otherwise paste it as regular text
      const { newText, newCursor } = insertTextAtCursor(
        text,
        cursorPosition,
        eventText,
      )
      onChange({
        text: newText,
        cursorPosition: newCursor,
        lastEditDueToNav: false,
      })
      return
    }

    // No direct text provided - read from clipboard

    // First, check if clipboard contains a copied file (e.g., from Finder)
    if (onPasteImagePath || onPasteFilePath) {
      const copiedFilePath = readClipboardFilePath()
      if (copiedFilePath) {
        if (isImageFile(copiedFilePath) && onPasteImagePath) {
          onPasteImagePath(copiedFilePath)
          return
        }
        if (!isImageFile(copiedFilePath) && onPasteFilePath) {
          try {
            const stats = statSync(copiedFilePath)
            onPasteFilePath(copiedFilePath, stats.isDirectory())
            return
          } catch {
            // Fall through to other paste handlers
          }
        }
      }
    }

    const rawClipboardText = readClipboardText()
    const clipboardText = rawClipboardText ? Bun.stripANSI(rawClipboardText) : null

    // Check if clipboard text is a path to an image file
    if (clipboardText && onPasteImagePath && cwd) {
      const imagePath = getImageFilePathFromText(clipboardText, cwd)
      if (imagePath) {
        onPasteImagePath(imagePath)
        return
      }
    }

    // Check for actual image data (screenshots, copied images)
    if (onPasteImage && hasClipboardImage()) {
      onPasteImage()
      return
    }

    // Regular text paste
    if (!clipboardText) return

    // If text is long, treat it as an attachment
    if (onPasteLongText && clipboardText.length > LONG_TEXT_THRESHOLD) {
      onPasteLongText(clipboardText)
      return
    }

    const { newText, newCursor } = insertTextAtCursor(
      text,
      cursorPosition,
      clipboardText,
    )
    onChange({
      text: newText,
      cursorPosition: newCursor,
      lastEditDueToNav: false,
    })
  }
}
