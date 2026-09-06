import type { KeyEvent } from '@opentui/core'

/**
 * What a keypress means inside the skills panel. Kept separate from the
 * component so the shortcut table is testable without a renderer, matching
 * how the queue panel's shortcuts are resolved.
 */
export type SkillsPanelAction =
  | { type: 'close' }
  /** Move the cursor by `delta` rows. */
  | { type: 'select'; delta: number }
  /** Invoke the selected skill (enters skill input mode). */
  | { type: 'invoke' }
  /** Open the selected skill's SKILL.md in $EDITOR. */
  | { type: 'open' }
  /** Delete the selected skill's SKILL.md (with confirmation). */
  | { type: 'delete' }
  | { type: 'confirm' }
  | { type: 'cancel' }
  /** Enter search mode: keystrokes filter the list instead of triggering actions. */
  | { type: 'search-start' }
  /** Append `char` to the search query (search mode only). */
  | { type: 'search-input'; char: string }
  /** Remove the last character of the search query (search mode only). */
  | { type: 'search-backspace' }
  /** Leave search mode, keeping the current filter (search mode only). */
  | { type: 'search-exit' }
  | { type: 'none' }

export type SkillsPanelKeyboardState = {
  /** While a delete is pending confirmation the panel only listens for
   *  confirm/cancel — a stray `d` must not chain-delete the next row. */
  confirmingDelete: boolean
  /** While search mode is active, printable keys edit the query instead of
   *  firing single-letter shortcuts like o/d/j/k. */
  searching: boolean
}

/** A printable character keypress (no ctrl/meta modifiers). */
function printableChar(key: KeyEvent): string | null {
  if (key.ctrl || key.meta || key.option) return null
  if (key.sequence && key.sequence.length === 1 && key.sequence >= ' ')
    return key.sequence
  return null
}

export function resolveSkillsPanelAction(
  key: KeyEvent,
  state: SkillsPanelKeyboardState,
): SkillsPanelAction {
  const isEscape = key.name === 'escape'
  const isCtrlC = key.ctrl && key.name === 'c'

  if (state.confirmingDelete) {
    // Enter confirms; anything escape-shaped cancels; everything else is
    // swallowed so a held key can't confirm or chain. Delete confirmation
    // outranks search mode: it must never be dismissible by a query edit.
    if (key.name === 'return' || key.name === 'enter') return { type: 'confirm' }
    if (isEscape || isCtrlC || key.name === 'n' || key.name === 'q')
      return { type: 'cancel' }
    return { type: 'none' }
  }

  // `q` closes, mirroring the queue panel. Ctrl+C closes even from search.
  if (isEscape && !state.searching) return { type: 'close' }
  if (isCtrlC) return { type: 'close' }
  if (key.name === 'q' && !state.searching) return { type: 'close' }

  if (state.searching) {
    if (key.name === 'backspace')
      return { type: 'search-backspace' }
    if (isEscape) return { type: 'search-exit' }
    // Arrows and enter keep working while typing — but only their named
    // forms: letters (j/k/q/d/o) are query edits in search mode.
    if (key.name === 'up') return { type: 'select', delta: -1 }
    if (key.name === 'down') return { type: 'select', delta: 1 }
    if (key.name === 'return' || key.name === 'enter') return { type: 'invoke' }
    const char = printableChar(key)
    if (char) return { type: 'search-input', char }
    // Anything else (modifiers, chords, unnamed keys) does nothing rather
    // than firing a single-letter shortcut underneath the typing.
    return { type: 'none' }
  }

  if (key.name === 'up' || key.name === 'k') return { type: 'select', delta: -1 }
  if (key.name === 'down' || key.name === 'j')
    return { type: 'select', delta: 1 }

  // Enter invokes; `o` opens the file in $EDITOR.
  if (key.name === 'return' || key.name === 'enter') return { type: 'invoke' }
  if (key.name === 'o') return { type: 'open' }

  if (key.name === 'd' || key.name === 'delete') return { type: 'delete' }

  // `/` enters search mode (matches the queue panel's slash-filter affordance).
  if (printableChar(key) === '/') return { type: 'search-start' }

  return { type: 'none' }
}
