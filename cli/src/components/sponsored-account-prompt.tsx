import {
  UNFILLED_CLICK_ID_BLOCKED_METRIC,
  isUnfilledClickIdUrl,
} from '@codebuff/common/ads/sponsored-run-links'
import {
  decodePasteBytes,
  stripAnsiSequences,
  TextAttributes,
} from '@opentui/core'
import { useAppContext, useKeyboard } from '@opentui/react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { TerminalLink } from './terminal-link'
import { useTheme } from '../hooks/use-theme'
import { logger } from '../utils/logger'
import { safeOpen } from '../utils/open-url'
import {
  SPONSORED_SIGNUP_NO,
  SPONSORED_SIGNUP_YES,
} from '../utils/sponsored-account-step'
import { isPlainEnterKey } from '../utils/terminal-enter-detection'
import { BORDER_CHARS } from '../utils/ui-constants'

import type {
  SponsoredAccountAnswer,
  SponsoredAccountAsk,
} from '../utils/sponsored-account-step'
import type { KeyEvent, PasteEvent } from '@opentui/core'

/** What the masked field shows instead of the key. */
export function maskedSponsoredKey(value: string): string {
  return value.length === 0 ? '' : '•'.repeat(Math.min(value.length, 32))
}

/**
 * The last guard before a sponsored link is drawn or opened (COD-965): one
 * that still has an unfilled click id is neither. The account step already
 * resolved and guarded it; this only catches a path that did not.
 */
export function shownSponsoredLink(url: string | undefined): string | null {
  if (!url) return null
  if (!isUnfilledClickIdUrl(url)) return url
  logger.warn(
    {
      metric: UNFILLED_CLICK_ID_BLOCKED_METRIC,
      surface: 'cli',
      fallback: 'none',
    },
    '[sponsored-account] blocked a link with an unfilled click id',
  )
  return null
}

function preventDefault(key: KeyEvent): void {
  if ('preventDefault' in key && typeof key.preventDefault === 'function')
    key.preventDefault()
}

/** A printable key press, or null (control keys, modifiers). */
function typed(key: KeyEvent): string | null {
  if (!key.sequence || key.ctrl || key.meta || key.option) return null
  return /^[\x21-\x7e]+$/.test(key.sequence) ? key.sequence : null
}

/**
 * The account step a sponsored run is waiting on, in the composer's place
 * (`sponsored-account-step.ts`): the sign-in question, or the masked key form.
 *
 * The key is typed or pasted into this component's own state and goes
 * straight to the run's in-memory hold: never into the chat input, its
 * history, the transcript or the model's context. It is drawn as dots.
 */
