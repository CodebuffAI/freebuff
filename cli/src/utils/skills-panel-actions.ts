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
  | { type: 'none' }

export type SkillsPanelKeyboardState = {
  /** While a delete is pending confirmation the panel only listens for
   *  confirm/cancel — a stray `d` must not chain-delete the next row. */
  confirmingDelete: boolean
}

export function resolveSkillsPanelAction(
  key: KeyEvent,
  state: SkillsPanelKeyboardState,
): SkillsPanelAction {
  const isEscape = key.name === 'escape'
  const isCtrlC = key.ctrl && key.name === 'c'

  if (state.confirmingDelete) {
    // Enter confirms; anything escape-shaped cancels; everything else is
    // swallowed so a held key can't confirm or chain.
    if (key.name === 'return' || key.name === 'enter') return { type: 'confirm' }
    if (isEscape || isCtrlC || key.name === 'n' || key.name === 'q')
      return { type: 'cancel' }
    return { type: 'none' }
  }

  // `q` closes, mirroring the queue panel.
  if (isEscape || isCtrlC || key.name === 'q') return { type: 'close' }

  if (key.name === 'up' || key.name === 'k') return { type: 'select', delta: -1 }
  if (key.name === 'down' || key.name === 'j')
    return { type: 'select', delta: 1 }

  // Enter invokes; `o` opens the file in $EDITOR.
  if (key.name === 'return' || key.name === 'enter') return { type: 'invoke' }
  if (key.name === 'o') return { type: 'open' }

  if (key.name === 'd' || key.name === 'delete') return { type: 'delete' }

  return { type: 'none' }
}
