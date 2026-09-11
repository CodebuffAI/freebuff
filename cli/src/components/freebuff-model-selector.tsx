import {
  freebucksPeakCopy,
  isFreebucksPeakModel,
} from '@codebuff/common/util/freebuff-peak-price'
import { watchFreebucksPriceChanges } from '@codebuff/common/util/freebuff-price-changes'
import { TextAttributes } from '@opentui/core'
import { useKeyboard } from '@opentui/react'
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { Button } from './button'
import {
  FREEBUCKS_LABEL,
  formatFreebucks,
  freebucksHeaderLine,
  freebucksOf,
  freebucksPriceFor,
  freebucksPriceLabel,
  freebucksRowIntent,
  sortModelsByPrice,
} from '../utils/freebucks'
import { safeOpen } from '../utils/open-url'

/** Where a wall sends the reader — the same destination as the landing
 *  screen's upgrade line, so the two cannot point at different pages. */
const FREEBUCKS_PLANS_URL = 'https://freebuff.com/plans'

import { FreebuffReferralBanner } from './freebuff-referral-banner'
import {
  FREEBUFF_REWARD_MODEL_ID,
  getFreebuffDeploymentAvailabilityLabel,
  getFreebuffModelUnavailableLabel,
  getFreebuffModel,
  getFreebuffModelSupersededBy,
  getFreebuffModelsForAccessTier,
  getRecommendedFreebuffModelId,
  isFreebuffRewardModelId,
  isFreebuffModelAvailable,
  isFreebuffPremiumModelId,
  isSupportedFreebuffModelId,
} from '@codebuff/common/constants/freebuff-models'
import {
  formatFreebuffRowQuota,
  getFreebuffSectionQuotas,
  getFreebuffModelMeter,
} from '@codebuff/common/util/freebuff-session-pools'
import {
  getLimitedModelOffers,
  getRateLimitsByModel,
  getGlmPromo,
  getReferralInfo,
  getFreeWindowsInfo,
  getSubscriptionInfo,
} from '@codebuff/common/types/freebuff-session'

import {
  formatPlanWindows,
  freebuffFreeWindowsSummary,
  freebuffPlanSummary,
} from '@codebuff/common/util/freebuff-plan-summary'

import { startFreebuffSession } from '../hooks/use-freebuff-session'
import { useNow } from '../hooks/use-now'
import { useFreebuffModelStore } from '../state/freebuff-model-store'
import { useFreebuffSessionStore } from '../state/freebuff-session-store'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { useTheme } from '../hooks/use-theme'
import {
  freebuffModelNavigationDirectionForKey,
  nextFreebuffModelId,
} from '../utils/freebuff-model-navigation'
import { formatSessionUnits } from '../utils/format-session-units'
import {
  formatFreebuffPremiumResetCountdown,
  getFreebuffPremiumResetAt,
} from '../utils/freebuff-premium-reset'
import { isPlainEnterKey } from '../utils/terminal-enter-detection'

import type {
  FreebuffAccessTier,
  FreebuffModelOption,
} from '@codebuff/common/constants/freebuff-models'
import type { FreebuffReferralFocusTarget } from './freebuff-referral-banner'
import type {
  BoxRenderable,
  KeyEvent,
  ScrollBoxRenderable,
} from '@opentui/core'

// The picker opens collapsed to a single hero card so a new user can start with
// one Enter press without reading six boxes. The hero is the DEFAULT pick, not
// a recommendation — the ' RECOMMENDED ' badge and every supersedes nudge were
// removed on 2026-08-21, leaving list ORDER as the only steer. The "see all models"
// toggle reveals the rest, grouped into the same product/availability tiers.
//
// Section grouping (expanded view): every model row, including the recommended
// one, keeps its tier so it is obvious which quota it consumes. The premium
// models share one daily session quota while the unlimited ones have none.
// Putting the tier on a section header lets each row drop its redundant
// "Premium"/"Unlimited" chip. The PREMIUM header carries the shared quota
// inline — "N of M used · resets in …" — once any session is spent (turning
// amber when exhausted, the moment its rows grey out). When collapsed there's
// no PREMIUM header, so the parent keeps a below-picker counter for the
// collapsed state (and for the limited tier, which has no premium section).
// The full-access hero is DeepSeek V4 Pro (DEFAULT_FREEBUFF_MODEL_ID) as of
// 2026-08-21, so it draws on the premium pool and flips to the unlimited MiMo
// once that empties — the hero must always be joinable. Pro is also the only
// premium row open at every hour, which is why it holds this slot: V4 Flash now
// closes for the ten-hour peak window. The limited tier's hero is MiMo 2.5,
// with DeepSeek V4 Flash as its one other row. UNLIMITED needs no
// annotation. Empty sections are filtered so a model set with no premium (or no
// unlimited) entries doesn't render an orphan header.
//
// `label` may be empty: limited-tier users only see the constrained model set,
// so the "LIMITED" header would just leak the internal tier name without
// organizing anything. Renderer treats an empty label as "no header row".
type Section = {
  key: 'premium' | 'unlimited' | 'limited' | 'offer' | 'metered'
  label: string
  models: readonly FreebuffModelOption[]
}

// Sentinel id for the expand/collapse toggle so it can ride the same
// keyboard-navigation list as the model rows (Tab/arrow to it, Enter to fire).
const TOGGLE_ID = '__freebuff_toggle__'

/** Joins the parts of a row's second line (see `rowDetails`). */
const DETAIL_SEPARATOR = ' · '

// There used to be a right-aligned "Press Enter ↵" cue on the focused row, with
// its width reserved in the line-1 budget below. Both are gone: the cue was
// redundant next to the green focus border, and its reserved gutter widened
// every card by ~17 columns of dead space.

/**
 * Pre-chat model picker (session 'none'): user hasn't started a session yet.
 * Picking a model is their explicit commitment to enter — this triggers the
 * POST, which admits them straight to an active session. Opens collapsed to
 * the recommended hero; Enter starts immediately.
 *
 * Keyboard navigation: Tab / arrow keys move the green highlight; Enter (or
 * Space) commits the focused row — or, on the toggle, expands/collapses the
 * list. Mouse click commits in one step.
 *
 * Layout: the collapsed view renders one card — the default starting pick, NOT
 * a recommendation; nothing is badged and the catalog names no recommended
 * model. When expanded, every full-access row is grouped into PREMIUM /
 * UNLIMITED sections so that row's tier is explicit without a per-row chip; the shared
 * premium-session quota rides the PREMIUM header. Names align in a column
 * so taglines line up across rows, and the secondary details (warning /
 * deployment hours) always sit on their own centered line under the name —
 * keeping a row with a warning from stretching into one very long line. On
 * terminals too narrow for the name column, line 1 compacts to "name · tagline".
 *
 * On short terminals the parent passes `maxHeight`: the model rows and the
 * referral/GLM controls live in one scrollbox capped at that many rows. A
 * scrollbar appears when the whole menu doesn't fit, and Tab/arrow navigation
 * keeps the focused control scrolled into view.
 */
interface FreebuffModelSelectorProps {
  /** Session admission boundary; defaults to the CLI session controller. */
  startSession?: (model: string) => Promise<void>
  /** Max vertical rows the picker may occupy. When the rendered rows exceed
   *  this, the list scrolls (scrollbar shown, focused row kept in view);
   *  otherwise the scrollbox shrinks to fit and no scrollbar appears. */
  maxHeight: number
  /** Notifies the parent whenever the picker expands/collapses. The landing
   *  screen uses it to promote the wordmark to the full ASCII logo while the
   *  picker is collapsed (the freed rows make room). */
  onExpandedChange?: (expanded: boolean) => void
  /** Rendered between the expand/collapse toggle and the referral banner. The
   *  landing screen passes its session counter here so the quota sits with the
   *  models it describes, leaving the referral pitch and its copy control
   *  adjacent as one unit. Lives inside the scrollbox, so it scrolls with the
   *  rest of the content rather than being pinned below it. */
  belowToggle?: React.ReactNode
  /** Freezes the picker's clock at this instant (epoch ms) instead of reading
   *  real time. Tests pass it because row availability is time-of-day
   *  dependent — V4 Pro closes during DeepSeek's expensive window (00:00-10:00
   *  UTC), which silently turned assertions about its card into assertions
   *  about what hour CI happened to run at. Unset in production, where the
   *  clock ticks so a row reopens without a relaunch. */
  nowMs?: number
  /** Ignore every key while something above the picker owns the keyboard.
   *  The Freebucks intro card is the one caller: it says "press any key to
   *  continue", and without this the same key also committed the focused row
   *  and charged for a session the user never picked. */
  keyboardSuspended?: boolean
}

