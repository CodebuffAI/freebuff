import { getSystemMessage } from '../utils/message-history'
import { closeEverestBridge } from '../utils/everest-compression'
import { loadSettings, saveSettings } from '../utils/settings'

import type { RouterParams } from './command-registry'

/** Explicit, local opt-in. This setting belongs to Freebuff, not Everest. */
export function handleEverestCommand(params: RouterParams, args: string): void {
  const action = args.trim().toLowerCase()
  let message: string
  if (action === 'on' || action === 'enable') {
    if (!Bun.which('everest')) {
      message =
        'Everest CLI was not found. Install Everest and run everest login, then use /everest on.'
    } else {
      saveSettings({ everestCompression: true })
      closeEverestBridge()
      message =
        loadSettings().everestCompression === true
          ? 'Everest compression enabled. Eligible terminal output will be sent to Everest before the agent sees it. Use /everest off to disable.'
          : 'Could not save the Everest setting.'
    }
  } else if (action === 'off' || action === 'disable') {
    saveSettings({ everestCompression: false })
    closeEverestBridge()
    message =
      loadSettings().everestCompression === false
        ? 'Everest compression disabled.'
        : 'Could not save the Everest setting.'
  } else if (action === '' || action === 'status') {
    message =
      loadSettings().everestCompression === true
        ? 'Everest compression is on. Eligible terminal output is sent to Everest. Use /everest off to disable.'
        : 'Everest compression is off. Use /everest on to enable it.'
  } else {
    message = 'Use /everest on, /everest off, or /everest status.'
  }
  params.setMessages((previous) => [...previous, getSystemMessage(message)])
  params.saveToHistory(params.inputValue.trim())
  params.setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
}
