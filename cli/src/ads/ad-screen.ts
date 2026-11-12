/**
 * ONE AD ON SCREEN AT A TIME: what the chat's two main ad units hold and
 * show, so every other unit can give way.
 *
 * The two main units are the slot above the input (the dock) and the
 * end-of-answer card in the transcript. The rules:
 *
 * 1. A PAIR FROM TWO SUPPLIERS: the ad network always wins.
 *    - network dock + network card in view: the dock goes blank (the card
 *      outranks it);
 *    - network dock + our card: OUR CARD is not drawn
 *      (`suppressOurCards`), and the card request carries
 *      `networkAdInView` so the server answers with the network or nothing;
 *    - our dock + network card in view: our dock goes blank;
 *    - our dock + our card in view: the dock goes blank.
 *    A blank dock requests nothing, pauses its rotation clock and shows the
 *    ad it held when the card leaves the view.
 * 2. Only the newest answer's card is drawn (`keepNewestResponseAd`).
 * 3. Our own units (partner rows, display units) neither show nor request
 *    while an ad-network ad is HELD by the dock (drawn or blank) or DRAWN as
 *    the card (`networkAdOnScreen`). Held and drawn, not "visible right now":
 *    the dock going blank for a card never changes the gate, so a row
 *    appearing cannot move the card and flip the dock back.
 * 4. A sponsored offer held in the dock is never hidden; the card request
 *    for the answer waits until the offer has gone.
 *
 * IN VIEW, WITH HYSTERESIS. The card counts as in view from the first
 * measurement inside the viewport, and stops only after it has been
 * measured outside it (or unmeasurable) for {@link CARD_OUT_OF_VIEW_RELEASE_MS}
 * without a break. A card that cannot be measured never makes the dock go
 * blank, so an unreadable layout cannot leave the dock blank for a session.
 */
import { create } from 'zustand'

import { TRANSCRIPT_IMPRESSION_DWELL_MS } from './ad-engagement'

import type { AdProvider, AdResponse } from '../hooks/use-gravity-ad'

export type OnScreenAd = { impUrl: string; provider?: AdProvider }

/** How long the card must stay out of view before the dock may come back. */
export const CARD_OUT_OF_VIEW_RELEASE_MS = TRANSCRIPT_IMPRESSION_DWELL_MS

interface AdScreenState {
  /** The end-of-answer card in the transcript viewport (with hysteresis). */
  inlineCard: OnScreenAd | null
  /** The end-of-answer card drawn in the transcript, in view or not. */
  inlineCardDrawn: OnScreenAd | null
  /** The ad the dock holds, drawn or blank; null with no ad or an offer. */
  dockHeld: OnScreenAd | null
}

export const useAdScreenStore = create<AdScreenState>(() => ({
  inlineCard: null,
  inlineCardDrawn: null,
  dockHeld: null,
}))

/** When the current in-view card was first measured out of view. */
let outOfViewSince: number | null = null

/**
 * An ad from an ad network rather than our own inventory. A missing provider
 * counts as a network ad, so our own units give way when in doubt.
 */
export function isNetworkAd(
  ad: Pick<OnScreenAd, 'provider'> | null | undefined,
): boolean {
  return ad != null && ad.provider !== 'first_party'
}

function isOurAd(ad: Pick<OnScreenAd, 'provider'> | null | undefined): boolean {
  return ad != null && ad.provider === 'first_party'
}

export function networkAdOnScreen(
  state: Pick<AdScreenState, 'dockHeld' | 'inlineCardDrawn'>,
): boolean {
  return isNetworkAd(state.dockHeld) || isNetworkAd(state.inlineCardDrawn)
}

/** Whether our own units must give way now (rule 3). */
export function useNetworkAdOnScreen(): boolean {
  return useAdScreenStore(networkAdOnScreen)
}

/** The end-of-answer card in the transcript viewport, if any (rule 1). */
export function useInlineCardOnScreen(): OnScreenAd | null {
  return useAdScreenStore((s) => s.inlineCard)
}

/**
 * Whether an end-of-answer card request must carry `networkAdInView`: the
 * dock holds an ad-network ad, so a card of ours would not be drawn.
 */
export function cardRequestNeedsNetworkHint(): boolean {
  return isNetworkAd(useAdScreenStore.getState().dockHeld)
}

/**
 * Whether a dock request must carry `networkAdInView`: an ad-network card
 * is in view, so a dock ad of ours could not be drawn.
 */
export function dockRequestNeedsNetworkHint(): boolean {
  return isNetworkAd(useAdScreenStore.getState().inlineCard)
}

/**
 * A fill that came back for a request sent with `networkAdInView` and is
 * ours anyway (a server that ignores the hint): dropped, never drawn.
 */
export function dropOurFillBesideNetwork(
  ad: Pick<OnScreenAd, 'provider'> | null | undefined,
  hintSent: boolean,
): boolean {
  return hintSent && isOurAd(ad)
}