/** Every model id this screen can offer a tier: the grid, plus the banner's
 *  earned-reward action. Exported so the offer→gate invariant test reads the
 *  real set rather than a copy of it.
 *
 *  The banner's row is offered on BOTH tiers, and it means a different thing on
 *  each since 2026-08-31: at limited access it unlocks the reward model, and at
 *  full access it is an extra PREMIUM session rather than a model at all. The
 *  id below is what the limited half offers; at full access it is already in
 *  the grid, so listing it twice is harmless and listing it at all keeps this
 *  set honest about what the banner can start.
 *
 *  The balance is what gates the row — the banner only renders the action when
 *  the server reports sessions left — and the tier never was. */
export function freebuffCliOfferedModelIds(
  accessTier: FreebuffAccessTier,
  /** Whether the account holds an entitling paid plan. */
  hasPaidSubscription = false,
): readonly string[] {
  return [
    ...getFreebuffModelsForAccessTier(accessTier, hasPaidSubscription).map(
      (m) => m.id,
    ),
    FREEBUFF_REWARD_MODEL_ID,
  ]
}

export const FreebuffModelSelector: React.FC<FreebuffModelSelectorProps> = ({
  maxHeight,
  onExpandedChange,
  belowToggle,
  nowMs,
  keyboardSuspended = false,
  startSession = startFreebuffSession,
}) => {
  const theme = useTheme()
  // contentMaxWidth (not terminalWidth) is the real budget — the parent
  // landing screen wraps this picker in a `maxWidth: contentMaxWidth`
  // box (capped at 80 cols), so a wide terminal doesn't actually let us
  // sprawl the buttons across it.
  const { contentMaxWidth } = useTerminalDimensions()
  const selectedModel = useFreebuffModelStore((s) => s.selectedModel)
  const setSelectedModel = useFreebuffModelStore((s) => s.setSelectedModel)
  // Subscribed, not read imperatively: `/reasoning` can change a row's effort
  // while the picker is unmounted, and the width maths below memoizes on this
  // value. Reading the store outside React would leave the memo stale and
  // truncate the row it just widened.
  const reasoningEffortByModel = useFreebuffModelStore(
    (s) => s.reasoningEffortByModel,
  )
  const session = useFreebuffSessionStore((s) => s.session)
  const accessTier =
    (session && 'accessTier' in session ? session.accessTier : undefined) ??
    'full'
  // The interval is cancelled outright when the clock is pinned, so a frozen
  // picker never re-renders itself back onto real time.
  const liveNow = useNow(60_000, nowMs === undefined)
  const now = nowMs ?? liveNow
  const deploymentAvailabilityLabel = useMemo(
    () => getFreebuffDeploymentAvailabilityLabel(new Date(now)),
    [now],
  )
  const [pending, setPending] = useState<string | null>(null)
  const admissionPending = useRef(false)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  /** The row currently asking a Freebucks question, if any. Cleared whenever
   *  focus leaves it — an unanswered question is about the moment it was
   *  raised in, and one left standing on a row the user has moved off would be
   *  answered by an Enter meant for something else. */
  const [pendingAsk, setPendingAsk] = useState<string | null>(null)

  // `subscription.tierId` is non-null exactly when the server resolved an
  // ENTITLING plan row, so the picker widens on the server's own verdict rather
  // than on anything it decides for itself.
  const subscriptionInfo = getSubscriptionInfo(session)
  const hasPaidSubscription = Boolean(subscriptionInfo?.tierId)
  // The paid plan's own windows, rendered as a single muted line below the
  // catalog — the CLI counterpart of the web dropdown's plan panel. The same
  // shared summary drives Desktop and the web usage page, so all three name
  // the same binding limit and the same reset.
  const planSummary = freebuffPlanSummary(subscriptionInfo)
  // The free tier's own three windows (2026-09-01), in the same shape as the
  // plan line so a free user and a subscriber read the same layout. Absent on
  // limited access, quota-exempt accounts and older servers.
  const freeWindows = freebuffFreeWindowsSummary(getFreeWindowsInfo(session))
  // The Freebucks meter, when this account is on it. The BLOCK'S PRESENCE IS
  // THE GATE, exactly as on Web and Desktop: the server sends it to the
  // accounts it meters, so there is no client-side role check here that could
  // drift from what is actually charged.
  const freebucks = freebucksOf(session)
  const balanceUnavailable = freebucks === null
  // The plan the daily pool was sized from. `planId` is the server's own
  // verdict, so the name cannot disagree with the number beside it.
  const planName = freebucks?.planId
    ? freebucks.planId.charAt(0).toUpperCase() + freebucks.planId.slice(1)
    : 'Free'
  // The live session's model, for the switch question. `activeModel` is only
  // set while a session is running, so an idle picker never asks.
  const activeSessionModel =
    session?.status === 'active' &&
    Date.parse(session.expiresAt) > (nowMs ?? Date.now())
      ? session.model
      : undefined
  const availableModels = useMemo(
    // CHEAPEST FIRST once metered — the same order Web and Desktop use. Off
    // the meter this returns the catalog untouched, so the recommended-first
    // ordering everyone currently sees is unchanged.
    () =>
      sortModelsByPrice(
        getFreebuffModelsForAccessTier(accessTier, hasPaidSubscription),
        freebucks,
      ),
    [accessTier, hasPaidSubscription, freebucks],
  )
  // Capacity-limited models the SERVER decided to offer on this response. The
  // client has no catalog of its own for these on purpose: when the wave's pool
  // empties (or the offer is switched off) the payload stops arriving and every
  // derived value below collapses to empty, so the picker renders exactly what
  // it rendered before the offer existed — no stale row, no greyed-out tease.
  //
  // An unknown model id is dropped rather than rendered from the wire payload:
  // display name and data-use warning must come from the shared catalog, so a
  // server that advertises a model this build has never heard of is a no-op
  // instead of a half-labelled row.
  const offers = useMemo(
    () =>
      getLimitedModelOffers(session).filter((offer) =>
        isSupportedFreebuffModelId(offer.model),
      ),
    [session],
  )
  const offerModels = useMemo(
    () => offers.map((offer) => getFreebuffModel(offer.model)),
    [offers],
  )
  const offerByModelId = useMemo(
    () => new Map(offers.map((offer) => [offer.model, offer])),
    [offers],
  )
  // No queued state any more: there's never a model the user is "already in"
  // the queue for, so re-picking is always meaningful.
  const committedModelId: string | null = null
  const rateLimitsByModel = getRateLimitsByModel(session)
  const [, refreshPrices] = useState(0)
  useEffect(
    () =>
      watchFreebucksPriceChanges(freebucks, () => refreshPrices((n) => n + 1)),
    [freebucks],
  )
  const taglineFor = useCallback(
    (model: FreebuffModelOption) =>
      isFreebucksPeakModel(freebucks, model.id)
        ? model.tagline
        : (freebucks?.priceNotices?.[model.id] ?? model.tagline),
    [freebucks],
  )
  const referral = getReferralInfo(session)
  const meterFor = useCallback(
    (model: string) =>
      getFreebuffModelMeter({
        model,
        freebucks,
        quota: rateLimitsByModel?.[model],
        // Older CLI snapshots omit earned quotas; full access and plans do not
        // need that compatibility fallback.
        legacyRemaining:
          accessTier === 'limited' &&
          !hasPaidSubscription &&
          isFreebuffRewardModelId(model)
            ? (referral?.weeklySessionsRemaining ?? 0)
            : undefined,
      }),
    [
      freebucks,
      rateLimitsByModel,
      accessTier,
      hasPaidSubscription,
      referral?.weeklySessionsRemaining,
    ],
  )
  // Present only while a promo runs; absent renders the banner exactly as it
  // rendered before promos existed.
  const glmPromo = getGlmPromo(session)

  // Only applicable legacy quotas belong in section headings. Currency-priced
  // rows describe their price and balance instead of a pool they do not use.
  const premiumSectionQuotas = getFreebuffSectionQuotas(
    availableModels
      .filter((m) => isFreebuffPremiumModelId(m.id))
      .map((m) => m.id),
    Object.fromEntries(
      availableModels.flatMap((model) => {
        const { quota } = meterFor(model.id)
        return quota ? [[model.id, quota]] : []
      }),
    ),
  )
  const sharedRateLimit = premiumSectionQuotas.header
  const premiumUsed = sharedRateLimit?.recentCount ?? 0
  // Server-sent, always — never a locally-guessed denominator. Falling back to
  // the static limit meant a quota-EXEMPT account, which gets no snapshot at
  // all, read "0 of 4 used · resets in 11h 43m" beside a status bar saying
  // "unlimited". No snapshot means no pool, so no counter.
  const premiumLimit = sharedRateLimit?.limit ?? null
  const premiumExhausted = premiumLimit !== null && premiumUsed >= premiumLimit
  // The pool resets daily on a Pacific-day boundary regardless of usage, so the
  // countdown is meaningful even at zero used. Gated on the pool existing for
  // the same reason as the count above: no pool, nothing to reset.
  const premiumResetCountdown = sharedRateLimit
    ? formatFreebuffPremiumResetCountdown(
        getFreebuffPremiumResetAt({ rateLimitsByModel, nowMs: now }),
        now,
      )
    : null

  /**
   * THE contents of a row's second line, in draw order — the one place that
   * decides what is on it.
   *
   * The render, the centering pad, the card-width math and the height estimate
   * all need this, and they had each drifted into their own copy: the width and
   * height copies knew only about `warning` and deployment hours, and the
   * centering copy knew about the closed-window note but not the per-row quota
   * chip. That stayed hidden while the chip appeared only after a user had
   * spent a Luna session; once the server began sending unused pool rows it
   * became every full-access picker, drawn off-centre with the toggle clipped
   * off the first frame.
   */
  const rowDetails = useCallback(
    (model: FreebuffModelOption): { text: string; warn: boolean }[] => {
      const details: { text: string; warn: boolean }[] = []
      // THE PRICE LEADS LINE 2, and on the meter it is often the only thing
      // on it.
      //
      // NOT a right-edge column, unlike Web and Desktop: this line is centred
      // (`detailsPad`), which is the CLI's existing idiom for row detail and
      // is not worth breaking for one chip. Leading the line is what makes the
      // price findable instead — it is the first thing on the row's second
      // line, in the same place on every row.
      //
      // `N/hr`, never a bare number: a bare "5" reads as a per-message rate,
      // the most expensive misunderstanding this menu can create. Warned when
      // the balance cannot cover it — the same signal the dimmed price carries
      // on the other two surfaces.
      const rowPrice = freebucksPriceFor(freebucks, model.id)
      if (rowPrice !== undefined) {
        details.push({
          text: freebucksPriceLabel(rowPrice),
          warn: (freebucks?.balance ?? 0) < rowPrice,
        })
      }
      if (model.warning) details.push({ text: model.warning, warn: true })
      // PEAK PRICING as its own detail chip, in the reader's zone. Line 1
      // keeps the row's tagline (the server's prose notice is the same fact
      // and is dropped for a peaked row, see taglineFor); the price above
      // already moved, and this is the why and the when.
      if (freebucks?.peak && isFreebucksPeakModel(freebucks, model.id)) {
        const base = (rowPrice ?? 0) - freebucks.peak.surcharge
        details.push({
          text: freebucksPeakCopy({
            peak: freebucks.peak,
            basePrice: base,
            now,
          }).tooltip,
          warn: true,
        })
      }
      if (model.availability === 'deployment_hours') {
        // Carries both the in-hours and out-of-hours signal, so a row with
        // hours never also needs the closed note below.
        details.push({ text: deploymentAvailabilityLabel, warn: false })
      } else {
        const closed = getFreebuffModelUnavailableLabel(model.id, new Date(now))
        if (closed) details.push({ text: closed, warn: true })
      }
      // A row on a stricter pool than its section carries its own count,
      // because the section header cannot speak for it: a user who has spent
      // their one Luna session otherwise reads "1 of 4 used" beside a greyed
      // row and is told nothing about why it is greyed. Server-labelled, so a
      // pool added later needs no CLI release.
      // A priced row already carries its price (`15/hr`, above) and the
      // balance lives in the header line under the list, so the older
      // "15 Freebucks · 100 available" detail is not added a second time; a
      // priced row also skips the pool count below, which nothing charges.
      const { budget, canStart } = meterFor(model.id)
      if (budget) return details
      const ownQuota = premiumSectionQuotas.perModel[model.id]
      // On the meter the POOL COUNT is a lie by omission — a priced row is not
      // charged to that pool any more — so the price replaces it rather than
      // sitting beside it. Off the meter this branch never runs and the count
      // is rendered exactly as before.
      if (ownQuota && freebucksPriceFor(freebucks, model.id) === undefined) {
        details.push({
          text: formatFreebuffRowQuota(ownQuota),
          warn: !canStart,
        })
      }
      return details
    },
    [
      deploymentAvailabilityLabel,
      now,
      premiumSectionQuotas,
      meterFor,
      freebucks,
    ],
  )
  const rowDetailsText = useCallback(
    (model: FreebuffModelOption): string =>
      rowDetails(model)
        .map((detail) => detail.text)
        .join(DETAIL_SEPARATOR),
    [rowDetails],
  )

  const isJoinable = useCallback(
    (modelId: string) => {
      if (!isFreebuffModelAvailable(modelId, new Date(now))) return false
      // An offer row is on screen only while the shared pool has capacity, so
      // what's left to check is the caller's own daily ceiling. It travels on
      // the offer payload rather than in `rateLimitsByModel`, which the server
      // deliberately keeps free of these models so the 30s poll doesn't pay for
      // a quota nobody is using.
      const offer = offerByModelId.get(modelId)
      if (offer) return offer.userRemaining > 0
      if (
        session?.status === 'active' &&
        session.model === modelId &&
        Date.parse(session.expiresAt) > (nowMs ?? Date.now())
      )
        return true
      return meterFor(modelId).canStart
    },
    [now, nowMs, session, offerByModelId, meterFor],
  )

  const recommendedModel = useMemo(() => {
    const id = getRecommendedFreebuffModelId(accessTier, { premiumExhausted })
    const preferred =
      availableModels.find((m) => m.id === id) ?? availableModels[0]!
    return isJoinable(preferred.id)
      ? preferred
      : (availableModels.find((model) => isJoinable(model.id)) ?? preferred)
  }, [accessTier, availableModels, premiumExhausted, isJoinable])

  // "A better model exists" footnote for a row. The CLI has no in-row button to
  // switch with, so it shows the notice only — the replacement is always
  // reachable as a row in this same picker (and is usually the RECOMMENDED hero
  // one Enter away), which is what getFreebuffModelSupersededBy guarantees by
  // resolving against the models actually on screen.
  /**
   * The meter's one decision for this row — paywall, confirm, or allow.
   * Shared with Desktop and Web in shape and in wording; see
   * `freebucksRowIntent`.
   */
  const rowIntent = useCallback(
    (modelId: string) =>
      freebucksRowIntent(
        freebucks,
        modelId,
        session?.status === 'active' &&
          Date.parse(session.expiresAt) > (nowMs ?? Date.now())
          ? session.model
          : undefined,
      ),
    [freebucks, session, nowMs],
  )

  /**
   * A row the meter alone refuses: open for business, priced, and dearer than
   * the balance.
   *
   * It is NOT joinable, but it must still be PRESSABLE. `isJoinable` gated the
   * Enter handler and the click handler, so a row the user could not afford
   * did nothing at all when pressed — no message, no plans link, no sound — and
   * the paywall wording written for exactly this case (`askLineFor`) and the
   * plans link behind it (`pick`) were unreachable from either input. On a
   * metered account that is the whole failure the user reports as "I can't
   * change models": the cheapest row starts, every dearer one is silent
   * (2026-09-08).
   *
   * Deliberately narrower than `!isJoinable`. A row that is closed for the
   * hour, withdrawn, or out of trial slots already says so on its own second
   * line and has no second press that changes the answer, so those stay inert.
   */
  const isPricedOut = useCallback(
    (modelId: string) =>
      !isJoinable(modelId) &&
      isFreebuffModelAvailable(modelId, new Date(now)) &&
      !offerByModelId.has(modelId) &&
      rowIntent(modelId).kind === 'paywall',
    [isJoinable, now, offerByModelId, rowIntent],
  )

  /** Whether pressing the row does anything at all — starts a session, asks a
   *  question, or explains a wall. */
  const isPressable = useCallback(
    (modelId: string) => isJoinable(modelId) || isPricedOut(modelId),
    [isJoinable, isPricedOut],
  )

  /**
   * The question a row is currently asking, if any.
   *
   * Drawn as an extra line UNDER the row, the same slot the superseded notice
   * uses — which is what keeps it inside the width math and the height budget
   * below. A modal would be the wrong shape here for the same reason it is on
   * the other two surfaces: it takes every other price off screen, and the
   * comparison between prices is the thing the reader is in the middle of.
   */
  /**
   * The limited-tier upgrade offer for a row, or undefined to draw nothing.
   *
   * Drawn on EVERY surcharged row rather than only the selected one, unlike
   * `supersededNoticeFor`: that nudge is about a pick the user has already
   * made, while this is the reason this row's price differs from what the
   * reader may remember. Someone comparing rows needs it before they choose.
   *
   * The tier and plan come from the SESSION RESPONSE, never from a local
   * belief about entitlement.
   */
  const upgradeOfferFor = useCallback(
    (model: FreebuffModelOption) => {
      // OFF THE WIRE, never derived here. The copy is built from Freebucks
      // constants the CLI cannot hold (they are export-excluded), and who is
      // offered what is the server's verdict — tier, plan, plans audience —
      // so `freebucks.upgrade` is absent for everyone it does not apply to.
      const upgrade = freebucks?.upgrade
      return upgrade?.kind === 'limited_offer' && upgrade.modelId === model.id
        ? upgrade
        : undefined
    },
    [freebucks],
  )
  const askLineFor = useCallback(
    (model: FreebuffModelOption): string | undefined => {
      if (pendingAsk !== model.id) return undefined
      const intent = rowIntent(model.id)
      if (intent.kind === 'paywall') {
        // On the row the limited-tier offer discounts, say what a plan does
        // rather than what is missing. Kept about as short as the line it
        // replaces: this line is measured and clipped, never wrapped, and the
        // CTA line under it already carries "Get 7x usage for $5".
        const offer = upgradeOfferFor(model)
        if (offer) {
          // The first clause of the server's copy ("DeepSeek V4.1 Flash drops
          // to 15 Freebucks on a plan"): the whole tooltip is a sentence and a
          // half, and this line sizes the card and is clipped, never wrapped.
          const lead = offer.tooltip.split(' — ')[0] ?? offer.tooltip
          return `${lead}. Enter opens plans.`
        }
        return `Not enough ${FREEBUCKS_LABEL} — ${freebucksPriceLabel(
          intent.price,
        )} against ${formatFreebucks(freebucks?.balance ?? 0)} left. Enter opens plans.`
      }
      if (intent.kind === 'confirm') {
        if (intent.price === undefined) {
          return `Balance unavailable. Enter may spend wallet Freebucks${activeSessionModel ? ' and end this session' : ''}.`
        }
        // ONE question. When a switch would also dip into the wallet the
        // wallet is the fact that matters — the daily pool refills, the wallet
        // does not — so the overage wording wins outright and the session
        // ending is a clause inside it, never a second prompt.
        if (intent.claimEarned)
          return `Claim earned Freebucks on admission, then spend ${intent.price} for this session. Enter to confirm.`
        return intent.walletSpend > 0
          ? `Today's ${FREEBUCKS_LABEL} are spent. Enter uses ${formatFreebucks(
              intent.walletSpend,
            )} from your wallet${activeSessionModel ? ' and ends this session' : ''}.`
          : `Ends this session and starts a new one for ${freebucksPriceLabel(
              intent.price,
            )}. Enter to confirm.`
      }
      return undefined
    },
    [pendingAsk, rowIntent, freebucks, activeSessionModel, upgradeOfferFor],
  )

  const supersededNoticeFor = useCallback(
    (model: FreebuffModelOption): string | undefined =>
      // Only on the row the user is actually on — the nudge is about THEIR
      // pick, and the list ordering already steers everyone else to the
      // replacement. Gated here rather than at the render so the width math and
      // the height estimate below stay in agreement with what is drawn.
      model.id === selectedModel
        ? getFreebuffModelSupersededBy(
            model.id,
            availableModels.map((m) => m.id),
          )?.notice
        : undefined,
    [availableModels, selectedModel],
  )
  const upgradeLineFor = useCallback(
    (model: FreebuffModelOption): string | undefined => {
      const offer = upgradeOfferFor(model)
      return offer ? `${offer.cta} →` : undefined
    },
    [upgradeOfferFor],
  )
  const otherModels = useMemo(
    () => availableModels.filter((m) => m.id !== recommendedModel.id),
    [availableModels, recommendedModel],
  )
  // Only worth collapsing when the toggle actually hides something. With a
  // single "other" model (limited tier) we just show both — a "see 1 more
  // model" toggle is noise.
  const canCollapse = otherModels.length >= 2

  // Default collapsed only on the landing screen and only when the saved/active
  // selection IS the recommended model — a returning user whose preference is a
  // different model gets the expanded list so their pick is visible and focused.
  // STARTABLE, not merely different: the effect below is about to replace an
  // unstartable pick with the recommendation, and expanding to show a spent row
  // "focused" buries the hero under rows the user cannot press — which is what
  // a spent premium pool did once the default became premium (2026-08-12).
  const isLanding = session?.status === 'none' || !session
  const [expanded, setExpanded] = useState(
    () =>
      !canCollapse ||
      !isLanding ||
      (selectedModel !== recommendedModel.id && isJoinable(selectedModel)),
  )
  // Limited mode has no labeled tier section, so moving its recommendation
  // inside that section would only move the existing inter-card spacing above
  // the entire list. Keep its original standalone recommendation; full-access
  // expanded views put every row beneath a quota-bearing section header.
  const showStandaloneRecommended = !expanded || accessTier === 'limited'
  // The session snapshot arrives asynchronously. If it changes the picker
  // from full access (collapsible) to limited access (only two rows), force
  // the list open before notifying the parent; otherwise the toggle disappears
  // while the second limited model remains hidden.
  //
  // Mirror the settled state up to the landing screen (collapsed → it promotes
  // the wordmark to the full ASCII logo). useLayoutEffect keeps both corrections
  // ahead of paint.
  useLayoutEffect(() => {
    if (!canCollapse && !expanded) {
      setExpanded(true)
      return
    }
    onExpandedChange?.(expanded)
  }, [canCollapse, expanded, onExpandedChange])

  // Keyboard cursor — separate from the actually-selected model so that
  // Tab/arrow navigation can preview without committing. Starts on the user's
  // saved/active pick (the recommended hero for a new user, since that's the
  // default selection; their own model when expanded for a returning user).
  const [focusedId, setFocusedId] = useState<string>(() => selectedModel)

  // The referral banner contributes its GLM/copy actions to the selector's
  // navigation order. Keeping them local avoids a global focus bridge now that
  // the banner renders inside this selector.
  const [extraTargets, setExtraTargets] = useState<
    FreebuffReferralFocusTarget[]
  >([])
  const extraTargetIds = useMemo(
    () => extraTargets.map((t) => t.id),
    [extraTargets],
  )
  const contentRef = useRef<BoxRenderable | null>(null)
  const [measuredContentHeight, setMeasuredContentHeight] = useState<
    number | null
  >(null)
  const syncContentHeight = useCallback(() => {
    const nextHeight = contentRef.current?.height
    if (!nextHeight) return
    setMeasuredContentHeight((current) =>
      current === nextHeight ? current : nextHeight,
    )
  }, [])
  // The standing catalog's tier sections. Expanded-only; the offer section
  // below is added on top and is visible in both states.
  const catalogSections = useMemo(() => {
    if (!expanded) return [] as readonly Section[]
    if (accessTier === 'limited') {
      return [
        { key: 'limited', label: '', models: otherModels },
      ] satisfies readonly Section[]
    }
    // ONE FLAT LIST on the meter, like Web and Desktop.
    //
    // PREMIUM / UNLIMITED name which POOL metered a row, and on Freebucks
    // there is one meter and every row carries a price. Keeping the split puts
    // a "0 of 4 used" pool header above rows that are charged to something
    // else entirely — two meters for one account, which is the arrangement
    // that lies outright. Ordering is by price now, so the list is already
    // sorted by the only thing those headers were standing in for.
    if (freebucks) {
      return [
        { key: 'metered', label: '', models: availableModels },
      ] satisfies readonly Section[]
    }
    return (
      [
        {
          key: 'premium',
          label: 'PREMIUM',
          models: availableModels.filter((m) => isFreebuffPremiumModelId(m.id)),
        },
        {
          key: 'unlimited',
          label: 'UNLIMITED',
          models: availableModels.filter(
            (m) => !isFreebuffPremiumModelId(m.id),
          ),
        },
      ] satisfies readonly Section[]
    ).filter((section) => section.models.length > 0)
  }, [expanded, accessTier, availableModels, otherModels, freebucks])

  // Every section that gets drawn, in draw order. THE single source for the
  // render, the navigation order and the height estimate — those three must
  // agree on which sections exist or the focused-row auto-scroll desyncs, so
  // they all read this rather than each rebuilding the list.
  //
  // The offer section leads and is drawn in BOTH the collapsed and expanded
  // views, unlike every other section. A time-boxed frontier model that only a
  // few dozen people get is the one row worth spending a collapsed-view line
  // on — hiding it behind "see all models" would mean most users never learn
  // the offer happened. It still sits after the recommended hero (drawn
  // separately, above), so the collapsed view reads "recommended first, special
  // second".
  const renderedSections = useMemo(
    () =>
      offerModels.length > 0
        ? [
            {
              key: 'offer' as const,
              label: 'LIMITED TRIAL',
              models: offerModels,
            },
            ...catalogSections,
          ]
        : catalogSections,
    [offerModels, catalogSections],
  )

  // Model rows in render order: a standalone recommendation in collapsed and
  // limited views, followed by all models belonging to rendered sections.
  const renderedModelIds = useMemo(
    () => [
      ...(showStandaloneRecommended ? [recommendedModel.id] : []),
      ...renderedSections.flatMap((section) => section.models.map((m) => m.id)),
    ],
    [recommendedModel, renderedSections, showStandaloneRecommended],
  )
  // Keyboard-navigable ids: the model rows, then the toggle, then any focus
  // targets the referral banner registered (so arrowing down past "see all
  // models" reaches its buttons; nextFreebuffModelId wraps back to the top).
  const navIds = useMemo(
    () => [
      ...renderedModelIds,
      ...(canCollapse ? [TOGGLE_ID] : []),
      ...extraTargetIds,
    ],
    [canCollapse, renderedModelIds, extraTargetIds],
  )

  // Keep focus valid as the list expands/collapses or the selection changes
  // server-side. An explicit, still-valid focus (e.g. just set by the toggle)
  // is preserved; only an out-of-range focus snaps back to the selection.
  useEffect(() => {
    setFocusedId((curr) =>
      navIds.includes(curr)
        ? curr
        : navIds.includes(selectedModel)
          ? selectedModel
          : recommendedModel.id,
    )
  }, [navIds, recommendedModel.id, selectedModel])

  useEffect(() => {
    // A model in the grid uses the same meter for focus repair and picking.
    // Keep an earned banner pick too when an older catalog omits that row.
    const selectionIsStartable =
      (renderedModelIds.includes(selectedModel) ||
        isFreebuffRewardModelId(selectedModel)) &&
      isJoinable(selectedModel)
    if (isLanding && !selectionIsStartable) {
      setSelectedModel(recommendedModel.id)
      // The cursor moves too: the focus effect above only rescues an
      // out-of-RANGE focus, and the row we just refused is still in range.
      setFocusedId(recommendedModel.id)
    }
  }, [
    renderedModelIds,
    isLanding,
    isJoinable,
    recommendedModel.id,
    selectedModel,
    setSelectedModel,
  ])

  // What the row advertises as this model's reasoning: the user's `/reasoning`
  // pick when they made one, otherwise the effort the server pins from the
  // catalog. ONE function for both the width maths and the render — they were
  // separate strings before the picker gained an override, and a row whose
  // suffix outgrows what the width maths budgeted for is a truncated row.
  //
  // A model with a LADDER but no pinned `reasoningEffort` (Fable 5) still shows
  // nothing until the user picks: its default is the provider's own, and
  // spending row width to restate it pushed the "see all models" toggle off a
  // short terminal. The suffix appears the moment it carries information the
  // user did not already have.
  const reasoningSuffixFor = useCallback(
    (model: FreebuffModelOption): string => {
      const chosen = reasoningEffortByModel[model.id]
      if (chosen && model.efforts?.includes(chosen)) {
        // The '*' marks a rung the USER chose, so a pick is distinguishable
        // from the catalog default without a second line.
        return ` · Reasoning: ${chosen}*`
      }
      return model.reasoningEffort
        ? ` · Reasoning: ${model.reasoningEffort}`
        : ''
    },
    [reasoningEffortByModel],
  )

  const BUTTON_CHROME = 4 // 2 border + 2 padding
  const NAME_GAP = 2 // spaces between name column and details column

  // Rows are two lines: line 1 is the identity (name + tagline), line 2 carries
  // the secondary details (AI-training warning · deployment hours), centered.
  // The warning ALWAYS gets its own line rather than being appended to line 1 —
  // the recommended hero carries the training notice, and inlining it made that
  // row one very long line that dominated the landing screen.
  //
  // Line 1 is normally two columns: a fixed name column (padded to the longest
  // displayName across all rows) followed by the tagline, so taglines align
  // down the list. On terminals too narrow for that it falls back to a compact
  // "name · tagline". Computed across ALL models (not just the expanded ones)
  // so the recommended hero and the revealed rows share one width and nothing
  // reflows on toggle.
  const { compactNames, buttonOuterWidth, buttonInnerWidth, nameColumnWidth } =
    useMemo(() => {
      // Every row that can appear, offer rows included: their row is visible
      // while collapsed, so leaving them out would let the card jump width the
      // moment an offer arrives. The offer's own counts ride its section header
      // (like PREMIUM's quota), so only name and tagline enter the column math.
      const widthModels = [...availableModels, ...offerModels]
      const maxNameLen = Math.max(
        ...widthModels.map((m) => m.displayName.length),
      )

      // Line 3, when a better model exists. Its own line: the notice is a full
      // sentence, so appending it to line 2 would stretch the card past any
      // reasonable terminal width.
      const noticeLineLen = (m: FreebuffModelOption) =>
        // The meter's question shares this slot and is a full sentence too, so
        // it has to be measured here or the card is sized for the shorter of
        // the two and clips whichever is actually drawn.
        Math.max(
          supersededNoticeFor(m)?.length ?? 0,
          askLineFor(m)?.length ?? 0,
          // The upgrade CTA is a short phrase rather than a sentence, but it
          // still has to be measured: a card sized for the shorter lines clips
          // whichever is actually drawn, silently, because wrapMode is 'none'.
          upgradeLineFor(m)?.length ?? 0,
        )

      // Compact image indicator (" · Images", 9 chars) appended to the tagline on
      // line 1 so it never occupies its own line. Only NATIVELY multimodal models
      // carry it — text-only ones read an image as a vision-model description
      // substituted server-side, which is a real fallback but not a capability
      // worth advertising as a per-row badge.
      const multimodalSuffixLen = (m: FreebuffModelOption) =>
        m.multimodal ? 9 : 0
      // Same treatment for the " · Reasoning: high" effort suffix.
      const reasoningSuffixLen = (m: FreebuffModelOption) =>
        reasoningSuffixFor(m).length
      // Same treatment for the " · NEW" badge (6 chars).
      const newSuffixLen = 6
      // Ox Alpha reached the CLI on 2026-08-24 as an experimental row. The badge is
      // the only promise we can keep about a model an anonymous host can reprice,
      // rename or withdraw without notice, so it has to survive the width maths the
      // same way NEW does -- an unaccounted suffix truncates the row it labels.
      const testSuffixLen = ' · TEST'.length

      // Line 1, in each mode.
      const columnLabelLen = (m: FreebuffModelOption) =>
        2 /* indicator + space */ +
        maxNameLen +
        NAME_GAP +
        taglineFor(m).length +
        reasoningSuffixLen(m) +
        multimodalSuffixLen(m) +
        (m.isNew ? newSuffixLen : 0) +
        (m.experimental ? testSuffixLen : 0)
      const compactLabelLen = (m: FreebuffModelOption) =>
        2 +
        m.displayName.length +
        3 /* " · " */ +
        taglineFor(m).length +
        reasoningSuffixLen(m) +
        multimodalSuffixLen(m) +
        (m.isNew ? newSuffixLen : 0) +
        (m.experimental ? testSuffixLen : 0)

      // Line 2, or 0 for a row with no details. Centered in the card rather
      // than indented under line 1's details column — the notice is a footnote
      // about the row as a whole, and right-flushing it against the border
      // (which the old indent did on the widest row) read as ragged. Centering
      // means it only needs its own length to fit, so it no longer stretches
      // the card.
      const detailsLineLen = (m: FreebuffModelOption) =>
        rowDetailsText(m).length

      // Cards are exactly as wide as their widest line. Nothing is reserved
      // beyond that — the removed "Press Enter ↵" gutter used to pad every card
      // out to the hero's line plus 17 columns of empty space.
      const innerWidth = (labelLen: (m: FreebuffModelOption) => number) =>
        Math.max(
          ...widthModels.map((m) =>
            Math.max(labelLen(m), detailsLineLen(m), noticeLineLen(m)),
          ),
        )

      const columnInner = innerWidth(columnLabelLen)
      const columnOuter = columnInner + BUTTON_CHROME
      if (columnOuter <= contentMaxWidth) {
        return {
          compactNames: false,
          buttonOuterWidth: columnOuter,
          buttonInnerWidth: columnInner,
          nameColumnWidth: maxNameLen,
        }
      }

      // Narrow: drop the name padding so line 1 reads "name · tagline".
      const compactOuter = Math.min(
        innerWidth(compactLabelLen) + BUTTON_CHROME,
        contentMaxWidth,
      )
      return {
        compactNames: true,
        buttonOuterWidth: compactOuter,
        buttonInnerWidth: compactOuter - BUTTON_CHROME,
        nameColumnWidth: maxNameLen,
      }
    }, [
      availableModels,
      offerModels,
      contentMaxWidth,
      reasoningSuffixFor,
      taglineFor,
      rowDetailsText,
      supersededNoticeFor,
      askLineFor,
    ])

  // A row spends a second line whenever it has details to put there — no longer
  // conditional on the terminal width, since the warning never inlines.
  const rowHasDetailsLine = useCallback(
    (m: FreebuffModelOption) => rowDetails(m).length > 0,
    [rowDetails],
  )

  // Initial model-only height estimate. The content wrapper below reports its
  // actual laid-out height, including wrapped referral copy and responsive
  // action rows; this estimate only avoids a zero-height first frame.
  // Headers add 1 row; sections after the first add 1 row of marginTop; the
  // toggle adds its marginTop + 1.
  const SECTION_GAP = 1
  const TOGGLE_MARGIN = 1
  const estimatedModelHeight = useMemo(() => {
    let y = 0
    const rowHeight = (m: FreebuffModelOption) =>
      2 +
      (rowHasDetailsLine(m) ? 2 : 1) +
      (supersededNoticeFor(m) ? 1 : 0) +
      // The meter's question occupies a real row too. Left out, the first
      // frame after an Enter is one row short and the toggle is clipped —
      // the same failure the plan line caused before it was counted.
      (askLineFor(m) ? 1 : 0) +
      (upgradeLineFor(m) ? 1 : 0)
    if (showStandaloneRecommended) {
      y += rowHeight(recommendedModel)
    }
    renderedSections.forEach((section) => {
      y += SECTION_GAP
      if (section.label) y += 1
      section.models.forEach((m) => {
        y += rowHeight(m)
      })
    })
    // The plan summary contributes real rows like everything else here: left
    // out of the estimate, the first frame's viewport ends exactly one row
    // short per line — the plan line steals the toggle's row and the blocked
    // row is clipped outright, which is precisely the row a blocked user
    // needs.
    if (freebucks) {
      // One line, and it stands in for both branches below rather than adding
      // to them — the meter replaces the windows, it does not join them.
      y += SECTION_GAP + 1
    } else if (planSummary) {
      y += SECTION_GAP + 1
      if (planSummary.blocked) y += 1
    } else if (freeWindows) {
      y += SECTION_GAP + 1
    }
    if (canCollapse) {
      y += TOGGLE_MARGIN
      y += 1
    }
    return y
  }, [
    renderedSections,
    rowHasDetailsLine,
    recommendedModel,
    canCollapse,
    showStandaloneRecommended,
    supersededNoticeFor,
    planSummary,
    freeWindows,
    freebucks,
    askLineFor,
  ])

  // When a referral exists, start at the parent's full allowance until the
  // wrapper reports its intrinsic height. The model estimate remains a lower
  // bound after measurement: expansion and an asynchronously arriving access
  // tier can grow the list before OpenTUI reports the wrapper's new height, and
  // reusing the smaller collapsed measurement would clip the newly added rows.
  const contentHeight = Math.max(
    estimatedModelHeight,
    measuredContentHeight ?? (referral ? maxHeight : 0),
  )

  const needsScroll = contentHeight > maxHeight
  const scrollViewportHeight = Math.max(1, Math.min(contentHeight, maxHeight))
  const scrollRef = useRef<ScrollBoxRenderable | null>(null)

  // Keep the keyboard-focused element inside the viewport as the user
  // Tabs/arrows through a list taller than the available rows. Child ids let
  // OpenTUI use the real post-wrap geometry instead of a second hand-maintained
  // row model. Reset a stale offset when a resize makes everything fit.
  useLayoutEffect(() => {
    const sb = scrollRef.current
    if (!sb) return
    if (!needsScroll) {
      sb.scrollTop = 0
      return
    }
    sb.scrollChildIntoView(focusedId)
    // The final referral action has explanatory/footer content after it. When
    // it is focused, reveal the real bottom of the measured content as well as
    // the button itself so the card does not look cut off.
    if (focusedId === extraTargetIds.at(-1)) {
      sb.scrollTop = Math.max(0, sb.scrollHeight - sb.viewport.height)
    }
  }, [focusedId, contentHeight, needsScroll, extraTargetIds])

  const pick = useCallback(
    (modelId: string) => {
      if (admissionPending.current) return
      if (modelId === committedModelId) return
      // Priced-out rows fall through on purpose: the branches below raise the
      // wall and then open the plans page. Everything else unjoinable stops.
      if (!isPressable(modelId)) return
      // The meter's gates. The first Enter on a row that costs something
      // irreversible ASKS; the second commits. Re-pressing on the row already
      // asking is the confirmation, which is why this compares against
      // `pendingAsk` rather than clearing it unconditionally.
      const intent = rowIntent(modelId)
      if (intent.kind !== 'allow' && pendingAsk !== modelId) {
        setPendingAsk(modelId)
        return
      }
      if (intent.kind === 'paywall') {
        // A wall has no second press that starts a session: the balance
        // cannot cover it and the server would refuse. Enter opens the plans
        // page instead, which is the only action that changes the answer.
        setPendingAsk(null)
        void safeOpen(FREEBUCKS_PLANS_URL)
        return
      }
      setPendingAsk(null)
      // Two Enter events can arrive before React commits the pending state.
      admissionPending.current = true
      setPending(modelId)
      startSession(
        modelId,
        intent.kind === 'confirm'
          ? (intent.walletSpend ?? 'session')
          : undefined,
      ).finally(() => {
        admissionPending.current = false
        setPending(null)
      })
    },
    [committedModelId, isPressable, startSession, rowIntent, pendingAsk],
  )

  const toggleExpanded = useCallback(() => {
    // Expanding is informational: keep Enter bound to the recommendation
    // instead of silently moving focus to a different model. Collapsing
    // returns to the same recommendation.
    setFocusedId(recommendedModel.id)
    setExpanded((prev) => !prev)
  }, [recommendedModel.id])

  // Tab / Shift+Tab and arrow keys move the focus highlight only; Enter or
  // Space commits the focused row (or fires the toggle). Two-step navigation
  // lets the user preview the highlight before committing.
  useKeyboard(
    useCallback(
      (key: KeyEvent) => {
        // The Freebucks intro card is up and its "press any key" belongs to it
        // alone; committing a row on that key charges for a session the user
        // never picked.
        if (keyboardSuspended) return
        if (pending) return
        const name = key.name ?? ''
        const direction = freebuffModelNavigationDirectionForKey(key)
        // Use the shared Enter detector so the keypad Enter and the niche
        // Linux terminals that send \n (linefeed) for Enter also commit; a
        // raw name === 'return' check silently ignores those, which looks
        // like a frozen menu (arrows move the highlight, Enter does nothing).
        const isCommit = isPlainEnterKey(key) || name === 'space'
        if (isCommit) {
          if (focusedId === TOGGLE_ID) {
            key.preventDefault?.()
            key.stopPropagation?.()
            toggleExpanded()
            return
          }
          // A referral-banner button (copy invite link / use GLM) is focused —
          // fire its registered action instead of joining a queue.
          const extraTarget = extraTargets.find((t) => t.id === focusedId)
          if (extraTarget) {
            key.preventDefault?.()
            key.stopPropagation?.()
            extraTarget.activate()
            return
          }
          if (isPressable(focusedId) && focusedId !== committedModelId) {
            key.preventDefault?.()
            key.stopPropagation?.()
            pick(focusedId)
          }
          return
        }
        if (!direction) return
        const targetId = nextFreebuffModelId({
          modelIds: navIds,
          focusedId,
          direction,
        })
        if (targetId) {
          key.preventDefault?.()
          key.stopPropagation?.()
          setFocusedId(targetId)
        }
      },
      [
        keyboardSuspended,
        pending,
        pick,
        toggleExpanded,
        focusedId,
        committedModelId,
        isPressable,
        navIds,
        extraTargets,
      ],
    ),
  )

  const renderModelButton = (
    model: FreebuffModelOption,
    options: { recommended?: boolean } = {},
  ) => {
    // Single visual state: the focused row IS the highlight. The user's
    // saved/committed pick is not shown separately — it just sets where
    // focus lands when the picker opens. Pressing Enter on the focused
    // row commits it.
    const { recommended = false } = options
    const isHovered = hoveredId === model.id
    const isFocused = focusedId === model.id
    const canJoin = isJoinable(model.id)
    // Clickable whenever picking would actually do something — i.e.
    // anything except re-picking the queue we're already in. A priced-out row
    // counts: the click raises the wall and offers the plans page, where
    // before it was silently inert.
    const interactable =
      !pending && isPressable(model.id) && model.id !== committedModelId

    // Focused row: green border + arrow indicator + bold name. The name
    // itself stays the normal foreground color so it doesn't shout — the
    // border and arrow do the highlighting. Off-focus rows are default.
    const indicator = isFocused ? '›' : ' '
    const fgColor = canJoin ? theme.foreground : theme.muted
    const mutedColor = theme.muted
    const warningColor = theme.secondary

    // Focused row gets the bright primary border (and arrow). Every other row —
    // including the collapsed hero when the cursor has moved elsewhere — stays
    // quiet (gray border, brightening only on hover) so it never competes with
    // the user's current selection. Since the ' RECOMMENDED ' border title was
    // removed on 2026-08-21 the hero has no visual distinction of its own,
    // which is the intent: it is where the cursor starts, not a pick we endorse.
    const borderColor = isFocused
      ? theme.primary
      : isHovered
        ? theme.foreground
        : theme.border

    // Line 2 is centered in the card. Spaces render verbatim, so center by
    // hand-padding the left. Clamped at 0 for the narrow mode, where
    // buttonInnerWidth is capped by contentMaxWidth and the line may be wider
    // than the card.
    const details = rowDetails(model)
    const askLine = askLineFor(model)
    const detailsPad = Math.max(
      0,
      Math.floor((buttonInnerWidth - rowDetailsText(model).length) / 2),
    )

    // The ask line gets its OWN centring, from its OWN length. Reusing
    // `detailsPad` centred a 60-character sentence as if it were the 5
    // characters of "20/hr", which started it two-thirds of the way across the
    // card and ran it off the right edge — and `wrapMode: 'none'` clips
    // silently, so the question the row was waiting on simply vanished.
    const askPad = Math.max(
      0,
      Math.floor((buttonInnerWidth - (askLine?.length ?? 0)) / 2),
    )

    const supersededNotice = supersededNoticeFor(model)
    const supersededPad = Math.max(
      0,
      Math.floor((buttonInnerWidth - (supersededNotice?.length ?? 0)) / 2),
    )

    const upgradeLine = upgradeLineFor(model)
    const upgradePad = Math.max(
      0,
      Math.floor((buttonInnerWidth - (upgradeLine?.length ?? 0)) / 2),
    )

    // Spaces inside <span>s render verbatim, so we hand-pad the name to align
    // taglines into a column. nameColumnWidth is the longest name across all
    // rows, so the diff is >= 0; +NAME_GAP guarantees breathing room even on
    // the widest row.
    const namePadding = ' '.repeat(
      nameColumnWidth - model.displayName.length + NAME_GAP,
    )

    // Only natively multimodal models advertise image input. Text-only models
    // still accept a pasted image (it is substituted server-side as a
    // vision-model description), but badging every row "Images" made the label
    // meaningless — and it is what stretched line 1 on rows that can't actually
    // see pixels.
    const imagesSuffix = model.multimodal ? ' · Images' : ''

    const reasoningSuffix = reasoningSuffixFor(model)

    return (
      <Button
        key={model.id}
        id={model.id}
        // NO ' RECOMMENDED ' title as of 2026-08-21. The collapsed view still
        // opens on one card so a new user can start with a single Enter, but
        // that card is a STARTING POSITION rather than an endorsement — the
        // catalog no longer names a recommended model, and ordering is the only
        // steer left. Re-adding a title here re-adds the recommendation.
        titleAlignment={undefined}
        onClick={() => {
          setFocusedId(model.id)
          if (canJoin) pick(model.id)
        }}
        onMouseOver={() => interactable && setHoveredId(model.id)}
        onMouseOut={() =>
          setHoveredId((curr) => (curr === model.id ? null : curr))
        }
        style={{
          borderStyle: 'single',
          borderColor,
          paddingLeft: 1,
          paddingRight: 1,
          width: buttonOuterWidth,
        }}
        border={['top', 'bottom', 'left', 'right']}
      >
        <text>
          <span fg={fgColor}>{indicator} </span>
          <span
            fg={fgColor}
            attributes={isFocused ? TextAttributes.BOLD : TextAttributes.NONE}
          >
            {model.displayName}
          </span>
          {compactNames ? (
            <span fg={mutedColor}>
              {' · ' + taglineFor(model) + reasoningSuffix + imagesSuffix}
            </span>
          ) : (
            <span fg={mutedColor}>
              {namePadding + taglineFor(model) + reasoningSuffix + imagesSuffix}
            </span>
          )}
          {model.isNew && (
            <span fg={theme.primary} attributes={TextAttributes.BOLD}>
              {' · NEW'}
            </span>
          )}
          {/* Warning-coloured rather than primary: NEW is an invitation, TEST
              is a caveat, and a user scanning the picker should be able to tell
              them apart without reading. */}
          {model.experimental && (
            <span fg={warningColor} attributes={TextAttributes.BOLD}>
              {' · TEST'}
            </span>
          )}
        </text>
        {details.length > 0 && (
          <text>
            <span>{' '.repeat(detailsPad)}</span>
            {details.map((detail, index) => (
              <React.Fragment key={`${index}-${detail.text}`}>
                {index > 0 && <span fg={mutedColor}>{DETAIL_SEPARATOR}</span>}
                <span fg={detail.warn ? warningColor : mutedColor}>
                  {detail.text}
                </span>
              </React.Fragment>
            ))}
          </text>
        )}
        {/* The meter's question, BELOW the price it is about, so the row reads
            name -> price -> question. Secondary colour: it is the only line in
            the menu waiting on the reader. */}
        {askLine !== undefined && (
          <text style={{ wrapMode: 'none' }}>
            <span>{' '.repeat(askPad)}</span>
            <span fg={theme.secondary}>{askLine}</span>
          </text>
        )}
        {supersededNotice && (
          <text>
            <span>{' '.repeat(supersededPad)}</span>
            <span fg={mutedColor}>{supersededNotice}</span>
          </text>
        )}
        {upgradeLine && (
          <text style={{ wrapMode: 'none' }}>
            <span>{' '.repeat(upgradePad)}</span>
            {/* The one line on a row drawn in the accent colour. Every other
                detail here is muted or a warning; this is the only one that is
                an OFFER, and it has to be findable while the reader is
                comparing prices rather than after they have chosen. */}
            <span fg={theme.primary}>{upgradeLine}</span>
          </text>
        )}
      </Button>
    )
  }

  // Scarcity, on the LIMITED TRIAL header rather than on the row — same
  // treatment the shared premium quota gets, so counts live in one predictable
  // place and the rows stay narrow. Two facts, in the order they matter: how
  // much of the wave is left for everyone, and (only once the user has spent
  // theirs) when they personally get another. `offers` is homogeneous — one
  // pool, one per-user ceiling — so the first entry speaks for all of them.
  const offerSummary = offers[0]
  const offerUserExhausted = !!offerSummary && offerSummary.userRemaining <= 0
  const offerUserResetAt = offerSummary
    ? new Date(offerSummary.userResetAt)
    : null
  const offerUserResetCountdown =
    offerUserResetAt && Number.isFinite(offerUserResetAt.getTime())
      ? formatFreebuffPremiumResetCountdown(offerUserResetAt, now)
      : null

  const sectionsContent = renderedSections.map((section) => (
    <box
      key={section.key}
      style={{
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 0,
        marginTop: SECTION_GAP,
      }}
    >
      {/* wrapMode 'none' pins headers to one row — the offset math above
          assumes exactly 1 row per header, so a wrap would desync the
          focused-row auto-scroll. */}
      {section.label && (
        <text style={{ fg: theme.muted, wrapMode: 'none' }}>
          {section.label}
          {section.key === 'premium' && premiumLimit !== null && (
            <span fg={premiumExhausted ? theme.secondary : theme.muted}>
              {' '}
              · {formatSessionUnits(premiumUsed)} of {premiumLimit} used
            </span>
          )}
          {section.key === 'premium' && premiumResetCountdown && (
            <span fg={theme.muted}> · resets in {premiumResetCountdown}</span>
          )}
          {section.key === 'offer' && offerSummary && (
            <span fg={theme.primary}>
              {' '}
              · {offerSummary.remaining} of {offerSummary.total} sessions left
            </span>
          )}
          {section.key === 'offer' && offerUserExhausted && (
            <span fg={theme.secondary}>
              {' '}
              · you've used yours
              {offerUserResetCountdown
                ? `, resets in ${offerUserResetCountdown}`
                : ''}
            </span>
          )}
        </text>
      )}
      {section.models.map((m) =>
        renderModelButton(m, { recommended: m.id === recommendedModel.id }),
      )}
    </box>
  ))

  // Expand/collapse affordance. Collapsed: "see all N models" invites the user
  // to browse past the recommended pick. Expanded: a quiet way back to the
  // single-card view.
  const toggleFocused = focusedId === TOGGLE_ID
  const toggleHovered = hoveredId === TOGGLE_ID
  // Same treatment as the referral banner's inline copy control, the other
  // borderless action on this screen: white at rest so it reads as a control
  // rather than body copy, accent green once focused or hovered.
  const toggleColor =
    toggleFocused || toggleHovered ? theme.primary : theme.foreground
  const toggleLabel = expanded
    ? '↑  Show fewer'
    : `↓  See all ${availableModels.length} models`
  const toggleContent = canCollapse ? (
    <Button
      id={TOGGLE_ID}
      onClick={toggleExpanded}
      onMouseOver={() => setHoveredId(TOGGLE_ID)}
      onMouseOut={() =>
        setHoveredId((curr) => (curr === TOGGLE_ID ? null : curr))
      }
      style={{ marginTop: TOGGLE_MARGIN }}
    >
      <text style={{ wrapMode: 'none' }}>
        <span
          fg={toggleColor}
          attributes={toggleFocused ? TextAttributes.BOLD : TextAttributes.NONE}
        >
          {toggleLabel}
        </span>
      </text>
    </Button>
  ) : null

  // Scrollbox clamped to the rows the parent can spare. When everything fits
  // it shrinks to the content height and no scrollbar shows, so tall
  // terminals look exactly like a plain column.
  return (
    <scrollbox
      ref={scrollRef}
      scrollX={false}
      scrollbarOptions={{ visible: false }}
      verticalScrollbarOptions={{
        visible: needsScroll,
        trackOptions: { width: 1 },
      }}
      style={{
        height: scrollViewportHeight,
        // A scrollbox stretches to fill its parent, which would left-align
        // the picker; pin it to the button column width (plus a gutter for
        // the scrollbar) so the landing block stays content-sized and the
        // parent can center it as it did before this was a scrollbox.
        width: buttonOuterWidth + (needsScroll ? 1 : 0),
        flexShrink: 0,
        rootOptions: {
          flexDirection: 'row',
          backgroundColor: 'transparent',
        },
        wrapperOptions: {
          border: false,
          backgroundColor: 'transparent',
          flexDirection: 'column',
        },
        contentOptions: {
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 0,
          backgroundColor: 'transparent',
        },
      }}
    >
      <box
        ref={contentRef}
        onSizeChange={syncContentHeight}
        style={{
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 0,
          width: buttonOuterWidth,
          flexShrink: 0,
        }}
      >
        {showStandaloneRecommended &&
          renderModelButton(recommendedModel, { recommended: true })}
        {sectionsContent}
        {/* On the meter this line REPLACES the session windows below it. Two
            meters for one account is the arrangement that lies outright: the
            windows count sessions that nothing charges any more, while the
            balance quietly drains beside them. */}
        {balanceUnavailable && (
          <text style={{ fg: theme.muted, marginTop: SECTION_GAP }}>
            Freebucks balance temporarily unavailable.
          </text>
        )}
        {freebucks && (
          <text
            style={{
              fg: theme.muted,
              wrapMode: 'none',
              marginTop: SECTION_GAP,
            }}
          >
            {planName.toUpperCase()} · {freebucksHeaderLine(freebucks, now)}
          </text>
        )}
        {freebucks === undefined && freeWindows && !planSummary && (
          <text
            style={{
              fg: theme.muted,
              wrapMode: 'none',
              marginTop: SECTION_GAP,
            }}
          >
            FREE · {formatPlanWindows(freeWindows as never)}
          </text>
        )}
        {freebucks === undefined && planSummary && (
          <text
            style={{
              fg: theme.muted,
              wrapMode: 'none',
              marginTop: SECTION_GAP,
            }}
          >
            {planSummary.tierName.toUpperCase()} PLAN ·{' '}
            {formatPlanWindows(planSummary)}
          </text>
        )}
        {/* The blocking limit gets its own row: appended to the windows line it
            overruns the card width, and wrapMode 'none' clips it silently — the
            one part of the summary a blocked user actually needs was the part
            that vanished. */}
        {freebucks === undefined && planSummary?.blocked && (
          <text style={{ fg: theme.secondary, wrapMode: 'none' }}>
            {planSummary.blocked.label}
            {planSummary.blocked.resetsAt
              ? ` · resets in ${formatFreebuffPremiumResetCountdown(
                  new Date(planSummary.blocked.resetsAt),
                  now,
                  { withDays: true },
                )}`
              : ''}
          </text>
        )}
        {toggleContent}
        {belowToggle}
        {referral && (
          <FreebuffReferralBanner
            width={buttonOuterWidth}
            referral={referral}
            glmPromo={glmPromo}
            accessTier={accessTier}
            metered={freebucks !== undefined}
            focusedId={focusedId}
            onFocusTargetsChange={setExtraTargets}
          />
        )}
      </box>
    </scrollbox>
  )
}
