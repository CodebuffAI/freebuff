import { enableMapSet } from 'immer'
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

import type { FeedbackCategory } from '@codebuff/common/constants/feedback'

import type { AdResponse } from '../hooks/use-gravity-ad'
import type { ChatMessage } from '../types/chat'
import type { ChatTheme } from '../types/theme-system'
import type { MarkdownPalette } from '../utils/markdown-renderer'

// Every store that drafts a Map or Set through immer enables the plugin itself.
// immer's Map/Set support is opt-in and lives on a PROCESS-GLOBAL registry, so
// enabling it from one place far away (this used to happen in init-app) made a
// store correct only once the app had booted: importing it directly threw
// "[Immer] minified error nr: 0", and its tests passed only when some other file
// happened to run first and enable the plugin. Doing it per store makes each one
// correct on its own import, and makes a store that forgets fail the same way
// everywhere instead of only outside the app. enableMapSet() is idempotent.
enableMapSet()

/**
 * Context values that are updated by the Chat component and consumed by
 * message rendering components (MessageWithAgents, AgentMessage, etc).
 */
export interface MessageBlockContext {
  /** Hide actions that submit work while browsing a saved transcript. */
  readOnly: boolean
  /** Active chat theme (colors, etc). */
  theme: ChatTheme | null
  /** Palette for markdown rendering. Null until Chat component initializes it. */
  markdownPalette: MarkdownPalette | null
  /** Message tree mapping parent message ID -> child agent messages. */
  messageTree: Map<string, ChatMessage[]> | null
  /** Whether the main agent is currently waiting for a response. */
  isWaitingForResponse: boolean
  /** Timer start time for the main agent stream, used for UI timers. */
  timerStartTime: number | null
  /** Available width for rendering message content. */
  availableWidth: number
  /**
   * Ads to intersperse inside assistant responses, keyed by message id.
   * Populated by the Chat component from the ads hook; empty when ads are
   * disabled or hidden.
   */
  responseAds: Record<string, AdResponse[]>
}

/**
 * Stable callback functions for message block interactions.
 * These are set by the Chat component and consumed by message blocks.
 */
export interface MessageBlockCallbacks {
  onToggleCollapsed: (id: string) => void
  onBuildFast: () => void
  onBuildMax: () => void
  onBuildLite: () => void
  onFeedback: (
    messageId: string,
    options?: {
      category?: FeedbackCategory
      footerMessage?: string
      errors?: Array<{ id: string; message: string }>
    },
  ) => void
  onCloseFeedback: () => void
  /** Record a click on an interspersed response ad. */
  onAdClick: (ad: AdResponse) => void
  /** Record an impression for an interspersed response ad. */
  onAdImpression: (ad: AdResponse) => void
  /** Ensure the response has fetched ads for every currently eligible slot. */
  onResponseAdsNeeded: (messageId: string, count: number) => void
  /**
   * Sponsored proposals (COD-376). Beside `responseAds` because they share a
   * transcript and nothing else -- a display ad is a link out, a proposal is an
   * offer to do work in this repository, and the two have different controls.
   *
   * Keyed by TARGET (`owner/name`), never by message: a repository has one live
   * offer, and declining it in one place must not leave it standing in another.
   *
   * ACCEPT IS TWO CALLBACKS, not one, and that is the COD-336 consent gate
   * expressed in the type. `onSponsoredProposalAccept` OPENS the consent and
   * writes nothing anywhere; `onSponsoredProposalConsent` carries the user's
   * answer to it, and only `true` starts a run. A single "accept" callback
   * would be a control that runs an advertiser's procedure on one keypress,
   * which is exactly the pattern this channel exists not to be.
   */
  onSponsoredProposalMenu: (target: string, open: boolean) => void
  onSponsoredProposalDisclose: (target: string, open: boolean) => void
  /** Open the consent screen. Starts nothing, writes nothing. */
  onSponsoredProposalAccept: (target: string) => void
  /** The consent's answer. `false` refuses and leaves the row `offered`. */
  onSponsoredProposalConsent: (target: string, approved: boolean) => void
  /** Dismiss, report, never-this-advertiser, or the channel opt-out. */
  onSponsoredProposalControl: (
    target: string,
    control: 'dismiss' | 'report' | 'never-advertiser' | 'opt-out',
  ) => void
}

interface MessageBlockStoreState {
  context: MessageBlockContext
  callbacks: MessageBlockCallbacks
}

interface MessageBlockStoreActions {
  /**
   * Batch update context values. Pass only the values you want to update.
   *
   * This is called from the Chat component whenever any of the dependent
   * values (theme, markdownPalette, messageTree, etc) change.
   */
  setContext: (context: Partial<MessageBlockContext>) => void
  /**
   * Replace all callbacks at once. These are typically stable functions set
   * up once when the Chat component mounts.
   */
  setCallbacks: (callbacks: MessageBlockCallbacks) => void
  /**
   * Reset the store to its initial state. Primarily used by tests.
   */
  reset: () => void
}

type MessageBlockStore = MessageBlockStoreState & MessageBlockStoreActions

const noop = () => {}
const noopFeedback: MessageBlockCallbacks['onFeedback'] = () => {}

const initialContext: MessageBlockContext = {
  readOnly: false,
  theme: null,
  markdownPalette: null,
  messageTree: null,
  isWaitingForResponse: false,
  timerStartTime: null,
  availableWidth: 80,
  responseAds: {},
}

const initialCallbacks: MessageBlockCallbacks = {
  onToggleCollapsed: noop,
  onBuildFast: noop,
  onBuildMax: noop,
  onBuildLite: noop,
  onFeedback: noopFeedback,
  onCloseFeedback: noop,
  onAdClick: noop,
  onAdImpression: noop,
  onResponseAdsNeeded: noop,
  onSponsoredProposalMenu: noop,
  onSponsoredProposalDisclose: noop,
  onSponsoredProposalAccept: noop,
  onSponsoredProposalConsent: noop,
  onSponsoredProposalControl: noop,
}

const initialState: MessageBlockStoreState = {
  context: initialContext,
  callbacks: initialCallbacks,
}

export const useMessageBlockStore = create<MessageBlockStore>()(
  immer((set) => ({
    ...initialState,

    setContext: (updates) =>
      set((state) => {
        state.context = { ...state.context, ...updates }
      }),

    setCallbacks: (callbacks) =>
      set((state) => {
        state.callbacks = callbacks
      }),

    reset: () =>
      set((state) => {
        state.context = { ...initialContext }
        state.callbacks = { ...initialCallbacks }
      }),
  })),
)