export const SponsoredAccountPrompt: React.FC<{
  ask: SponsoredAccountAsk
  onAnswer: (answer: SponsoredAccountAnswer) => string | null
  /** Ctrl-C: stop the sponsored run, as it does everywhere else in chat. */
  onInterrupt?: () => void
  /** Opens a link the user clicks; injected by tests. */
  openUrl?: (url: string) => void
}> = ({ ask, onAnswer, onInterrupt, openUrl = safeOpen }) => {
  const theme = useTheme()
  const { keyHandler } = useAppContext()
  const [choice, setChoice] = useState(0)
  const [field, setField] = useState(0)
  const [values, setValues] = useState<string[]>([])
  const fields = ask.kind === 'credentials' ? ask.credentials : []

  // A new question starts clean.
  useEffect(() => {
    setChoice(0)
    setField(0)
    setValues([])
  }, [ask.kind])

  const edit = useCallback(
    (change: (value: string) => string) => {
      setValues((current) => {
        const next = [...current]
        next[field] = change(current[field] ?? '').slice(0, 4096)
        return next
      })
    },
    [field],
  )

  const submit = useCallback(() => {
    if (ask.kind === 'signin') {
      onAnswer({ kind: 'signin', confirmed: choice === 0 })
      return
    }
    if (field < fields.length - 1 && (values[field] ?? '').length > 0) {
      setField(field + 1)
      return
    }
    const answer: Record<string, string> = {}
    fields.forEach((credential, index) => {
      answer[credential.env] = values[index] ?? ''
    })
    onAnswer({ kind: 'credentials', values: answer })
  }, [ask.kind, choice, field, fields, onAnswer, values])

  // Pastes land in the focused key field, never in the chat input.
  const pasteRef = useRef<(text: string) => void>(() => {})
  pasteRef.current = (text) => {
    if (ask.kind !== 'credentials') return
    edit((value) => value + text.trim())
  }
  useEffect(() => {
    if (!keyHandler) return
    const onPaste = (event: PasteEvent) => {
      pasteRef.current(stripAnsiSequences(decodePasteBytes(event.bytes)))
    }
    keyHandler.on('paste', onPaste)
    return () => {
      keyHandler.off('paste', onPaste)
    }
  }, [keyHandler])

  useKeyboard(
    useCallback(
      (key: KeyEvent) => {
        // Ctrl-C keeps its meaning: it stops the sponsored run. Esc skips
        // only this step, and the run carries on without the account.
        if (key.ctrl && key.name === 'c') {
          preventDefault(key)
          onAnswer({ kind: 'skip' })
          onInterrupt?.()
          return
        }
        if (key.name === 'escape') {
          preventDefault(key)
          onAnswer({ kind: 'skip' })
          return
        }
        if (isPlainEnterKey(key)) {
          preventDefault(key)
          submit()
          return
        }
        if (ask.kind === 'signin') {
          if (key.name === 'up' || key.name === 'down' || key.name === 'tab') {
            preventDefault(key)
            setChoice((current) => (current === 0 ? 1 : 0))
          } else if (key.name === 'y' && !key.ctrl && !key.meta) {
            preventDefault(key)
            onAnswer({ kind: 'signin', confirmed: true })
          } else if (key.name === 'n' && !key.ctrl && !key.meta) {
            preventDefault(key)
            onAnswer({ kind: 'signin', confirmed: false })
          }
          return
        }
        if (key.name === 'backspace') {
          preventDefault(key)
          edit((value) => value.slice(0, -1))
          return
        }
        if (key.name === 'tab' || key.name === 'up' || key.name === 'down') {
          preventDefault(key)
          if (fields.length > 1)
            setField((current) =>
              key.name === 'up' || key.shift
                ? Math.max(0, current - 1)
                : Math.min(fields.length - 1, current + 1),
            )
          return
        }
        const text = typed(key)
        if (text !== null) {
          preventDefault(key)
          edit((value) => value + text)
        }
      },
      [ask.kind, edit, fields.length, onAnswer, onInterrupt, submit],
    ),
  )

  // Once per question, not per keystroke: the guard logs what it blocks.
  const signinUrl = useMemo(
    () => (ask.kind === 'signin' ? shownSponsoredLink(ask.url) : null),
    [ask],
  )
  const shownLinks = useMemo(
    () => fields.map((credential) => shownSponsoredLink(credential.getUrl)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ask],
  )

  const title =
    ask.kind === 'signin'
      ? ' Sign in to continue '
      : ` Connect ${ask.offerName} `

  return (
    <box
      title={title}
      titleAlignment="center"
      style={{
        width: '100%',
        flexDirection: 'column',
        borderStyle: 'single',
        borderColor: theme.primary,
        customBorderChars: BORDER_CHARS,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      {ask.kind === 'signin' ? (
        <>
          <text style={{ fg: theme.foreground, wrapMode: 'word' }}>
            {ask.opened
              ? `To finish your free ${ask.offerName}, please sign in to the browser tab I just opened.`
              : `To finish your free ${ask.offerName}, please sign in at this link:`}
          </text>
          {signinUrl ? (
            <TerminalLink
              text={signinUrl}
              lineWrap
              onActivate={() => openUrl(signinUrl)}
            />
          ) : null}
          {[SPONSORED_SIGNUP_YES, SPONSORED_SIGNUP_NO].map((label, index) => (
            <text
              key={label}
              style={{
                fg: index === choice ? theme.primary : theme.muted,
              }}
              attributes={index === choice ? TextAttributes.BOLD : undefined}
            >
              {`${index === choice ? '›' : ' '} ${label}`}
            </text>
          ))}
          <text style={{ fg: theme.muted }}>
            ↑↓ choose · Enter confirm · Esc no
          </text>
        </>
      ) : (
        <>
          <text style={{ fg: theme.foreground, wrapMode: 'word' }}>
            {`The sponsored task needs your ${ask.offerName} key. It is used for this task's commands, saved to your project's git-ignored env file, and never shown to the agent.`}
          </text>
          {fields.map((credential, index) => (
            <box key={credential.env} style={{ flexDirection: 'column' }}>
              <text
                style={{ fg: index === field ? theme.primary : theme.muted }}
                attributes={index === field ? TextAttributes.BOLD : undefined}
              >
                {`${credential.label} (${credential.env})`}
              </text>
              {shownLinks[index] ? (
                <TerminalLink
                  text={shownLinks[index]!}
                  lineWrap
                  onActivate={() => openUrl(shownLinks[index]!)}
                />
              ) : null}
              <text style={{ fg: theme.foreground }}>
                {`${index === field ? '›' : ' '} ${maskedSponsoredKey(values[index] ?? '')}${index === field ? '▏' : ''}`}
              </text>
            </box>
          ))}
          {ask.error ? (
            <text style={{ fg: theme.error, wrapMode: 'word' }}>
              {ask.error}
            </text>
          ) : null}
          <text style={{ fg: theme.muted }}>
            Paste or type the key · Enter connect · Esc skip
          </text>
        </>
      )}
    </box>
  )
}
