import {
  SPONSORED_CONSENT_IN_PLACE_SENTENCE,
  SPONSORED_CONSENT_NO_NAME,
  sponsoredConsentName,
} from '@codebuff/common/ads/sponsored-consent'
import {
  SPONSORED_STEP_STATE_LABEL,
  sponsoredProposalAction,
  sponsoredProposalMenu,
  sponsoredProposalViewModel,
} from '@codebuff/common/ads/sponsored-proposal-view'
import { TextAttributes } from '@opentui/core'
import { useKeyboard } from '@opentui/react'
import React, { useCallback, useEffect, useState } from 'react'

import { Button } from '../button'
import { useMessageBlockStore } from '../../state/message-block-store'
import { getAuthToken } from '../../utils/auth'
import { safeOpen } from '../../utils/open-url'
import { acknowledgeSponsoredProposalDisplay } from '../../utils/sponsored-proposal-api'
import { isPlainEnterKey } from '../../utils/terminal-enter-detection'
import {
  sponsoredCliCanRun,
  sponsoredCliUnavailableCopy,
} from '../../utils/sponsored-availability'
import { useTheme } from '../../hooks/use-theme'

import type { SponsoredProposalContentBlock } from '../../types/chat'
import type { SponsoredProposalMenuKey } from '@codebuff/common/ads/sponsored-proposal-view'
import type { KeyEvent } from '@opentui/core'

/**
 * The sponsored proposal, in the terminal's SPONSOR DOCK (#3989's flow, ported).
 *
 * Every string here comes from the shared view model, so this is the SAME state
 * machine the web panel and the desktop card run -- a card that reads
 * differently here is a bug rather than a port.
 *
 * ## Where it lives, and what the "button" is
 *
 * In the dock above the composer, in place of the display ad: one slot, one ad,
 * exactly as Desktop's card replaces its banner. It used to be a block in the
 * transcript, reachable only by typing `/ads:accept-proposal`, and it scrolled
 * away with the conversation. Now it stays put, and it has real controls:
 *
 *  - `[ Set it up ]` and `Not now` are mouse-clickable `Button`s (the display
 *    ad's CTA already is one);
 *  - Ctrl+O opens the details, where the arrows and Enter reach the same two
 *    answers plus the standing controls;
 *  - the `/ads:*` commands still work, for a terminal with no mouse.
 *
 * `Set it up` OPENS THE CONSENT and never accepts. The consent is the decision
 * (COD-336 item 4, adapted in `utils/sponsored-run.ts`); a click is a gesture.
 *
 * ## No bare keys while it is closed
 *
 * `useKeyboard` is a GLOBAL listener, not a focus-scoped one, so a bare `m`,
 * `esc` or `enter` bound here would reach the composer's handler as well: a
 * letter typed into a prompt would open an ad's menu, and an Esc aimed at
 * something else would be read as a decline. So while nothing is open this
 * component binds nothing; Ctrl+O is chat's, verified unclaimed
 * (`keyboard-actions.ts`). Once the details or the consent ARE open, chat's
 * keyboard is disabled for exactly that span (the same `disabled` askUser
 * uses), and the arrows, Enter, Esc -- and `v` for the consent's steps -- have
 * one owner.
 *
 * Two terminal-specific declared waivers remain: the advertiser LOGO is never
 * fetched (R-16/R-17), and a pull request URL from an older run is printed as
 * sanitized text (R-15). The advertiser's own setup link is now OPENABLE by a
 * click, through the same `safeOpen` the display ad uses -- after the same
 * destination gate (`advertiserCtaHref` is null for anything that is not
 * absolute https) -- and is printed beside the button for a terminal with no
 * mouse.
 */

/** The narrowest width the card is designed for; below it, body copy goes first. */
export const PROPOSAL_MIN_BODY_WIDTH = 40

/** How many lines of the reviewed procedure the consent shows when expanded. */
export const CONSENT_PROCEDURE_MAX_LINES = 12

const DISCLOSURE = 'SPONSORED'

/**
 * The narrowest an advertiser's name may be before the header stacks.
 *
 * Twelve, because that is `Acme Deploys` -- the shortest name in the shared
 * fixtures -- and a name clipped shorter than its own first word identifies
 * nobody, which is the half of the disclosure that actually names who is
 * advertising.
 */