/**
 * The cards drawable beside what the dock holds: with an ad-network ad in
 * the dock, our own cards are left out (rule 1). Returns `cards` itself
 * when nothing is left out, so its identity stays stable.
 */
export function suppressOurCards<T extends Pick<OnScreenAd, 'provider'>>(
  cards: Record<string, T[]>,
  dockHeld: Pick<OnScreenAd, 'provider'> | null | undefined,
): Record<string, T[]> {
  if (!isNetworkAd(dockHeld)) return cards
  let changed = false
  const next: Record<string, T[]> = {}
  for (const [id, list] of Object.entries(cards)) {
    const kept = list.filter((ad) => !isOurAd(ad))
    if (kept.length !== list.length) changed = true
    if (kept.length > 0) next[id] = kept
  }
  return changed ? next : cards
}

/**
 * The card's latest viewport measurement. In view (`true`) holds the screen
 * at once; out of view or unmeasurable (`false` / `undefined`) releases it
 * only once that has lasted {@link CARD_OUT_OF_VIEW_RELEASE_MS}. A report
 * for another card never clears the current one.
 */
export function reportInlineCardVisibility(
  ad: Pick<AdResponse, 'impUrl' | 'provider'>,
  visible: boolean | undefined,
  now: number = Date.now(),
): void {
  const current = useAdScreenStore.getState().inlineCard
  if (visible === true) {
    if (current?.impUrl === ad.impUrl) outOfViewSince = null
    if (current?.impUrl === ad.impUrl && current.provider === ad.provider)
      return
    outOfViewSince = null
    useAdScreenStore.setState({
      inlineCard: { impUrl: ad.impUrl, provider: ad.provider },
    })
    return
  }
  if (current?.impUrl !== ad.impUrl) return
  if (outOfViewSince === null) {
    outOfViewSince = now
    return
  }
  if (now - outOfViewSince >= CARD_OUT_OF_VIEW_RELEASE_MS) {
    outOfViewSince = null
    useAdScreenStore.setState({ inlineCard: null })
  }
}

/** The card mounted (`true`) or went away (`false`, which also ends "in view"). */
export function reportInlineCardDrawn(
  ad: Pick<AdResponse, 'impUrl' | 'provider'>,
  drawn: boolean,
): void {
  const state = useAdScreenStore.getState()
  if (drawn) {
    if (
      state.inlineCardDrawn?.impUrl === ad.impUrl &&
      state.inlineCardDrawn.provider === ad.provider
    )
      return
    useAdScreenStore.setState({
      inlineCardDrawn: { impUrl: ad.impUrl, provider: ad.provider },
    })
    return
  }
  const patch: Partial<AdScreenState> = {}
  if (state.inlineCardDrawn?.impUrl === ad.impUrl) patch.inlineCardDrawn = null
  if (state.inlineCard?.impUrl === ad.impUrl) {
    patch.inlineCard = null
    outOfViewSince = null
  }
  if (Object.keys(patch).length > 0) useAdScreenStore.setState(patch)
}

/** The ad the dock holds (drawn or blank), or null when it holds none. */
export function reportDockHeld(
  ad: Pick<AdResponse, 'impUrl' | 'provider'> | null | undefined,
): void {
  const current = useAdScreenStore.getState().dockHeld
  if (!ad) {
    if (current) useAdScreenStore.setState({ dockHeld: null })
    return
  }
  if (current?.impUrl === ad.impUrl && current.provider === ad.provider) return
  useAdScreenStore.setState({
    dockHeld: { impUrl: ad.impUrl, provider: ad.provider },
  })
}

/** Test seam. */
export function resetAdScreenForTests(): void {
  outOfViewSince = null
  useAdScreenStore.setState({
    inlineCard: null,
    inlineCardDrawn: null,
    dockHeld: null,
  })
}

/**
 * The end-of-answer cards after `messageId` received `ad`: only that answer's
 * card is kept, unless a NEWER answer (later in `answerOrder`) already has
 * one, or the answer is no longer in the transcript (`/new`, a clear), in
 * which case the late card is dropped and nothing drawn changes. Returns the
 * next map and the drawn cards that gave way.
 */
export function keepNewestResponseAd<T>(
  prev: Record<string, T[]>,
  messageId: string,
  ad: T,
  answerOrder: readonly string[],
): { next: Record<string, T[]>; superseded: T[]; dropped: boolean } {
  const incoming = answerOrder.indexOf(messageId)
  if (incoming < 0) return { next: prev, superseded: [], dropped: true }
  const newer = Object.keys(prev).some(
    (id) => id !== messageId && answerOrder.indexOf(id) > incoming,
  )
  if (newer) return { next: prev, superseded: [], dropped: true }
  const superseded: T[] = []
  for (const [id, ads] of Object.entries(prev))
    if (id !== messageId) superseded.push(...ads)
  return {
    next: { [messageId]: [...(prev[messageId] ?? []), ad] },
    superseded,
    dropped: false,
  }
}
