import { profileSurveyInputForKey } from './profile-survey-machine'
import { isPlainEnterKey } from './terminal-enter-detection'

import type { ProfileSurveyKeyContext } from './profile-survey-machine'

type ChatInputKey = {
  name?: string
  sequence?: string
  shift?: boolean
  ctrl?: boolean
  meta?: boolean
  option?: boolean
}

type ChatInputKeyInterceptState = {
  inputMode?: string
  hasSlashSuggestions: boolean
  hasMentionSuggestions: boolean
  lastEditDueToNav: boolean
  cursorPosition: number
  inputLength: number
  /** The profile survey box, when on screen (COD-779). */
  profileSurvey?: ProfileSurveyKeyContext | null
}

export function shouldInterceptChatInputKey(
  key: ChatInputKey,
  state: ChatInputKeyInterceptState,
): boolean {
  // The survey's keys never reach the composer: a digit it claims must not
  // also be typed. Same predicate as the chat resolver's survey priority.
  if (
    state.profileSurvey &&
    state.inputLength === 0 &&
    (!state.inputMode || state.inputMode === 'default') &&
    profileSurveyInputForKey(key, state.profileSurvey) !== null
  ) {
    return true
  }
  if (state.inputLength === 0 && (!state.inputMode || state.inputMode === 'default' || state.inputMode === 'help') && !key.ctrl && !key.meta && !key.option) {
    if (key.sequence === '?' || key.name === '?' || (key.name === 'left' && !key.shift)) return true
  }
  const isPlainEnter = isPlainEnterKey(key)
  const isTab = key.name === 'tab' && !key.ctrl && !key.meta && !key.option
  const isUp = key.name === 'up' && !key.ctrl && !key.meta && !key.option
  const isDown = key.name === 'down' && !key.ctrl && !key.meta && !key.option
  const isUpDown = isUp || isDown

  // An open menu owns Up/Down even though its "/" or "@" makes the draft
  // non-empty; in a non-empty draft with no menu, arrows fall through to the
  // composer's cursor movement (the history checks below need an empty draft
  // or an unedited recalled entry).
  const hasSuggestions =
    state.hasSlashSuggestions || state.hasMentionSuggestions
  if (hasSuggestions) {
    if (isUpDown && state.lastEditDueToNav) {
      return true
    }
    if (isPlainEnter || isTab || isUpDown) {
      return true
    }
  }

  const historyUpEnabled = state.lastEditDueToNav || state.cursorPosition === 0
  const historyDownEnabled =
    state.lastEditDueToNav || state.cursorPosition === state.inputLength
  // History pages from an empty draft or from the entry it last recalled; a
  // typed draft keeps its arrows for cursor movement.
  const inHistoryDraft = state.inputLength === 0 || state.lastEditDueToNav
  if (isUp && inHistoryDraft && historyUpEnabled) {
    return true
  }
  if (isDown && inHistoryDraft && historyDownEnabled) {
    return true
  }

  return false
}