const MIN_INLINE_NAME_WIDTH = 12

/** `[ Set it up ]` + two columns + `Not now`, with room to spare. */
const BUTTON_ROW_MIN_WIDTH = 24

/** The chord that opens the details, as the dock prints it. */
export const PROPOSAL_DOCK_CHORD = '⌃O details'

/** Clip to the available columns without wrapping — a terminal has no ellipsis box. */
function clip(text: string, width: number): string {
  if (width <= 1) return ''
  return text.length <= width
    ? text
    : `${text.slice(0, Math.max(0, width - 1))}…`
}

/** The in-place run's progress and verdict, as the dock needs it. */
export type SponsoredDockRun = {
  phase: 'accepting' | 'queued' | 'running' | 'delivered' | 'failed'
  changedFiles: readonly string[]
  undone: boolean
}

export const SponsoredProposalBlock: React.FC<{
  block: SponsoredProposalContentBlock
  availableWidth: number
  /** This machine's run for this proposal, when there is one. */
  run?: SponsoredDockRun | null
}> = ({ block, availableWidth, run = null }) => {
  const theme = useTheme()
  const callbacks = useMessageBlockStore((s) => s.callbacks)
  const [menuIndex, setMenuIndex] = useState(0)

  const [consentIndex, setConsentIndex] = useState(0)

  useEffect(() => {
    // OpenTUI runs effects only after this block mounts into the terminal
    // renderer; storing it in the transcript alone is not a displayed offer.
    if (block.proposal.state !== 'offered') return
    const token = getAuthToken()
    if (!token) return
    void acknowledgeSponsoredProposalDisplay(block.proposal._id, token)
  }, [block.proposal._id, block.proposal.state])

  const view = sponsoredProposalViewModel(block.proposal)
  const width = Math.max(20, availableWidth)
  const accept = sponsoredProposalAction(view, 'accept')
  // The Accept is offered only when this machine can contain a run. An Accept
  // that refuses is worse than an Accept that is not there with a sentence
  // beside it saying why -- which is what `unavailable` renders instead.
  const canRun = sponsoredCliCanRun()
  const refreshUnavailable = block.refreshUnavailable === true
  // No Accept once this machine has a run for the offer: the row can still
  // read `offered` for a poll after the Accept, and a second Accept there is
  // an answer to a question already answered.
  const acceptable =
    accept !== null &&
    canRun &&
    !answeredOrBusy(block) &&
    !refreshUnavailable &&
    !run
  const menu = sponsoredProposalMenu(view.advertiserName, {
    ...(acceptable && accept ? { acceptLabel: accept.label } : {}),
  })
  const openPullRequest = sponsoredProposalAction(view, 'open-pull-request')
  const openAdvertiser = sponsoredProposalAction(view, 'open-advertiser')
  const answered = block.answered === true
  const busy = block.busy === true
  const consent = refreshUnavailable ? null : (block.consent ?? null)
  // Clamped exactly as the desktop bridge clamps it: the name is the only
  // advertiser-authored text left on a one-sentence consent, which makes it the
  // whole attack surface.
  const consentName = consent
    ? sponsoredConsentName(consent.advertiserName)
    : ''
  const consentChoices: readonly string[] = consentName
    ? CONSENT_CHOICES
    : CONSENT_CHOICES_NO_NAME
  // The refusal sentence, shown only where an Accept would otherwise be: a
  // terminal that explained the Windows containment story on a `failed` card
  // would be answering a question nobody asked.
  const unavailable =
    view.state === 'offered' && !canRun ? sponsoredCliUnavailableCopy() : null
  // The run's verdict arrives HERE before the row catches up: the local
  // snapshot is `delivered` the moment the receipts are read, and the poll
  // follows on its own cadence.
  const delivered = run?.phase === 'delivered' || view.state === 'delivered'
  const runPhase = run?.phase ?? null
  const inFlight =
    runPhase === 'accepting' || runPhase === 'queued' || runPhase === 'running'

  const onMenuKey = useCallback(
    (key: SponsoredProposalMenuKey) => {
      if (key === 'why') {
        callbacks.onSponsoredProposalDisclose(block.target, !block.whyOpen)
        return
      }
      if (key === 'accept') {
        callbacks.onSponsoredProposalAccept(block.target)
        return
      }
      callbacks.onSponsoredProposalControl(block.target, key)
    },
    [block.target, block.whyOpen, callbacks],
  )

  // ONLY WHILE THE MENU OR THE CONSENT IS OPEN. See the header: a bare key
  // bound while closed would reach the composer too.
  useKeyboard(
    useCallback(
      (key: KeyEvent) => {
        if (refreshUnavailable) return
        if (!block.menuOpen && !consent) return
        const preventDefault = () => {
          if (
            'preventDefault' in key &&
            typeof key.preventDefault === 'function'
          ) {
            key.preventDefault()
          }
        }

        // THE CONSENT OWNS THE KEYBOARD WHILE IT IS OPEN, and it is checked
        // before the menu because opening it closes the menu -- so the two are
        // never both live.
        //
        // Esc is REFUSE, and refusing writes nothing at all: the accept has not
        // happened yet, which is the whole reason the consent comes first. The
        // row stays `offered`.
        if (consent) {
          if (key.name === 'escape') {
            preventDefault()
            callbacks.onSponsoredProposalConsent(block.target, false)
            return
          }
          // `v` shows or hides the reviewed procedure -- the exact text whose
          // SHA-256 the Accept binds. Reading it is optional; being able to is
          // not.
          if (key.name === 'v' && !key.ctrl && !key.meta) {
            preventDefault()
            callbacks.onSponsoredProposalProcedure(
              block.target,
              !block.procedureOpen,
            )
            return
          }
          if (key.name === 'up' || key.name === 'down') {
            preventDefault()
            // With no name there is one choice, so the caret has nowhere to go
            // -- the same property as the disabled Yes on the desktop dialog.
            if (consentChoices.length > 1)
              setConsentIndex((index) => (index === 0 ? 1 : 0))
            return
          }
          if (isPlainEnterKey(key)) {
            preventDefault()
            // INDEX 0 IS "NO". The consequential choice is not the default: a
            // consent screen whose caret starts on "run it" is a consent screen
            // that an impatient Enter answers yes.
            callbacks.onSponsoredProposalConsent(
              block.target,
              consentChoices.length > 1 && consentIndex === 1,
            )
          }
          return
        }

        // Esc closes the MENU and answers nothing. Ctrl+C stays unbound: in a
        // terminal that is "stop", not an answer to an ad.
        if (key.name === 'escape') {
          preventDefault()
          callbacks.onSponsoredProposalMenu(block.target, false)
          return
        }

        // A spent card keeps Esc above -- it must always be possible to close
        // the menu -- but activates nothing.
        if (answered || busy) return

        if (key.name === 'up') {
          preventDefault()
          setMenuIndex((index) => (index - 1 + menu.length) % menu.length)
          return
        }
        if (key.name === 'down') {
          preventDefault()
          setMenuIndex((index) => (index + 1) % menu.length)
          return
        }
        if (isPlainEnterKey(key)) {
          preventDefault()
          callbacks.onSponsoredProposalMenu(block.target, false)
          onMenuKey(menu[menuIndex]!.key)
        }
      },
      [
        answered,
        busy,
        block.menuOpen,
        block.procedureOpen,
        block.target,
        callbacks,
        consent,
        consentChoices,
        consentIndex,
        menu,
        menuIndex,
        onMenuKey,
        refreshUnavailable,
      ],
    ),
  )

  // The menu opens on its first item every time it is OPENED -- and only then.
  // Same rule for the consent, and it matters more there: the caret must start
  // on "No" every single time it opens.
  const wasConsentOpen = React.useRef(consent !== null)
  React.useEffect(() => {
    const open = consent !== null
    if (open && !wasConsentOpen.current) setConsentIndex(0)
    wasConsentOpen.current = open
  }, [consent])

  const wasMenuOpen = React.useRef(block.menuOpen === true)
  React.useEffect(() => {
    const open = block.menuOpen === true
    if (open && !wasMenuOpen.current) setMenuIndex(0)
    wasMenuOpen.current = open
  }, [block.menuOpen])

  const inner = Math.max(1, width - 2)
  const expanded = block.menuOpen === true && !refreshUnavailable
  // At the narrowest widths the disclosure and the advertiser must both survive;
  // the body is what goes first and the headline is what goes last.
  const showBody =
    view.state === 'offered' && expanded && inner >= PROPOSAL_MIN_BODY_WIDTH
  const nameRoom = inner - DISCLOSURE.length - 1
  // STACKED, not squeezed: at 20 columns sharing one row turned `Acme Deploys`
  // into `Acme De` butted against the marker, which identifies nobody.
  const stackHeader = nameRoom < MIN_INLINE_NAME_WIDTH
  const procedureLines = consent
    ? consent.procedure.split('\n').slice(0, CONSENT_PROCEDURE_MAX_LINES)
    : []

  return (
    <box
      style={{
        width,
        flexDirection: 'column',
        borderStyle: 'single',
        borderColor: theme.muted,
        paddingLeft: 1,
        paddingRight: 1,
        overflow: 'hidden',
      }}
    >
      {stackHeader ? (
        <box style={{ width: '100%', flexDirection: 'column' }}>
          <text style={{ fg: theme.muted, wrapMode: 'none' }}>
            {DISCLOSURE}
          </text>
          <text
            style={{ fg: theme.foreground, wrapMode: 'none' }}
            attributes={TextAttributes.BOLD}
          >
            {clip(view.advertiserName, inner)}
          </text>
        </box>
      ) : (
        <box
          style={{
            width: '100%',
            flexDirection: 'row',
            justifyContent: 'space-between',
            overflow: 'hidden',
          }}
        >
          <text
            style={{ fg: theme.foreground, flexShrink: 1, wrapMode: 'none' }}
            attributes={TextAttributes.BOLD}
          >
            {clip(view.advertiserName, nameRoom)}
          </text>
          <text style={{ fg: theme.muted, flexShrink: 0, wrapMode: 'none' }}>
            {DISCLOSURE}
          </text>
        </box>
      )}

      <text style={{ fg: theme.foreground }}>
        {clip(
          delivered
            ? 'Sponsored changes applied to your files'
            : inFlight && runPhase !== 'running'
              ? 'Starting in this conversation…'
              : view.headline,
          inner,
        )}
      </text>
      {showBody && <text style={{ fg: theme.muted }}>{view.body}</text>}
      {showBody && canRun && (
        <text style={{ fg: theme.muted }}>
          It edits files in this folder. Nothing is committed, and /ads:undo
          puts them back.
        </text>
      )}

      {(runPhase === 'running' || view.state === 'running') &&
        view.steps.length > 0 && (
          <box style={{ width: '100%', flexDirection: 'column' }}>
            <text style={{ fg: theme.muted, wrapMode: 'none' }}>
              {`${view.doneStepCount}/${view.steps.length}`}
            </text>
            {view.steps.map((step) => (
              <text
                key={step.text}
                style={{ fg: theme.muted, wrapMode: 'none' }}
              >
                {clip(
                  `${SPONSORED_STEP_STATE_LABEL[step.state]}  ${step.text}`,
                  inner,
                )}
              </text>
            ))}
          </box>
        )}
      {runPhase === 'running' && (
        <text style={{ fg: theme.muted, wrapMode: 'none' }}>
          {clip('Running in this conversation. Esc stops it.', inner)}
        </text>
      )}

      {delivered && run && !run.undone && (
        <text style={{ fg: theme.muted }}>
          {`Changed ${run.changedFiles.length === 1 ? '1 file' : `${run.changedFiles.length} files`}. Nothing was committed.`}
        </text>
      )}
      {delivered && run?.undone && (
        <text style={{ fg: theme.muted }}>These changes were undone.</text>
      )}
      {view.state === 'failed' && (
        <text style={{ fg: theme.muted }}>{view.failureReason}</text>
      )}
      {/* A row from a build that still ran the worktree flow. Nothing here
          produces one any more, but a card must not misdescribe it. */}
      {view.state === 'committed' && (
        <text style={{ fg: theme.muted }}>
          {view.branch
            ? `Committed to ${view.branch}. Nothing was pushed to your repository.`
            : 'Committed to its own branch. Nothing was pushed to your repository.'}
        </text>
      )}

      {/* SANITIZED TEXT, not a link (R-15): an older worktree run's PR.
          `pullRequestHref` is null for anything that is not absolute https. */}
      {openPullRequest?.href && (
        <text style={{ fg: theme.muted, wrapMode: 'none' }}>
          {clip(`${openPullRequest.label}: ${openPullRequest.href}`, inner)}
        </text>
      )}

      {/* THE ANSWERS ONCE THERE IS A DIFF: the advertiser's setup (the next
          step of the prepare-code -> account-setup -> verify format) and the
          undo. The destination is ALSO printed, gated, so a terminal with no
          mouse can still copy it. */}
      {openAdvertiser?.href && !refreshUnavailable && (
        <text style={{ fg: theme.muted, wrapMode: 'none' }}>
          {clip(`${openAdvertiser.label}: ${openAdvertiser.href}`, inner)}
        </text>
      )}
      {!refreshUnavailable &&
        (openAdvertiser?.href || (delivered && run && !run.undone)) && (
          <box style={{ width: '100%', flexDirection: 'row', gap: 2 }}>
            {openAdvertiser?.href && (
              <Button
                onClick={() => {
                  if (openAdvertiser.href) safeOpen(openAdvertiser.href)
                }}
              >
                <text
                  style={{ fg: theme.primary, wrapMode: 'none' }}
                  attributes={TextAttributes.BOLD}
                >
                  [ Open setup ]
                </text>
              </Button>
            )}
            {delivered && run && !run.undone && (
              <Button onClick={() => callbacks.onSponsoredProposalUndo()}>
                <text style={{ fg: theme.muted, wrapMode: 'none' }}>Undo</text>
              </Button>
            )}
          </box>
        )}

      {unavailable && <text style={{ fg: theme.muted }}>{unavailable}</text>}
      {refreshUnavailable && (
        <text style={{ fg: theme.muted }}>
          Could not refresh this proposal. Its controls will return when
          Freebuff reconnects.
        </text>
      )}

      {block.whyOpen && <text style={{ fg: theme.muted }}>{view.whyThis}</text>}

      {/* THE CONSENT: one sentence and two choices (COD-410), in the in-place
          words Desktop's dialog uses (#3989): it names the folder, says nothing
          is committed, and names the undo. The procedure is one keypress away
          and is the exact text the Accept binds. */}
      {consent && (
        <box style={{ width: '100%', flexDirection: 'column' }}>
          {consentName ? (
            <text style={{ fg: theme.foreground }}>
              <span attributes={TextAttributes.BOLD}>{consentName}</span>
              {SPONSORED_CONSENT_IN_PLACE_SENTENCE}
            </text>
          ) : (
            <text style={{ fg: theme.foreground }}>
              {SPONSORED_CONSENT_NO_NAME}
            </text>
          )}
          <text style={{ fg: theme.muted, wrapMode: 'none' }}>
            {clip(`Folder: ${consent.folder}`, inner)}
          </text>
          {block.procedureOpen &&
            procedureLines.map((line, index) => (
              <text
                key={`procedure-${index}`}
                style={{ fg: theme.muted, wrapMode: 'none' }}
              >
                {clip(line, inner)}
              </text>
            ))}
          {consentChoices.map((label, index) => (
            <text
              key={label}
              style={{
                fg: index === consentIndex ? theme.primary : theme.muted,
                wrapMode: 'none',
              }}
            >
              {clip(`${index === consentIndex ? '>' : ' '} ${label}`, inner)}
            </text>
          ))}
        </box>
      )}

      {expanded && !consent && (
        <box style={{ width: '100%', flexDirection: 'column' }}>
          {menu.map((item, index) => (
            <text
              key={item.key}
              style={{
                fg: index === menuIndex ? theme.primary : theme.muted,
                wrapMode: 'none',
              }}
            >
              {clip(`${index === menuIndex ? '>' : ' '} ${item.label}`, inner)}
            </text>
          ))}
        </box>
      )}

      {/* THE BUTTONS: the offer's two answers, clickable, on the collapsed
          dock. `Set it up` opens the consent; `Not now` is the decline R-2
          owes every state. */}
      {view.state === 'offered' &&
        !answered &&
        !refreshUnavailable &&
        !consent &&
        !expanded &&
        !run && (
          // STACKED below 24 columns: side by side, `[ Set it up ]  Not now`
          // clipped to `[ Set it u Not n` at the 20-column floor, which is two
          // buttons nobody can read.
          <box
            style={{
              width: '100%',
              flexDirection: inner >= BUTTON_ROW_MIN_WIDTH ? 'row' : 'column',
              gap: inner >= BUTTON_ROW_MIN_WIDTH ? 2 : 0,
            }}
          >
            {acceptable && (
              <Button
                onClick={() =>
                  callbacks.onSponsoredProposalAccept(block.target)
                }
              >
                <text
                  style={{ fg: theme.primary, wrapMode: 'none' }}
                  attributes={TextAttributes.BOLD}
                >
                  [ Set it up ]
                </text>
              </Button>
            )}
            {!busy && (
              <Button
                onClick={() =>
                  callbacks.onSponsoredProposalControl(block.target, 'dismiss')
                }
              >
                <text style={{ fg: theme.muted, wrapMode: 'none' }}>
                  Not now
                </text>
              </Button>
            )}
          </box>
        )}

      {!answered && !refreshUnavailable && (
        <text style={{ fg: theme.muted, wrapMode: 'none' }}>
          {hintFor(hintMode(block, acceptable), inner)}
        </text>
      )}
    </box>
  )
}

