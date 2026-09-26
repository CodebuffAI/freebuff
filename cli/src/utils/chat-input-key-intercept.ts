import { isPlainEnterKey } from './terminal-enter-detection'

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
}

export function shouldInterceptChatInputKey(
  key: ChatInputKey,
  state: ChatInputKeyInterceptState,
): boolean {
  if (state.inputLength === 0 && (!state.inputMode || state.inputMode === 'default' || state.inputMode === 'help') && !key.ctrl && !key.meta && !key.option) {
    if (key.sequence === '?' || key.name === '?' || (key.name === 'left' && !key.shift)) return true
  }
  if (state.inputLength > 0 && ['left', 'right', 'up', 'down'].includes(key.name ?? '') && !key.ctrl && !key.meta && !key.option) return false
  const isPlainEnter = isPlainEnterKey(key)
  const isTab = key.name === 'tab' && !key.ctrl && !key.meta && !key.option
  const isUp = key.name === 'up' && !key.ctrl && !key.meta && !key.option
  const isDown = key.name === 'down' && !key.ctrl && !key.meta && !key.option
  const isUpDown = isUp || isDown

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
  if (isUp && state.inputLength === 0 && historyUpEnabled) {
    return true
  }
  if (isDown && state.inputLength === 0 && historyDownEnabled) {
    return true
  }

  return false
}
