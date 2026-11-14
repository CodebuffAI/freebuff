import {
  AD_REPORT_REASON_MIN_LENGTH,
  AD_REPORT_REASON_MAX_LENGTH,
  AdReportReasonSchema,
} from '@codebuff/common/ads/ad-report'
import { sanitizeTerminalText } from '@codebuff/common/util/terminal-safe-text'
import { useKeyboard } from '@opentui/react'
import React, { useState, useSyncExternalStore } from 'react'

import { Button } from './button'
import { MultilineInput } from './multiline-input'
import {
  adReports,
  type AdReportPrompt as ReportPrompt,
  type AdReportRegistry,
} from '../ads/ad-reports'
import { useTheme } from '../hooks/use-theme'
import { createTextPasteHandler } from '../utils/strings'
import { isPlainEnterKey } from '../utils/terminal-enter-detection'
import { BORDER_CHARS } from '../utils/ui-constants'

export function useAdReportPrompt(registry: AdReportRegistry = adReports) {
  return useSyncExternalStore(registry.subscribe, registry.getPrompt)
}

/** A private client form: never the composer, history, transcript, or model. */
export function AdReportPrompt({
  prompt,
  registry = adReports,
}: {
  prompt: ReportPrompt
  registry?: AdReportRegistry
}) {
  const theme = useTheme()
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const [field, setField] = useState(0)
  const { entry } = prompt
  const status = useSyncExternalStore(
    (listener) => {
      entry.listeners.add(listener)
      return () => {
        entry.listeners.delete(listener)
      }
    },
    () => entry.status,
  )
  const busy = status === 'sending'
  const valid = AdReportReasonSchema.safeParse(value).success
  const submit = () => {
    if (valid && !busy) void registry.submit(entry, value, prompt.send)
  }
  useKeyboard((key) => {
    if (busy) return
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
      key.preventDefault()
      registry.cancel()
    } else if (key.ctrl && key.name === 's') {
      key.preventDefault()
      submit()
    } else if (key.name === 'tab') {
      key.preventDefault()
      setField((current) => (current + (key.shift ? 2 : 1)) % 3)
    } else if (field !== 0 && isPlainEnterKey(key)) {
      key.preventDefault()
      if (field === 1) submit()
      else registry.cancel()
    }
  })
  const change = ({
    text,
    cursorPosition,
  }: {
    text: string
    cursorPosition: number
  }) => {
    if (busy) return
    setValue(text)
    setCursor(cursorPosition)
  }
  return (
    <box
      border
      borderStyle="single"
      borderColor={theme.primary}
      customBorderChars={BORDER_CHARS}
      style={{ flexDirection: 'column', paddingLeft: 1, paddingRight: 1 }}
    >
      <text style={{ fg: theme.foreground }}>
        {`Report ad ${entry.id}: ${sanitizeTerminalText(entry.snapshot.title)}`}
      </text>
      <text style={{ fg: theme.secondary }}>
        {`Explain the problem (${AD_REPORT_REASON_MIN_LENGTH}–${AD_REPORT_REASON_MAX_LENGTH} characters).`}
      </text>
      <box onMouseDown={() => setField(0)}>
        <MultilineInput
          value={value}
          cursorPosition={cursor}
          onChange={change}
          onSubmit={() => {}}
          onKeyIntercept={(key) => {
            // Enter edits the explanation; submitting is always deliberate.
            if (!isPlainEnterKey(key)) return false
            key.preventDefault()
            change({
              text: value.slice(0, cursor) + '\n' + value.slice(cursor),
              cursorPosition: cursor + 1,
            })
            return true
          }}
          onPaste={createTextPasteHandler(value, cursor, change)}
          placeholder="What is wrong with this ad?"
          focused={field === 0 && !busy}
          minHeight={3}
          maxHeight={5}
        />
      </box>
      <text style={{ fg: valid ? theme.muted : theme.warning }}>
        {`${value.trim().length}/${AD_REPORT_REASON_MAX_LENGTH} characters${valid ? '' : ` · Enter ${AD_REPORT_REASON_MIN_LENGTH}–${AD_REPORT_REASON_MAX_LENGTH} characters to submit`}`}
      </text>
      {status === 'error' && (
        <text style={{ fg: theme.error }}>
          Could not send the report. Your explanation is saved here; try again.
        </text>
      )}
      <box style={{ flexDirection: 'row', gap: 2 }}>
        <Button onClick={submit}>
          <text style={{ fg: valid && !busy ? theme.primary : theme.muted }}>
            {`${field === 1 ? '› ' : ''}[${busy ? 'Sending…' : 'Submit report'}]`}
          </text>
        </Button>
        <Button onClick={() => registry.cancel()}>
          <text style={{ fg: busy ? theme.muted : theme.secondary }}>
            {`${field === 2 ? '› ' : ''}[Cancel]`}
          </text>
        </Button>
      </box>
      <text style={{ fg: theme.muted }}>
        Ctrl+S submit · Esc cancel · Tab choose a button · Enter newline
      </text>
    </box>
  )
}