/**
 * Two choices, refusal first. The words themselves and the sentence above them
 * live in `@codebuff/common/ads/sponsored-consent`, which the desktop dialog
 * mirrors -- the two surfaces ask the same question, and a reader who has seen
 * one must recognise the other.
 */
const CONSENT_CHOICES = ['No', 'Yes'] as const
/** Nameless, the only thing left to offer is the refusal. */
const CONSENT_CHOICES_NO_NAME = ['No'] as const

function answeredOrBusy(block: SponsoredProposalContentBlock): boolean {
  return block.answered === true || block.busy === true
}

export type ProposalHintMode = 'closed' | 'acceptable' | 'menu' | 'consent'

/** Which hint the dock is owed, given what is open and what is on offer. */
export function hintMode(
  block: SponsoredProposalContentBlock,
  acceptable: boolean,
): ProposalHintMode {
  if (block.consent) return 'consent'
  if (block.menuOpen) return 'menu'
  return acceptable ? 'acceptable' : 'closed'
}

/**
 * The hint line.
 *
 * While nothing is open the dock binds no bare key, so the hint names the
 * CHORD (and, where there is no Accept, the decline command). An open menu or
 * consent is the span where the dock owns the keyboard, and the hint says so.
 *
 * IT NAMES ACCEPT only where there is one: `acceptable` is false on a machine
 * that cannot contain a run, so a Windows card never says the word.
 */
