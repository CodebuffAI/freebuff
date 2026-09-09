import {
  SPONSORED_CONSENT_NO_NAME,
  SPONSORED_CONSENT_SENTENCE,
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
import React, { useCallback, useState } from 'react'

import { useMessageBlockStore } from '../../state/message-block-store'
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
 * The sponsored proposal card, in a terminal (COD-376).
 *
 * Every string here comes from the shared view model, so this is the SAME state
 * machine the web panel and the desktop card run — a card that reads
 * differently here is a bug rather than a port.
 *
 * ACCEPT EXISTS NOW (COD-339) and runs LOCALLY, in a git worktree on this
 * machine, under the COD-336 boundary. It is not a primary on this surface --
 * at twenty columns there is no room for one -- so it is the first item of the
 * menu and the `/ads:accept-proposal` command, and it is drawn only when this
 * machine can actually contain a run. On Windows the card says why instead
 * (COD-336 item 3: worse product on Windows is the honest trade).
 *
 * Accepting opens the CONSENT panel below rather than starting anything. That
 * panel is the terminal's stand-in for Desktop's main-process dialog, and the
 * reasoning for the substitution is in `utils/sponsored-run.ts` -- it is an
 * adaptation of COD-336 item 4, not a re-opening of it.
 *
 * AND WHILE THE MENU IS CLOSED THERE ARE NO KEY BINDINGS AT ALL. `useKeyboard`
 * is a GLOBAL listener, not a focus-scoped one, so the bare `m`, `esc` and
 * `enter` this card used to claim ran ALONGSIDE the composer's own global
 * handler rather than instead of it: typing the letter `m` into a prompt also
 * opened an ad's menu, and Esc reached the card as a decline while it was
 * cancelling something else entirely. A transcript block cannot own a bare key
 * on a surface whose input is always live.
 *
 * The controls are slash commands instead -- `/ads:proposal` opens this menu,
 * `/ads:dismiss-proposal` declines, and the three standing ones
 * (`/ads:report-proposal`, `/ads:never-advertiser`, `/ads:proposals-off`)
 * already existed. Once the menu IS open the card takes arrows, Enter and Esc,
 * and chat's keyboard is disabled for exactly that span, the same way
 * `askUser` does it -- so those keys reach one handler rather than two.
 *
 * A pull request URL is therefore printed and never opened by a keypress. That
 * is the R-15 waiver read honestly: this surface renders sanitized text the
 * user may copy, not a link and not a primary.
 *
 * Two things a terminal does differently from the other two surfaces, and both
 * are declared waivers rather than omissions:
 *   - the advertiser LOGO is never fetched (R-16/R-17): a token is not rendered
 *     as an image and no request is minted for one, so the advertiser's name is
 *     the whole of the attribution.
 *   - a pull request URL is printed as sanitized TEXT rather than a link
 *     (R-15). The sanitizing still holds: `pullRequestHref` is null for anything
 *     that is not absolute https, and nothing else is ever printed.
 */

/** The narrowest width the card is designed for; below it, body copy goes first. */
export const PROPOSAL_MIN_BODY_WIDTH = 40

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

/** Clip to the available columns without wrapping — a terminal has no ellipsis box. */
function clip(text: string, width: number): string {
  if (width <= 1) return ''
  return text.length <= width
    ? text
    : `${text.slice(0, Math.max(0, width - 1))}…`
}

export const SponsoredProposalBlock: React.FC<{
  block: SponsoredProposalContentBlock
  availableWidth: number
}> = ({ block, availableWidth }) => {
  const theme = useTheme()
  const callbacks = useMessageBlockStore((s) => s.callbacks)
  const [menuIndex, setMenuIndex] = useState(0)

  const [consentIndex, setConsentIndex] = useState(0)

  const view = sponsoredProposalViewModel(block.proposal)
  const width = Math.max(20, availableWidth)
  const accept = sponsoredProposalAction(view, 'accept')
  // The Accept is offered only when this machine can contain a run. An Accept
  // that refuses is worse than an Accept that is not there with a sentence
  // beside it saying why -- which is what `unavailable` renders instead.
  const canRun = sponsoredCliCanRun()
  const refreshUnavailable = block.refreshUnavailable === true
  const acceptable =
    accept !== null && canRun && !answeredOrBusy(block) && !refreshUnavailable
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

  // ONLY WHILE THE MENU IS OPEN. `useKeyboard` registers a GLOBAL listener, so
  // anything bound here fires whatever the user is actually doing -- and chat's
  // composer has a global handler of its own, which does not stop firing
  // because a card exists. The bare bindings this replaced therefore reached
  // BOTH: `m` typed into a prompt also opened an ad menu, and Esc was read as a
  // decline while it was cancelling something else. An open menu is different
  // in kind: chat's keyboard is disabled for exactly that span (see `chat.tsx`,
  // the same `disabled` askUser uses), so these keys have one owner.
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
        // never both live, and an ordering that let them be would put two
        // handlers on one Enter.
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
            // INDEX 0 IS "NO". The destructive-looking choice is not the
            // default: a consent screen whose caret starts on "run it" is a
            // consent screen that an impatient Enter answers yes.
            callbacks.onSponsoredProposalConsent(
              block.target,
              consentChoices.length > 1 && consentIndex === 1,
            )
          }
          return
        }

        // Esc closes the MENU and answers nothing. It used to dismiss, which
        // made the ordinary "I opened this by accident" gesture record a
        // decline the user never chose -- and, because the binding was global,
        // could do so from an Esc aimed at something else. Ctrl+C stays
        // unbound for the same reason it always was: in a terminal that is
        // "stop", not an answer to an ad.
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
  // `/ads:proposal` does not remount the card, so without this a second open
  // would put the caret wherever the last one left it, on a different control
  // than the list visibly starts on. Tracked as a transition rather than
  // "reset whenever it is open", because the latter also fires after mount and
  // would undo a selection the user had already moved.
  // Same rule for the consent, and it matters more here: the caret must start
  // on "Not now" every single time it opens, because a caret left on "run it"
  // by a previous open is a screen an Enter answers yes without being read.
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
  // At the narrowest widths the disclosure and the advertiser must both survive;
  // the body is what goes first and the headline is what goes last.
  const showBody = view.state === 'offered' && inner >= PROPOSAL_MIN_BODY_WIDTH
  const nameRoom = inner - DISCLOSURE.length - 1
  // STACKED, not squeezed. Sharing one row costs the advertiser's name a
  // character for every character of "SPONSORED", and at 20 columns that turned
  // `Acme Deploys` into `Acme De` butted straight against the marker with no
  // space between them -- which reads as one word and identifies nobody. Two
  // rows is the honest trade: the card is a line taller and both halves of the
  // disclosure are intact.
  const stackHeader = nameRoom < MIN_INLINE_NAME_WIDTH

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

      <text style={{ fg: theme.muted, wrapMode: 'none' }}>
        {clip(view.title, inner)}
      </text>
      <text style={{ fg: theme.foreground }}>{clip(view.headline, inner)}</text>
      {showBody && <text style={{ fg: theme.muted }}>{view.body}</text>}

      {view.state === 'running' && view.steps.length > 0 && (
        <box style={{ width: '100%', flexDirection: 'column' }}>
          <text style={{ fg: theme.muted, wrapMode: 'none' }}>
            {`${view.doneStepCount}/${view.steps.length}`}
          </text>
          {view.steps.map((step) => (
            <text key={step.text} style={{ fg: theme.muted, wrapMode: 'none' }}>
              {clip(
                `${SPONSORED_STEP_STATE_LABEL[step.state]}  ${step.text}`,
                inner,
              )}
            </text>
          ))}
        </box>
      )}

      {view.state === 'committed' && (
        <text style={{ fg: theme.muted }}>
          {view.branch
            ? `Committed to ${view.branch}. Nothing was pushed to your repository.`
            : 'Committed to its own branch. Nothing was pushed to your repository.'}
        </text>
      )}
      {/* DELIVERY IS NAMED HERE RATHER THAN IN THE HINT. The hint line has room
          for two commands and R-2 spends one of them on the decline, which is
          the one control every state owes the user. So the two commands that
          only exist once there is a branch are named beside the branch. */}
      {view.state === 'committed' && (
        <text style={{ fg: theme.muted }}>
          Open a pull request with /ads:pull-request, or discard the workspace
          with /ads:remove-worktree.
        </text>
      )}
      {view.state === 'failed' && (
        <text style={{ fg: theme.muted }}>{view.failureReason}</text>
      )}

      {/* SANITIZED TEXT, not a link (R-15 is waived on this surface for exactly
          this reason). `pullRequestHref` is null for anything that is not
          absolute https, so nothing else ever reaches this line. */}
      {openPullRequest?.href && (
        <text style={{ fg: theme.muted, wrapMode: 'none' }}>
          {clip(`${openPullRequest.label}: ${openPullRequest.href}`, inner)}
        </text>
      )}

      {/* The advertiser CTA (COD-512), under the same waiver: sanitized text
          the user may copy, never a link. `advertiserCtaHref` is null for
          anything that is not absolute https. */}
      {openAdvertiser?.href && (
        <text style={{ fg: theme.muted, wrapMode: 'none' }}>
          {clip(`${openAdvertiser.label}: ${openAdvertiser.href}`, inner)}
        </text>
      )}

      {/* Owen, 2026-09-03: the offer names the worktree and nothing about
          cost. A local sponsored run still spends the user's own session and
          credits (COD-119's advertiser-pays metering has no server-side
          reader); the card just does not say so, and neither does Desktop. Do
          not put a "free" claim here until the server meters it to the
          advertiser. */}
      {view.state === 'offered' && canRun && showBody && (
        <text style={{ fg: theme.muted }}>
          It runs here, in its own worktree.
        </text>
      )}

      {unavailable && <text style={{ fg: theme.muted }}>{unavailable}</text>}
      {refreshUnavailable && (
        <text style={{ fg: theme.muted }}>
          Could not refresh this proposal. Its controls will return when
          Freebuff reconnects.
        </text>
      )}

      {block.whyOpen && <text style={{ fg: theme.muted }}>{view.whyThis}</text>}

      {/* THE CONSENT: one sentence and two choices (COD-410), the same words
          Desktop's main-process dialog says. It used to be a field list --
          headline, body, folder, branch, a paragraph of assurances -- and a
          list nobody reads is not informed consent however much it contains.
          The folder is the one this CLI is running in and the branch is
          covered by "its own branch"; a fact that does not change the
          decision is not on the screen. Refusable, and a refusal writes
          nothing at all -- nothing has been accepted yet. It cannot show the
          reviewed procedure TEXT because the accept response is the only place
          that exists; see `utils/sponsored-run.ts` for why that ordering is
          the one that keeps a Decline honest. */}
      {consent && (
        <box style={{ width: '100%', flexDirection: 'column' }}>
          {/* The name is the advertiser's and the sentence is ours, so they are two spans and
              never one string. `sponsoredConsentName` is the SAME clamp the desktop bridge
              applies: control characters and bidi overrides escaped rather than dropped, and the
              length capped at 80 -- unclamped, a 4,000-character name is a wall of text above the
              choices on a card that is otherwise all clipped single lines. Blank is not a legal
              render, so a nameless consent states a refusal and offers only the refusal. */}
          {consentName ? (
            <text style={{ fg: theme.foreground }}>
              <span attributes={TextAttributes.BOLD}>{consentName}</span>
              {SPONSORED_CONSENT_SENTENCE}
            </text>
          ) : (
            <text style={{ fg: theme.foreground }}>
              {SPONSORED_CONSENT_NO_NAME}
            </text>
          )}
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

      {block.menuOpen && !refreshUnavailable && (
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

/**
 * Which hint the card is owed, given what is open and what is on offer.
 *
 * THERE IS NO `committed` MODE, and that is a decision rather than an omission:
 * R-2 requires every state to name its one decline, and a hint that named
 * `/ads:pull-request` instead would have taken the decline off the card for
 * exactly the state where the user has most reason to want it. Delivery is in
 * the MENU, beside the Accept, for the same reason the Accept is: this surface
 * has no room for a primary, so the list of answers is where an answer lives.
 */
export function hintMode(
  block: SponsoredProposalContentBlock,
  acceptable: boolean,
): ProposalHintMode {
  if (block.consent) return 'consent'
  if (block.menuOpen) return 'menu'
  return acceptable ? 'acceptable' : 'closed'
}

/**
 * The hint line, and the reason it names COMMANDS rather than keys.
 *
 * While nothing is open this card holds no key bindings at all, because a
 * transcript block sharing a terminal with a live composer cannot own a bare
 * letter. So the hint names the slash commands that reach it. An open menu or
 * an open consent is the span where the card does own the keyboard, and the
 * hint says so.
 *
 * IT MAY NAME ACCEPT NOW, and only when there is one: `acceptable` is false on
 * a machine that cannot contain a run, so a Windows card still never says the
 * word. Naming a control that is not there is how a card starts looking like it
 * can run something it cannot.
 */
export function hintFor(mode: ProposalHintMode, width = Infinity): string {
  // KEPT SHORT ON PURPOSE. `inner` is the card's content width less its
  // border, but the box also has a column of padding on each side, so a line
  // of exactly `inner` characters loses its last two to the frame. A hint
  // naming two commands is long enough to hit that, and
  // `/ads:dismiss-proposa` teaches a command that does not exist.
  const full = HINT_FULL[mode]
  if (full.length <= width) return full
  // Clipping mid-token teaches the user a command that does not exist, which is
  // worse than a shorter line that names one real thing.
  const compact = HINT_COMPACT[mode]
  return compact.length <= width ? compact : ''
}

const HINT_FULL: Record<ProposalHintMode, string> = {
  closed: '/ads:proposal · /ads:dismiss-proposal',
  // The Accept REPLACES `/ads:proposal` here rather than the decline: R-2 says
  // every state names its one decline, and this is the state where accepting
  // and declining are the two answers on offer.
  acceptable: '/ads:accept-proposal · /ads:dismiss-proposal',
  menu: '↑↓ move · enter choose · esc close',
  consent: '↑↓ move · enter choose · esc cancel',
}

/**
 * The last thing that still fits. Every entry is a WHOLE command or a whole
 * key name — never a prefix of one.
 *
 * `acceptable` falls back to `/ads:proposal` rather than to a truncated
 * `/ads:accept-…`, and that is not a loss: the menu that command opens now
 * carries the Accept as its first item, so the narrowest card still has a
 * route to it.
 */
const HINT_COMPACT: Record<ProposalHintMode, string> = {
  closed: '/ads:proposal',
  acceptable: '/ads:proposal',
  menu: 'enter · esc',
  consent: 'enter · esc',
}