export function hintFor(mode: ProposalHintMode, width = Infinity): string {
  // KEPT SHORT ON PURPOSE. `inner` is the content width less the border, but
  // the box also has a column of padding on each side, so a line of exactly
  // `inner` characters loses its last two to the frame.
  const full = HINT_FULL[mode]
  if (full.length <= width) return full
  // Clipping mid-token teaches the user a command that does not exist, which is
  // worse than a shorter line that names one real thing.
  const compact = HINT_COMPACT[mode]
  return compact.length <= width ? compact : ''
}

const HINT_FULL: Record<ProposalHintMode, string> = {
  closed: `${PROPOSAL_DOCK_CHORD} · /ads:dismiss-proposal`,
  acceptable: `${PROPOSAL_DOCK_CHORD} · /ads:accept-proposal`,
  menu: '↑↓ move · enter choose · esc close',
  consent: '↑↓ · enter choose · v steps · esc cancel',
}

/**
 * The last thing that still fits. Every entry is a WHOLE command or a whole
 * key name — never a prefix of one.
 */
const HINT_COMPACT: Record<ProposalHintMode, string> = {
  closed: PROPOSAL_DOCK_CHORD,
  acceptable: PROPOSAL_DOCK_CHORD,
  menu: 'enter · esc',
  consent: 'enter · esc',
}
